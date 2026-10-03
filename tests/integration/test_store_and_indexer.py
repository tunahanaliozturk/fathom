"""Writing documents, re-embedding only what changed, and the indexer sharing work."""

import asyncio
from collections.abc import Sequence

import asyncpg
import numpy as np
import pytest

from fathom import store
from fathom.embedding import HashingEmbedder, Vectors
from fathom.indexer import Indexer
from tests.integration.conftest import index_all, put

THREE_PARAGRAPHS = "First paragraph about owls.\n\nSecond paragraph about foxes.\n\nThird paragraph about bears."


class CountingEmbedder(HashingEmbedder):
    def __init__(self) -> None:
        super().__init__()
        self.embedded: list[str] = []

    def embed_passages(self, texts: Sequence[str]) -> Vectors:
        self.embedded.extend(texts)
        return super().embed_passages(texts)


class BrokenEmbedder(HashingEmbedder):
    def embed_passages(self, texts: Sequence[str]) -> Vectors:
        raise RuntimeError("model crashed")


@pytest.mark.asyncio(loop_scope="session")
async def test_a_new_document_is_searchable_by_text_at_once_and_waits_for_its_vectors(pool: asyncpg.Pool) -> None:
    written = await put(pool, "docs", "a", THREE_PARAGRAPHS, max_words=5)

    assert (written.chunks, written.reused_embeddings, written.unchanged) == (3, 0, False)
    async with pool.acquire() as conn:
        assert await store.collection_stats(conn, "docs") == {"documents": 1, "chunks": 3, "pending": 3}


@pytest.mark.asyncio(loop_scope="session")
async def test_sending_the_same_document_again_changes_nothing(pool: asyncpg.Pool) -> None:
    await put(pool, "docs", "a", THREE_PARAGRAPHS, max_words=5)
    again = await put(pool, "docs", "a", THREE_PARAGRAPHS, max_words=5)

    assert again.unchanged


@pytest.mark.asyncio(loop_scope="session")
async def test_editing_one_paragraph_re_embeds_only_that_chunk(pool: asyncpg.Pool) -> None:
    embedder = CountingEmbedder()
    await put(pool, "docs", "a", THREE_PARAGRAPHS, max_words=5)
    await index_all(pool, embedder)
    embedder.embedded.clear()

    edited = await put(pool, "docs", "a", THREE_PARAGRAPHS.replace("foxes", "wolves"), max_words=5)
    await index_all(pool, embedder)

    assert (edited.chunks, edited.reused_embeddings) == (3, 2)
    assert embedder.embedded == ["Second paragraph about wolves."]


@pytest.mark.asyncio(loop_scope="session")
async def test_changing_the_title_re_embeds_every_chunk_because_the_title_is_part_of_the_passage(
    pool: asyncpg.Pool, embedder: HashingEmbedder
) -> None:
    await put(pool, "docs", "a", THREE_PARAGRAPHS, title="Animals", max_words=5)
    await index_all(pool, embedder)

    retitled = await put(pool, "docs", "a", THREE_PARAGRAPHS, title="Wildlife", max_words=5)

    assert retitled.reused_embeddings == 0


@pytest.mark.asyncio(loop_scope="session")
async def test_writers_of_the_same_document_take_turns_instead_of_colliding(pool: asyncpg.Pool) -> None:
    versions = [f"Version {i} of the text." for i in range(8)]

    await asyncio.gather(*(put(pool, "docs", "contested", v) for v in versions))

    async with pool.acquire() as conn:
        rows = await conn.fetch("select text from fathom_chunks where document_id = 'contested'")
    assert len(rows) == 1, "one writer's chunks, not a mix"
    assert rows[0]["text"] in versions


@pytest.mark.asyncio(loop_scope="session")
async def test_deleting_a_document_deletes_its_chunks(pool: asyncpg.Pool) -> None:
    await put(pool, "docs", "a", THREE_PARAGRAPHS, max_words=5)
    async with pool.acquire() as conn:
        assert await store.delete_document(conn, "docs", "a")
        assert not await store.delete_document(conn, "docs", "a")
        assert await conn.fetchval("select count(*) from fathom_chunks") == 0


@pytest.mark.asyncio(loop_scope="session")
async def test_two_indexers_share_the_backlog_and_embed_each_chunk_once(pool: asyncpg.Pool) -> None:
    for i in range(30):
        await put(pool, "docs", f"d{i}", f"Document number {i}. It has one more sentence.")
    first, second = CountingEmbedder(), CountingEmbedder()

    await asyncio.gather(Indexer(pool, first, batch=4).drain(), Indexer(pool, second, batch=4).drain())

    assert len(first.embedded) + len(second.embedded) == 30
    assert not set(first.embedded) & set(second.embedded)
    async with pool.acquire() as conn:
        assert await store.pending_count(conn) == 0


@pytest.mark.asyncio(loop_scope="session")
async def test_a_batch_whose_embedding_fails_stays_pending_for_the_next_attempt(
    pool: asyncpg.Pool, embedder: HashingEmbedder
) -> None:
    await put(pool, "docs", "a", THREE_PARAGRAPHS, max_words=5)

    with pytest.raises(RuntimeError, match="model crashed"):
        await Indexer(pool, BrokenEmbedder()).run_once()

    async with pool.acquire() as conn:
        assert await store.pending_count(conn) == 3
    assert await index_all(pool, embedder) == 3


@pytest.mark.asyncio(loop_scope="session")
async def test_stored_vectors_are_the_embedder_output(pool: asyncpg.Pool, embedder: HashingEmbedder) -> None:
    await put(pool, "docs", "a", "Just one sentence here.", title="T")
    await index_all(pool, embedder)

    async with pool.acquire() as conn:
        stored = await conn.fetchval("select embedding from fathom_chunks")
    expected = embedder.embed_passages([store.passage("T", "Just one sentence here.")])[0]
    assert np.allclose(stored.to_numpy(), expected, atol=1e-6)


def test_a_model_with_the_wrong_width_is_refused() -> None:
    with pytest.raises(ValueError, match="384"):
        Indexer(None, HashingEmbedder(dimensions=768))


class SlowEmbedder(HashingEmbedder):
    def embed_passages(self, texts: Sequence[str]) -> Vectors:
        import time  # noqa: PLC0415

        time.sleep(1.5)  # runs in a worker thread, like the real model
        return super().embed_passages(texts)


@pytest.mark.asyncio(loop_scope="session")
async def test_editing_a_document_with_two_identical_paragraphs_works(
    pool: asyncpg.Pool, embedder: HashingEmbedder
) -> None:
    text = "Same paragraph here.\n\nSame paragraph here.\n\nThe tail."
    await put(pool, "docs", "dup", text, max_words=3)
    await index_all(pool, embedder)

    edited = await put(pool, "docs", "dup", text.replace("tail", "end"), max_words=3)

    assert (edited.chunks, edited.reused_embeddings) == (3, 2)


@pytest.mark.asyncio(loop_scope="session")
async def test_a_write_does_not_wait_for_the_model(pool: asyncpg.Pool) -> None:
    await put(pool, "docs", "a", "Original words.")
    indexing = asyncio.create_task(Indexer(pool, SlowEmbedder()).run_once())
    await asyncio.sleep(0.3)  # the indexer holds the chunk now, and is inside the model

    started = asyncio.get_running_loop().time()
    await put(pool, "docs", "a", "Replaced words.")
    waited = asyncio.get_running_loop().time() - started
    await indexing

    assert waited < 0.5, f"the write waited {waited:.2f}s for the model"
    async with pool.acquire() as conn:
        rows = await conn.fetch("select text, embedding is not null as embedded from fathom_chunks")
    assert [(r["text"], r["embedded"]) for r in rows] == [("Replaced words.", False)], "no stale vector stored"


@pytest.mark.asyncio(loop_scope="session")
async def test_resending_after_a_chunking_change_rechunks(pool: asyncpg.Pool) -> None:
    await put(pool, "docs", "a", THREE_PARAGRAPHS, max_words=180)
    rechunked = await put(pool, "docs", "a", THREE_PARAGRAPHS, max_words=5)

    assert not rechunked.unchanged
    assert rechunked.chunks == 3


@pytest.mark.asyncio(loop_scope="session")
async def test_an_unchanged_write_reports_only_the_vectors_that_exist(pool: asyncpg.Pool) -> None:
    await put(pool, "docs", "a", THREE_PARAGRAPHS, max_words=5)
    again = await put(pool, "docs", "a", THREE_PARAGRAPHS, max_words=5)

    assert (again.unchanged, again.reused_embeddings) == (True, 0)

"""Retrieval against Postgres. The hashing embedder is a crude lexical model, so these tests check mechanics (which
retriever finds what, fusion, filters, collapsing), not relevance; relevance is the evaluation's job."""

import asyncpg
import pytest

from fathom.embedding import HashingEmbedder
from fathom.search import SearchOptions, search
from tests.integration.conftest import index_all, put


async def corpus(pool: asyncpg.Pool, embedder: HashingEmbedder) -> None:
    await put(
        pool, "kb", "eiffel", "The Eiffel Tower was designed by the engineer Gustave Eiffel.", metadata={"lang": "en"}
    )
    await put(pool, "kb", "louvre", "The Louvre is the world's most visited museum.", metadata={"lang": "en"})
    await put(pool, "kb", "tour", "La tour Eiffel est une tour de fer puddlé.", metadata={"lang": "fr"})
    await put(pool, "other", "eiffel", "Eiffel tower in another collection.")
    await index_all(pool, embedder)


async def ids(pool: asyncpg.Pool, embedder: HashingEmbedder, query: str, **options: object) -> list[str]:
    opts = SearchOptions(**options)  # type: ignore[arg-type]
    vector = None if opts.mode == "lexical" else embedder.embed_query(query)
    return [h.document_id for h in await search(pool, "kb", query, vector, opts)]


@pytest.mark.asyncio(loop_scope="session")
async def test_lexical_search_matches_any_stemmed_word_not_all_of_them(
    pool: asyncpg.Pool, embedder: HashingEmbedder
) -> None:
    await corpus(pool, embedder)

    found = await ids(pool, embedder, "who designed the famous tower", mode="lexical")

    assert found[0] == "eiffel", "'designed' and 'tower' match after stemming; 'who' and 'famous' do not exist"


@pytest.mark.asyncio(loop_scope="session")
async def test_each_collection_only_sees_its_own_documents(pool: asyncpg.Pool, embedder: HashingEmbedder) -> None:
    await corpus(pool, embedder)

    for mode in ("lexical", "vector", "hybrid"):
        assert "other" not in await ids(pool, embedder, "eiffel tower", mode=mode)
        hits = await search(pool, "other", "eiffel", embedder.embed_query("eiffel"), SearchOptions())
        assert [h.document_id for h in hits] == ["eiffel"]


@pytest.mark.asyncio(loop_scope="session")
async def test_a_metadata_filter_applies_to_both_retrievers(pool: asyncpg.Pool, embedder: HashingEmbedder) -> None:
    await corpus(pool, embedder)

    for mode in ("lexical", "vector", "hybrid"):
        assert await ids(pool, embedder, "eiffel tour tower", mode=mode, filter={"lang": "fr"}) == ["tour"]


@pytest.mark.asyncio(loop_scope="session")
async def test_hybrid_explains_where_each_hit_came_from(pool: asyncpg.Pool, embedder: HashingEmbedder) -> None:
    await corpus(pool, embedder)

    hits = await search(pool, "kb", "Eiffel", embedder.embed_query("Eiffel"), SearchOptions(k=3))

    top = hits[0]
    assert top.document_id in {"eiffel", "tour"}
    assert set(top.ranks) == {"lexical", "vector"}
    assert "«Eiffel»" in top.snippet


@pytest.mark.asyncio(loop_scope="session")
async def test_a_long_document_appears_once_with_its_best_chunk(pool: asyncpg.Pool, embedder: HashingEmbedder) -> None:
    text = " ".join(f"Sentence {i} mentions lighthouses." for i in range(40))
    await put(pool, "kb", "long", text, max_words=20)
    await put(pool, "kb", "short", "A note on lighthouses.")
    await index_all(pool, embedder)

    collapsed = await ids(pool, embedder, "lighthouses", mode="lexical")
    every_chunk = await ids(pool, embedder, "lighthouses", mode="lexical", collapse=False)

    assert sorted(collapsed) == ["long", "short"]
    assert every_chunk.count("long") > 1


@pytest.mark.asyncio(loop_scope="session")
async def test_a_query_of_stop_words_or_punctuation_finds_nothing_lexically_without_an_error(
    pool: asyncpg.Pool, embedder: HashingEmbedder
) -> None:
    await corpus(pool, embedder)

    assert await ids(pool, embedder, "the of and", mode="lexical") == []
    assert await ids(pool, embedder, "?!", mode="lexical") == []


@pytest.mark.asyncio(loop_scope="session")
async def test_unembedded_chunks_are_found_by_text_and_skipped_by_vectors(
    pool: asyncpg.Pool, embedder: HashingEmbedder
) -> None:
    await put(pool, "kb", "fresh", "Brand new text about zeppelins.")

    assert await ids(pool, embedder, "zeppelins", mode="lexical") == ["fresh"]
    assert await ids(pool, embedder, "zeppelins", mode="vector") == []
    assert await ids(pool, embedder, "zeppelins", mode="hybrid") == ["fresh"]


@pytest.mark.asyncio(loop_scope="session")
async def test_vector_and_hybrid_search_need_a_query_vector(pool: asyncpg.Pool) -> None:
    with pytest.raises(ValueError, match="query embedding"):
        await search(pool, "kb", "anything", None, SearchOptions(mode="vector"))

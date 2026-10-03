from collections.abc import AsyncIterator, Iterator
from typing import Any

import asyncpg
import pytest
import pytest_asyncio
from testcontainers.community.postgres import PostgresContainer

from fathom import store
from fathom.chunking import chunk
from fathom.embedding import HashingEmbedder
from fathom.indexer import Indexer
from fathom.migrate import migrate

IMAGE = "pgvector/pgvector:0.8.1-pg18"


@pytest.fixture(scope="session")
def dsn() -> Iterator[str]:
    with PostgresContainer(IMAGE, driver=None) as container:
        yield container.get_connection_url()


@pytest_asyncio.fixture(scope="session", loop_scope="session")
async def pool(dsn: str) -> AsyncIterator[asyncpg.Pool]:
    conn = await asyncpg.connect(dsn)
    try:
        await migrate(conn)
    finally:
        await conn.close()
    created = await store.create_pool(dsn, max_size=20)
    yield created
    await created.close()


@pytest_asyncio.fixture(loop_scope="session", autouse=True)
async def clean(pool: asyncpg.Pool) -> None:
    async with pool.acquire() as conn:
        await conn.execute("truncate fathom_documents, fathom_chunks, fathom_api_keys")


@pytest.fixture
def embedder() -> HashingEmbedder:
    return HashingEmbedder()


async def put(
    pool: asyncpg.Pool,
    collection: str,
    document_id: str,
    text: str,
    *,
    title: str = "",
    metadata: dict[str, Any] | None = None,
    max_words: int = 180,
) -> store.Upserted:
    async with pool.acquire() as conn, conn.transaction():
        return await store.upsert_document(
            conn,
            collection=collection,
            document_id=document_id,
            title=title,
            text=text,
            metadata=metadata or {},
            chunks=chunk(text, max_words=max_words),
        )


async def index_all(pool: asyncpg.Pool, embedder: HashingEmbedder) -> int:
    return await Indexer(pool, embedder).drain()

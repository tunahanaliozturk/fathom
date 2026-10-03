"""Documents, chunks and embeddings in Postgres. Every statement is parameterised."""

import hashlib
import json
from collections.abc import AsyncIterator, Callable, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

import asyncpg
from pgvector.asyncpg import register_vector

from fathom.chunking import Chunk
from fathom.embedding import Vectors

PENDING_CHANNEL = "fathom_pending"


async def _init_connection(conn: asyncpg.Connection) -> None:
    await conn.set_type_codec("jsonb", encoder=json.dumps, decoder=json.loads, schema="pg_catalog")
    await register_vector(conn)


async def _keep_session(_: asyncpg.Connection) -> None:
    """Skip asyncpg's reset query on release. Nothing here leaves session state on a pooled connection: settings are
    changed with ``set_config(..., true)``, which ends with the transaction."""


async def create_pool(dsn: str, *, min_size: int = 2, max_size: int = 10) -> asyncpg.Pool:
    return await asyncpg.create_pool(
        dsn, min_size=min_size, max_size=max_size, init=_init_connection, reset=_keep_session
    )


def embedding_key(title: str, text: str) -> str:
    """What decides whether a chunk needs a new vector: its own text and the title it is embedded with."""
    return hashlib.sha256(f"{title}\x00{text}".encode()).hexdigest()


def passage(title: str, text: str) -> str:
    """The exact string that is embedded for a chunk."""
    return f"{title}\n{text}" if title else text


def document_hash(title: str, text: str, metadata: dict[str, Any], chunks: Sequence[Chunk]) -> str:
    """Covers how the text was chunked too, so re-sending a document after a chunking change is not a no-op."""
    pieces = [c.content_hash for c in chunks]
    canonical = json.dumps({"t": title, "x": text, "m": metadata, "c": pieces}, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()


@dataclass(frozen=True)
class Upserted:
    chunks: int
    reused_embeddings: int
    unchanged: bool


@dataclass(frozen=True)
class DocumentStatus:
    collection: str
    id: str
    title: str
    metadata: dict[str, Any]
    chunks: int
    embedded: int


@dataclass(frozen=True)
class PendingChunk:
    id: int
    title: str
    text: str


async def upsert_document(
    conn: asyncpg.Connection,
    *,
    collection: str,
    document_id: str,
    title: str,
    text: str,
    metadata: dict[str, Any],
    chunks: Sequence[Chunk],
) -> Upserted:
    """Store a document and replace its chunks, keeping the vector of every chunk whose text did not change.

    Sending the same document twice is a no-op. Must run inside a transaction; the document row's lock serialises
    concurrent writers of the same document.
    """
    digest = document_hash(title, text, metadata, chunks)
    # FOR UPDATE reads the latest committed version, waiting for a concurrent writer of the same document if need be.
    # Reading the old hash any other way (a subquery in RETURNING, say) can see a stale one and skip a real change.
    previous = await conn.fetchval(
        "select content_hash from fathom_documents where collection = $1 and id = $2 for update",
        collection,
        document_id,
    )
    if previous == digest:
        counts = await conn.fetchrow(
            "select count(*) as chunks, count(embedding) as embedded from fathom_chunks"
            " where collection = $1 and document_id = $2",
            collection,
            document_id,
        )
        return Upserted(chunks=counts["chunks"], reused_embeddings=counts["embedded"], unchanged=True)

    await conn.execute(
        "insert into fathom_documents (collection, id, title, metadata, content_hash) values ($1, $2, $3, $4, $5)"
        " on conflict (collection, id) do update set title = excluded.title, metadata = excluded.metadata,"
        " content_hash = excluded.content_hash, updated_at = now()",
        collection,
        document_id,
        title,
        metadata,
        digest,
    )
    rows = await conn.fetch(
        "with old as ("
        "  delete from fathom_chunks where collection = $1 and document_id = $2"
        "  returning content_hash, embedding"
        ") "
        "insert into fathom_chunks (collection, document_id, ordinal, title, text, content_hash, metadata, embedding) "
        "select $1, $2, f.ordinal, $3, f.text, f.content_hash, $4,"
        "  (select o.embedding from old o where o.content_hash = f.content_hash and o.embedding is not null limit 1) "
        "from unnest($5::int[], $6::text[], $7::text[]) as f(ordinal, text, content_hash) "
        "returning embedding is not null as reused",
        collection,
        document_id,
        title,
        metadata,
        [c.ordinal for c in chunks],
        [c.text for c in chunks],
        [embedding_key(title, c.text) for c in chunks],
    )
    reused = sum(1 for r in rows if r["reused"])
    if reused < len(rows):
        await conn.execute("select pg_notify($1, '')", PENDING_CHANNEL)
    return Upserted(chunks=len(rows), reused_embeddings=reused, unchanged=False)


async def delete_document(conn: asyncpg.Connection, collection: str, document_id: str) -> bool:
    deleted = await conn.fetchval(
        "delete from fathom_documents where collection = $1 and id = $2 returning 1", collection, document_id
    )
    return deleted is not None


async def document_status(conn: asyncpg.Connection, collection: str, document_id: str) -> DocumentStatus | None:
    row = await conn.fetchrow(
        "select d.title, d.metadata,"
        " (select count(*) from fathom_chunks c where c.collection = d.collection and c.document_id = d.id) as chunks,"
        " (select count(*) from fathom_chunks c where c.collection = d.collection and c.document_id = d.id"
        "   and c.embedding is not null) as embedded"
        " from fathom_documents d where d.collection = $1 and d.id = $2",
        collection,
        document_id,
    )
    if row is None:
        return None
    return DocumentStatus(collection, document_id, row["title"], row["metadata"], row["chunks"], row["embedded"])


async def collection_stats(conn: asyncpg.Connection, collection: str) -> dict[str, int]:
    row = await conn.fetchrow(
        "select (select count(*) from fathom_documents where collection = $1) as documents,"
        " count(*) as chunks, count(*) filter (where embedding is null) as pending"
        " from fathom_chunks where collection = $1",
        collection,
    )
    return dict(row)


async def claim_pending(conn: asyncpg.Connection, limit: int, lease: timedelta) -> list[PendingChunk]:
    """Lease up to ``limit`` chunks waiting for a vector. Nothing stays locked: other indexers skip a leased chunk until
    its lease runs out, and a writer can replace the chunk meanwhile without waiting for the model."""
    rows = await conn.fetch(
        "update fathom_chunks set claimed_until = now() + $2::interval where id in ("
        "  select id from fathom_chunks where embedding is null and (claimed_until is null or claimed_until < now())"
        "  order by id limit $1 for update skip locked"
        ") returning id, title, text",
        limit,
        lease,
    )
    return sorted((PendingChunk(r["id"], r["title"], r["text"]) for r in rows), key=lambda c: c.id)


async def write_embeddings(conn: asyncpg.Connection, chunks: Sequence[PendingChunk], vectors: Vectors) -> int:
    """Store vectors for chunks that still exist and still need one. A chunk replaced while the model ran has a new
    id and its old row is gone, so its vector is simply dropped. Returns how many were stored."""
    stored = 0
    for chunk_, vector in zip(chunks, vectors, strict=True):
        done = await conn.fetchval(
            "update fathom_chunks set embedding = $2, claimed_until = null"
            " where id = $1 and embedding is null returning 1",
            chunk_.id,
            vector,
        )
        stored += done is not None
    return stored


async def release(conn: asyncpg.Connection, chunks: Sequence[PendingChunk]) -> None:
    """Give leased chunks back at once, after a failed batch, instead of making them wait out the lease."""
    await conn.execute(
        "update fathom_chunks set claimed_until = null where id = any($1::bigint[])", [c.id for c in chunks]
    )


async def pending_count(conn: asyncpg.Connection) -> int:
    count: int = await conn.fetchval("select count(*) from fathom_chunks where embedding is null")
    return count


@asynccontextmanager
async def listen(pool: asyncpg.Pool, on_pending: Callable[[], None]) -> AsyncIterator[None]:
    async with pool.acquire() as conn:

        def callback(*_: Any) -> None:
            on_pending()

        await conn.add_listener(PENDING_CHANNEL, callback)
        try:
            yield
        finally:
            await conn.remove_listener(PENDING_CHANNEL, callback)

"""Gives every chunk a vector. Runs as its own process (``fathom indexer``), as many as the CPU budget allows.

Writing a document never waits for the model: chunks are stored with no vector and are searchable by text straight
away. Indexers lease them in batches, embed with no transaction open and off the event loop, and write the vectors
back. A crashed indexer's lease runs out and its batch is claimed again; a failed batch is given back at once.
"""

import asyncio
import time
from datetime import timedelta

import asyncpg
import structlog

from fathom import store, telemetry
from fathom.embedding import DIMENSIONS, Embedder

log = structlog.get_logger()


class Indexer:
    def __init__(
        self,
        pool: asyncpg.Pool,
        embedder: Embedder,
        *,
        batch: int = 64,
        idle_wait: float = 5.0,
        lease: timedelta = timedelta(minutes=5),
    ) -> None:
        if embedder.dimensions != DIMENSIONS:
            raise ValueError(
                f"{embedder.name} makes {embedder.dimensions}-dimensional vectors; the schema has {DIMENSIONS}"
            )
        self._pool = pool
        self._embedder = embedder
        self._batch = batch
        self._idle_wait = idle_wait
        self._lease = lease
        self._pending = asyncio.Event()

    async def run_once(self) -> int:
        """Embed one batch. Returns how many chunks it claimed; 0 means nothing was waiting.

        No transaction and no lock is held while the model runs: the batch is leased in one short statement, embedded,
        and written back in another. Writers are never kept waiting by the model.
        """
        async with self._pool.acquire() as conn:
            chunks = await store.claim_pending(conn, self._batch, self._lease)
        if not chunks:
            return 0
        started = time.perf_counter()
        try:
            vectors = await asyncio.to_thread(
                self._embedder.embed_passages, [store.passage(c.title, c.text) for c in chunks]
            )
        except BaseException:
            async with self._pool.acquire() as conn:
                await store.release(conn, chunks)
            raise
        async with self._pool.acquire() as conn, conn.transaction():
            await store.write_embeddings(conn, chunks, vectors)
        elapsed = time.perf_counter() - started
        telemetry.chunks_embedded.add(len(chunks))
        telemetry.embed_batch_duration.record(elapsed)
        log.debug("embedded", chunks=len(chunks), seconds=round(elapsed, 3))
        return len(chunks)

    async def drain(self) -> int:
        """Embed until nothing is pending. For tests, the evaluation, and one-off backfills."""
        total = 0
        while done := await self.run_once():
            total += done
        return total

    async def run(self, stop: asyncio.Event) -> None:
        log.info("indexer started", model=self._embedder.name, batch=self._batch)
        async with store.listen(self._pool, self._pending.set):
            while not stop.is_set():
                self._pending.clear()  # before looking, so a NOTIFY that lands during the look still wakes us
                try:
                    done = await self.run_once()
                except (asyncpg.PostgresError, asyncpg.InterfaceError, OSError) as exc:
                    log.error("indexing batch failed; it will be claimed again", error=f"{type(exc).__name__}: {exc}")
                    done = 0
                if done:
                    continue
                waiters = {asyncio.ensure_future(self._pending.wait()), asyncio.ensure_future(stop.wait())}
                await asyncio.wait(waiters, timeout=self._idle_wait, return_when=asyncio.FIRST_COMPLETED)
                for waiter in waiters:
                    waiter.cancel()
        log.info("indexer stopped")

"""Search throughput and latency under concurrent load, per mode, against an evaluation collection.

Run the evaluation first (it builds the collection), then:

    uv run python -m benchmarks.search_load --dsn postgresql://postgres:postgres@127.0.0.1:55435/fathom --profile full

Query vectors are computed up front, so this measures the database side of search (two retrievers, fusion, snippets),
not the model. The model's cost per query is reported separately.
"""

import argparse
import asyncio
import os
import platform
import statistics
import time
from dataclasses import dataclass
from pathlib import Path

from fathom import evaluation
from fathom.embedding import FastEmbedder
from fathom.search import Mode, SearchOptions, search
from fathom.store import create_pool


@dataclass(frozen=True)
class _Run:
    options: SearchOptions
    latencies: list[float]
    deadline: float


def pct(values: list[float], p: float) -> float:
    return values[min(len(values) - 1, round(p / 100 * (len(values) - 1)))]


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dsn", required=True)
    parser.add_argument("--profile", default="full")
    parser.add_argument("--concurrency", type=int, default=16)
    parser.add_argument("--seconds", type=float, default=15)
    args = parser.parse_args()

    _, questions = evaluation.build(evaluation.PROFILES[args.profile], Path.home() / ".cache" / "fathom")
    embedder = FastEmbedder()
    started = time.perf_counter()
    vectors = embedder.embed_queries([q.text for q in questions])
    per_query_model_ms = (time.perf_counter() - started) / len(questions) * 1000
    single = []
    for q in questions[:50]:
        t = time.perf_counter()
        embedder.embed_query(q.text)
        single.append((time.perf_counter() - t) * 1000)

    pool = await create_pool(args.dsn, max_size=args.concurrency * 2 + 2)
    collection = f"eval-{args.profile}"
    rows = []
    try:
        async with pool.acquire() as conn:
            chunks = await conn.fetchval("select count(*) from fathom_chunks where collection = $1", collection)
        modes: tuple[Mode, ...] = ("lexical", "vector", "hybrid")
        for mode in modes:
            options = SearchOptions(mode=mode)
            latencies: list[float] = []
            deadline = time.perf_counter() + args.seconds

            async def client(offset: int, run: _Run) -> None:
                i = offset
                while time.perf_counter() < run.deadline:
                    q, v = questions[i % len(questions)], vectors[i % len(questions)]
                    t = time.perf_counter()
                    await search(pool, collection, q.text, v, run.options)
                    run.latencies.append((time.perf_counter() - t) * 1000)
                    i += args.concurrency

            run = _Run(options, latencies, deadline)
            began = time.perf_counter()
            await asyncio.gather(*(client(n, run) for n in range(args.concurrency)))
            elapsed = time.perf_counter() - began
            latencies.sort()
            rows.append(
                f"| {mode} | {len(latencies) / elapsed:,.0f} | {statistics.median(latencies):.1f}"
                f" | {pct(latencies, 95):.1f} | {pct(latencies, 99):.1f} |"
            )
    finally:
        await pool.close()

    print(f"{platform.platform()}, Python {platform.python_version()}, {os.cpu_count()} logical CPUs")
    print(
        f"collection {collection}: {chunks} chunks;"
        f" {args.concurrency} concurrent clients for {args.seconds:.0f} s each\n"
    )
    print("| mode | searches/s | p50 ms | p95 ms | p99 ms |")
    print("|---|---|---|---|---|")
    print("\n".join(rows))
    print(
        f"\nquery embedding: {statistics.median(single):.1f} ms median for one query alone,"
        f" {per_query_model_ms:.1f} ms per query in a batch"
    )


if __name__ == "__main__":
    asyncio.run(main())

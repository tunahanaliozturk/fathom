"""Measuring relevance, so that a change to ranking is a number and not an opinion.

The dataset is SQuAD 1.1 (Rajpurkar et al., 2016, CC BY-SA 4.0), used as a retrieval task: every question has exactly
one paragraph that answers it, and the system has to find that paragraph among all the others. It is downloaded on
first use and checked against a pinned SHA-256; it is never committed to this repository.

Two profiles:

- ``ci``: 400 questions against the 2,067 paragraphs of the development set. A few minutes on a CI runner, most of
  it embedding the paragraphs. ``eval/baseline.json`` holds its expected scores; CI fails if nDCG@10 drops further
  than the tolerance.
- ``full``: 2,000 questions against those paragraphs plus 8,000 from the training set as distractors.

The documents go in through the same code the API uses (chunking, upsert, the indexer) and the questions through the
same search; nothing is special-cased for the benchmark.
"""

import asyncio
import hashlib
import json
import random
import statistics
import time
import urllib.request
from dataclasses import asdict, dataclass, field, replace
from pathlib import Path
from typing import Any

import asyncpg
import numpy as np
import structlog

from fathom import store
from fathom.chunking import chunk
from fathom.embedding import Embedder
from fathom.indexer import Indexer
from fathom.metrics import ndcg_at_k, recall_at_k, reciprocal_rank_at_k
from fathom.search import Mode, SearchOptions, search

log = structlog.get_logger()

_SQUAD = "https://rajpurkar.github.io/SQuAD-explorer/dataset/"
_FILES = {
    "dev-v1.1.json": "95aa6a52d5d6a735563366753ca50492a658031da74f301ac5238b03966972c9",
    "train-v1.1.json": "3527663986b8295af4f7fcdff1ba1ff3f72d07d61a20f487cb238a6ef92fd955",
}
MODES: tuple[Mode, ...] = ("lexical", "vector", "hybrid")


@dataclass(frozen=True)
class Profile:
    name: str
    queries: int
    distractors: int
    seed: int = 20261003


PROFILES = {"ci": Profile("ci", queries=400, distractors=0), "full": Profile("full", queries=2000, distractors=8000)}


@dataclass(frozen=True)
class Passage:
    id: str
    title: str
    text: str


@dataclass(frozen=True)
class Question:
    text: str
    answer_passage: str


@dataclass
class ModeScores:
    ndcg_at_10: float
    recall_at_10: float
    recall_at_50: float
    mrr_at_10: float
    p50_ms: float
    p95_ms: float


@dataclass
class Report:
    profile: str
    model: str
    passages: int
    questions: int
    options: dict[str, Any]
    modes: dict[str, ModeScores] = field(default_factory=dict)


def fetch(name: str, cache: Path) -> Path:
    """Download a dataset file once, and refuse it if it is not byte-for-byte the file the baseline was built on."""
    path = cache / name
    if not path.exists():
        cache.mkdir(parents=True, exist_ok=True)
        partial = path.with_suffix(".part")
        urllib.request.urlretrieve(_SQUAD + name, partial)  # noqa: S310  # a constant https URL
        partial.replace(path)
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != _FILES[name]:
        raise ValueError(f"{path} has SHA-256 {digest}, expected {_FILES[name]}; delete it and run again")
    return path


def _paragraphs(path: Path, prefix: str) -> list[tuple[Passage, list[str]]]:
    data = json.loads(path.read_text(encoding="utf-8"))["data"]
    found = []
    for a, article in enumerate(data):
        title = article["title"].replace("_", " ")
        for p, paragraph in enumerate(article["paragraphs"]):
            questions = [qa["question"].strip() for qa in paragraph["qas"]]
            found.append((Passage(f"{prefix}-{a}-{p}", title, paragraph["context"]), questions))
    return found


def build(profile: Profile, cache: Path) -> tuple[list[Passage], list[Question]]:
    """The corpus and the questions for a profile. Deterministic: same seed, same sample, every time."""
    rng = random.Random(profile.seed)  # noqa: S311  # sampling, not security
    dev = _paragraphs(fetch("dev-v1.1.json", cache), "dev")
    passages = [p for p, _ in dev]
    candidates = [Question(q, p.id) for p, qs in dev for q in qs]
    questions = rng.sample(candidates, profile.queries)
    if profile.distractors:
        train = [p for p, _ in _paragraphs(fetch("train-v1.1.json", cache), "train")]
        passages += rng.sample(train, profile.distractors)
    return passages, questions


@dataclass(frozen=True)
class Chunking:
    max_words: int = 180
    overlap_sentences: int = 1


async def index(
    pool: asyncpg.Pool, collection: str, passages: list[Passage], embedder: Embedder, chunking: Chunking
) -> None:
    """Put the corpus in through the normal write path, then embed it all."""
    async with pool.acquire() as conn:
        await conn.execute("delete from fathom_documents where collection = $1", collection)
    batch = 200
    for first in range(0, len(passages), batch):
        async with pool.acquire() as conn, conn.transaction():
            for passage in passages[first : first + batch]:
                await store.upsert_document(
                    conn,
                    collection=collection,
                    document_id=passage.id,
                    title=passage.title,
                    text=passage.text,
                    metadata={},
                    chunks=chunk(
                        passage.text,
                        max_words=chunking.max_words,
                        overlap_sentences=chunking.overlap_sentences,
                    ),
                )
    started = time.perf_counter()
    embedded = await Indexer(pool, embedder, batch=128).drain()
    elapsed = time.perf_counter() - started
    log.info("indexed", passages=len(passages), chunks=embedded, seconds=round(elapsed, 1))


async def score(
    pool: asyncpg.Pool,
    *,
    collection: str,
    questions: list[Question],
    embedder: Embedder,
    options: SearchOptions,
    mode: Mode,
    concurrency: int = 8,
) -> ModeScores:
    vectors = await asyncio.to_thread(embedder.embed_queries, [q.text for q in questions])
    gate = asyncio.Semaphore(concurrency)
    per_mode = replace(options, mode=mode, k=50)

    async def one(question: Question, vector: np.ndarray[Any, Any]) -> tuple[list[str], float]:
        async with gate:
            started = time.perf_counter()
            hits = await search(pool, collection, question.text, vector, per_mode)
            return [h.document_id for h in hits], (time.perf_counter() - started) * 1000

    results = await asyncio.gather(*(one(q, v) for q, v in zip(questions, vectors, strict=True)))
    ndcg, recall10, recall50, mrr = [], [], [], []
    for question, (ranking, _) in zip(questions, results, strict=True):
        relevant = {question.answer_passage: 1.0}
        ndcg.append(ndcg_at_k(ranking, relevant, 10))
        recall10.append(recall_at_k(ranking, relevant, 10))
        recall50.append(recall_at_k(ranking, relevant, 50))
        mrr.append(reciprocal_rank_at_k(ranking, relevant, 10))
    latencies = sorted(ms for _, ms in results)
    return ModeScores(
        ndcg_at_10=round(statistics.fmean(ndcg), 4),
        recall_at_10=round(statistics.fmean(recall10), 4),
        recall_at_50=round(statistics.fmean(recall50), 4),
        mrr_at_10=round(statistics.fmean(mrr), 4),
        p50_ms=round(latencies[len(latencies) // 2], 1),
        p95_ms=round(latencies[int(len(latencies) * 0.95)], 1),
    )


async def evaluate(
    pool: asyncpg.Pool,
    embedder: Embedder,
    profile: Profile,
    cache: Path,
    options: SearchOptions,
    *,
    chunking: Chunking,
    reindex: bool,
) -> Report:
    passages, questions = build(profile, cache)
    collection = f"eval-{profile.name}"
    # What the stored index was built with. A different model or chunking means the stored vectors answer a different
    # question, so the index is rebuilt rather than scored.
    fingerprint = f"{embedder.name}|{chunking.max_words}|{chunking.overlap_sentences}|{profile.seed}|{len(passages)}"
    async with pool.acquire() as conn:
        await conn.execute(
            "create table if not exists fathom_eval_indexes (collection text primary key, fingerprint text not null)"
        )
        stored = await conn.fetchval("select fingerprint from fathom_eval_indexes where collection = $1", collection)
    if reindex or stored != fingerprint:
        await index(pool, collection, passages, embedder, chunking)
        async with pool.acquire() as conn:
            await conn.execute(
                "insert into fathom_eval_indexes (collection, fingerprint) values ($1, $2)"
                " on conflict (collection) do update set fingerprint = excluded.fingerprint",
                collection,
                fingerprint,
            )
    # An interrupted earlier run can leave chunks without vectors; never score a half-built index.
    await Indexer(pool, embedder, batch=128).drain()
    report = Report(profile.name, embedder.name, len(passages), len(questions), _describe(options))
    for mode in MODES:
        report.modes[mode] = await score(
            pool, collection=collection, questions=questions, embedder=embedder, options=options, mode=mode
        )
        log.info("scored", mode=mode, **asdict(report.modes[mode]))
    return report


def _describe(options: SearchOptions) -> dict[str, Any]:
    described = asdict(options)
    for key in ("k", "mode", "filter", "collapse"):
        described.pop(key)
    return described


def compare(report: Report, baseline: dict[str, Any], tolerance: float) -> list[str]:
    """What got worse than the baseline by more than ``tolerance``, in nDCG@10. Empty means the gate passes."""
    regressions = []
    for mode, scores in report.modes.items():
        expected = baseline["modes"].get(mode, {}).get("ndcg_at_10")
        if expected is not None and scores.ndcg_at_10 < expected - tolerance:
            regressions.append(f"{mode}: nDCG@10 {scores.ndcg_at_10:.4f} is below the baseline {expected:.4f}")
    return regressions


def as_json(report: Report) -> str:
    return json.dumps(asdict(report), indent=2) + "\n"


def as_table(report: Report) -> str:
    lines = [
        f"{report.questions} questions, {report.passages} passages, {report.model}",
        "",
        "| mode | nDCG@10 | Recall@10 | Recall@50 | MRR@10 | p50 ms | p95 ms |",
        "|---|---|---|---|---|---|---|",
    ]
    for mode, s in report.modes.items():
        lines.append(
            f"| {mode} | {s.ndcg_at_10:.3f} | {s.recall_at_10:.3f} | {s.recall_at_50:.3f} | {s.mrr_at_10:.3f}"
            f" | {s.p50_ms:.1f} | {s.p95_ms:.1f} |"
        )
    return "\n".join(lines)

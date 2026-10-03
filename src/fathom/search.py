"""Lexical, vector and hybrid retrieval over one collection.

The two retrievers run at the same time on two connections. Each returns its own top candidates; reciprocal rank fusion
merges them (fusion.py); the best chunk per document is kept; and only then are the k winners' texts and highlighted
snippets read. ``explain`` returns each hit's rank in each retriever, which is how docs/evaluation.md was written.
"""

import asyncio
import re
from dataclasses import dataclass, field
from typing import Any, Literal

import asyncpg

from fathom.embedding import Vectors
from fathom.fusion import reciprocal_rank_fusion

type Mode = Literal["hybrid", "lexical", "vector"]
type LexicalRanker = Literal["ts_rank", "ts_rank_cd"]

# The query becomes an OR of its stemmed words. Postgres' own websearch and plain parsers AND them, which is right for a
# search box and wrong for a question: "who designed the eiffel tower" should not require the word "designed".
_OR_QUERY = "(select replace(plainto_tsquery('english', $2)::text, ' & ', ' | ')::tsquery as q) as query"
_RANKERS: dict[LexicalRanker, str] = {"ts_rank": "ts_rank", "ts_rank_cd": "ts_rank_cd"}
_HAS_WORD = re.compile(r"\w")


@dataclass(frozen=True)
class SearchOptions:
    k: int = 10
    candidates: int = 50
    """How many each retriever contributes before fusion. More finds more, and costs more."""
    mode: Mode = "hybrid"
    filter: dict[str, Any] | None = None
    """JSON containment on document metadata: {"lang": "en"} matches documents whose metadata includes that pair."""
    rrf_k: int = 10
    weights: dict[str, float] | None = None
    ef_search: int = 100
    """HNSW candidate list size. Higher is better recall and slower. Must be at least ``candidates``."""
    iterative_scan: bool = True
    """Keep scanning the HNSW graph until enough rows pass the filter (pgvector 0.8). Without it a selective filter
    can return far fewer than ``candidates`` rows."""
    lexical_ranker: LexicalRanker = "ts_rank"
    lexical_normalization: int = 1
    """Postgres ts_rank normalisation bitmask. 1 divides by 1 + log(document length)."""
    collapse: bool = True
    """At most one chunk per document in the results."""


@dataclass(frozen=True)
class Hit:
    document_id: str
    chunk_id: int
    ordinal: int
    title: str
    text: str
    snippet: str
    metadata: dict[str, Any]
    score: float
    ranks: dict[str, int] = field(default_factory=dict)


@dataclass(frozen=True)
class Candidate:
    chunk_id: int
    document_id: str


async def lexical(conn: asyncpg.Connection, collection: str, query: str, options: SearchOptions) -> list[Candidate]:
    if not _HAS_WORD.search(query):
        return []
    ranker = _RANKERS[options.lexical_ranker]  # a whitelisted function name, never user text
    rows = await conn.fetch(
        f"select c.id, c.document_id from fathom_chunks c, {_OR_QUERY}"  # noqa: S608  # constants only
        " where c.collection = $1 and c.tsv @@ query.q and ($4::jsonb is null or c.metadata @> $4)"
        f" order by {ranker}(c.tsv, query.q, $5) desc, c.id limit $3",
        collection,
        query,
        options.candidates,
        options.filter,
        options.lexical_normalization,
    )
    return [Candidate(r["id"], r["document_id"]) for r in rows]


async def vector(
    conn: asyncpg.Connection, collection: str, embedding: Vectors, options: SearchOptions
) -> list[Candidate]:
    async with conn.transaction(readonly=True):
        # set_config(..., true) lasts until the end of this transaction, so nothing leaks to the next pool user.
        await conn.execute(
            "select set_config('hnsw.ef_search', $1, true), set_config('hnsw.iterative_scan', $2, true)",
            str(max(options.ef_search, options.candidates)),
            "relaxed_order" if options.iterative_scan else "off",
        )
        # relaxed_order may hand rows back slightly out of order, so the outer query sorts the materialised result.
        rows = await conn.fetch(
            "with nearest as materialized ("
            "  select id, document_id, embedding <=> $2 as distance from fathom_chunks"
            "  where collection = $1 and embedding is not null and ($4::jsonb is null or metadata @> $4)"
            "  order by embedding <=> $2 limit $3"
            ") select id, document_id from nearest order by distance, id",
            collection,
            embedding,
            options.candidates,
            options.filter,
        )
    return [Candidate(r["id"], r["document_id"]) for r in rows]


async def search(
    pool: asyncpg.Pool, collection: str, query: str, embedding: Vectors | None, options: SearchOptions
) -> list[Hit]:
    """Top ``options.k`` chunks for ``query``. ``embedding`` may be None only in lexical mode."""

    async def run_lexical() -> list[Candidate]:
        async with pool.acquire() as conn:
            return await lexical(conn, collection, query, options)

    async def run_vector() -> list[Candidate]:
        if embedding is None:
            raise ValueError("vector and hybrid search need a query embedding")
        async with pool.acquire() as conn:
            return await vector(conn, collection, embedding, options)

    rankings: dict[str, list[Candidate]] = {}
    match options.mode:
        case "lexical":
            rankings["lexical"] = await run_lexical()
        case "vector":
            rankings["vector"] = await run_vector()
        case "hybrid":
            rankings["lexical"], rankings["vector"] = await asyncio.gather(run_lexical(), run_vector())

    fused = reciprocal_rank_fusion(
        {source: [c.chunk_id for c in found] for source, found in rankings.items()},
        k=options.rrf_k,
        weights=options.weights,
    )
    owner = {c.chunk_id: c.document_id for found in rankings.values() for c in found}
    winners = []
    seen_documents: set[str] = set()
    for item in fused:
        document = owner[item.key]
        if options.collapse and document in seen_documents:
            continue
        seen_documents.add(document)
        winners.append(item)
        if len(winners) == options.k:
            break
    if not winners:
        return []

    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "select c.id, c.document_id, c.ordinal, c.title, c.text, c.metadata,"  # noqa: S608  # constants only
            "  case when numnode(query.q) > 0 then ts_headline('english', c.text, query.q,"
            "   'StartSel=«, StopSel=», MaxFragments=2, MaxWords=35, MinWords=12')"
            "   else left(c.text, 240) end as snippet"
            f" from fathom_chunks c, {_OR_QUERY} where c.id = any($1::bigint[])",
            [w.key for w in winners],
            query,
        )
    by_id = {r["id"]: r for r in rows}
    return [
        Hit(
            document_id=by_id[w.key]["document_id"],
            chunk_id=w.key,
            ordinal=by_id[w.key]["ordinal"],
            title=by_id[w.key]["title"],
            text=by_id[w.key]["text"],
            snippet=by_id[w.key]["snippet"],
            metadata=by_id[w.key]["metadata"],
            score=w.score,
            ranks=w.ranks,
        )
        for w in winners
        if w.key in by_id  # deleted between ranking and reading: drop it rather than fail the query
    ]

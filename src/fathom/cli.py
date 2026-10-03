"""``fathom migrate | api | indexer | keys | eval``. Configuration comes from the environment (docs/operations.md)."""

import argparse
import asyncio
import contextlib
import json
import signal
import sys
from dataclasses import fields, replace
from pathlib import Path
from typing import Any, cast

import asyncpg
import structlog
import uvicorn

from fathom import evaluation, telemetry
from fathom.api import create_app
from fathom.auth import Scope, create_key, revoke_key
from fathom.embedding import Embedder, FastEmbedder
from fathom.indexer import Indexer
from fathom.migrate import migrate
from fathom.search import SearchOptions
from fathom.settings import Settings
from fathom.store import create_pool

log = structlog.get_logger()


def _embedder(settings: Settings) -> Embedder:
    return FastEmbedder(settings.embedding_model, settings.model_cache_dir, settings.embedding_threads)


async def _migrate(settings: Settings) -> None:
    # A plain connection, not the pool: the pool registers the vector type, which the first migration creates.
    conn = await asyncpg.connect(settings.database_url.get_secret_value())
    try:
        log.info("schema up to date", applied=await migrate(conn))
    finally:
        await conn.close()


async def _index(settings: Settings) -> None:
    pool = await create_pool(settings.database_url.get_secret_value(), min_size=2, max_size=4)
    stop = asyncio.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        with contextlib.suppress(NotImplementedError):  # Windows: Ctrl+C still arrives as KeyboardInterrupt
            asyncio.get_running_loop().add_signal_handler(sig, stop.set)
    try:
        indexer = Indexer(
            pool, _embedder(settings), batch=settings.indexer_batch, idle_wait=settings.indexer_idle_wait_seconds
        )
        await indexer.run(stop)
    finally:
        await pool.close()


async def _keys(settings: Settings, args: argparse.Namespace) -> None:
    conn = await asyncpg.connect(settings.database_url.get_secret_value())
    try:
        if args.keys_command == "create":
            scopes = cast("list[Scope]", args.scopes.split(","))  # the table's check constraint refuses anything else
            key = await create_key(conn, args.collections.split(","), scopes, args.label)
            print(key)  # noqa: T201  # the only time the key is shown, by design
        elif not await revoke_key(conn, args.key_id):
            sys.exit(f"no active key {args.key_id}")
    finally:
        await conn.close()


def _option(text: str) -> tuple[str, Any]:
    """``name=value`` for one SearchOptions field, with the value parsed as JSON so numbers and maps work."""
    name, _, raw = text.partition("=")
    known = {f.name for f in fields(SearchOptions)}
    if name not in known:
        raise argparse.ArgumentTypeError(f"{name} is not one of {', '.join(sorted(known))}")
    try:
        return name, json.loads(raw)
    except json.JSONDecodeError:
        return name, raw


async def _eval(settings: Settings, args: argparse.Namespace) -> int:
    options = replace(
        SearchOptions(candidates=settings.candidates, ef_search=settings.ef_search, rrf_k=settings.rrf_k),
        **dict(args.set or []),
    )
    pool = await create_pool(settings.database_url.get_secret_value(), max_size=12)
    try:
        report = await evaluation.evaluate(
            pool,
            _embedder(settings),
            evaluation.PROFILES[args.profile],
            Path(args.data_dir),
            options,
            chunking=evaluation.Chunking(settings.chunk_max_words, settings.chunk_overlap_sentences),
            reindex=args.reindex,
        )
    finally:
        await pool.close()
    print(evaluation.as_table(report))  # noqa: T201
    if args.output:
        await asyncio.to_thread(Path(args.output).write_text, evaluation.as_json(report), encoding="utf-8")
    if args.baseline:
        regressions = evaluation.compare(
            report, json.loads(await asyncio.to_thread(Path(args.baseline).read_text, encoding="utf-8")), args.tolerance
        )
        for line in regressions:
            print(f"REGRESSION {line}")  # noqa: T201
        return 1 if regressions else 0
    return 0


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="fathom", description="Hybrid search on Postgres")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("migrate", help="bring the database schema up to date")
    sub.add_parser("indexer", help="embed pending chunks until stopped")
    api = sub.add_parser("api", help="serve the HTTP API")
    api.add_argument("--host", default="127.0.0.1")
    api.add_argument("--port", type=int, default=8000)
    keys = sub.add_parser("keys", help="create or revoke API keys")
    keys_sub = keys.add_subparsers(dest="keys_command", required=True)
    create = keys_sub.add_parser("create")
    create.add_argument("--collections", required=True, help="comma-separated, or * for all")
    create.add_argument("--scopes", default="read", help="comma-separated: read, write")
    create.add_argument("--label", default="")
    revoke = keys_sub.add_parser("revoke")
    revoke.add_argument("key_id")
    ev = sub.add_parser("eval", help="measure relevance on SQuAD; with --baseline, fail on a regression")
    ev.add_argument("--profile", choices=sorted(evaluation.PROFILES), default="ci")
    ev.add_argument("--data-dir", default=str(Path.home() / ".cache" / "fathom"))
    ev.add_argument("--baseline")
    ev.add_argument("--tolerance", type=float, default=0.01)
    ev.add_argument("--output")
    ev.add_argument("--reindex", action="store_true")
    ev.add_argument("--set", type=_option, action="append", metavar="OPTION=VALUE", help="override a search option")
    args = parser.parse_args(argv)

    settings = Settings()
    telemetry.configure(settings.log_level, settings.otlp_endpoint)
    match args.command:
        case "migrate":
            asyncio.run(_migrate(settings))
        case "indexer":
            asyncio.run(_index(settings))
        case "keys":
            asyncio.run(_keys(settings, args))
        case "eval":
            sys.exit(asyncio.run(_eval(settings, args)))
        case "api":
            app = create_app(settings, lambda: _embedder(settings))
            uvicorn.run(app, host=args.host, port=args.port, log_config=None, proxy_headers=False)

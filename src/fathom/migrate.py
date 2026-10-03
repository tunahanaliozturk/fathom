"""Applies the SQL files in ``migrations/`` in order, once each, under an advisory lock."""

from importlib.resources import files

import asyncpg
import structlog

log = structlog.get_logger()

_LOCK = 0x666174686F6D  # "fathom" in ASCII


def _migrations() -> list[tuple[str, str]]:
    folder = files("fathom") / "migrations"
    return sorted((f.name, f.read_text(encoding="utf-8")) for f in folder.iterdir() if f.name.endswith(".sql"))


async def migrate(conn: asyncpg.Connection) -> list[str]:
    """Bring the schema up to date. Safe to run from several processes at once; the lock makes them take turns."""
    applied_now: list[str] = []
    await conn.execute("select pg_advisory_lock($1)", _LOCK)
    try:
        await conn.execute(
            "create table if not exists fathom_schema_migrations ("
            " name text primary key, applied_at timestamptz not null default now())"
        )
        done = {r["name"] for r in await conn.fetch("select name from fathom_schema_migrations")}
        for name, sql in _migrations():
            if name in done:
                continue
            async with conn.transaction():
                await conn.execute(sql)
                await conn.execute("insert into fathom_schema_migrations (name) values ($1)", name)
            log.info("migration applied", migration=name)
            applied_now.append(name)
    finally:
        await conn.execute("select pg_advisory_unlock($1)", _LOCK)
    return applied_now

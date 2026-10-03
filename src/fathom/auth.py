"""API keys: scoped to collections and to read or write, stored as hashes, checked in constant time.

A key looks like ``fth_<id>_<secret>``. The id finds the row; the secret is compared, as a SHA-256 digest, with
``hmac.compare_digest``. The secret is 32 random bytes, so a fast hash is the right tool: there is nothing to brute
force that a slow hash would protect. Verified keys are cached for a few seconds to keep a database round trip off
every search; a revoked key therefore keeps working for at most that long.
"""

import hashlib
import hmac
import re
import secrets
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal

import asyncpg

type Scope = Literal["read", "write"]

_KEY = re.compile(r"^fth_([0-9a-f]{16})_([A-Za-z0-9_-]{43})$")
ALL_COLLECTIONS = "*"
_CACHE_SIZE = 10_000


@dataclass(frozen=True)
class Principal:
    key_id: str
    collections: frozenset[str]
    scopes: frozenset[str]

    def may(self, scope: Scope, collection: str) -> bool:
        in_reach = ALL_COLLECTIONS in self.collections or collection in self.collections
        return in_reach and scope in self.scopes


def _digest(secret: str) -> bytes:
    return hashlib.sha256(secret.encode()).digest()


async def create_key(conn: asyncpg.Connection, collections: list[str], scopes: list[Scope], label: str = "") -> str:
    """Create a key and return it. This is the only time the full key exists anywhere."""
    key_id = secrets.token_hex(8)
    secret = secrets.token_urlsafe(32)
    await conn.execute(
        "insert into fathom_api_keys (id, secret_hash, collections, scopes, label) values ($1, $2, $3, $4, $5)",
        key_id,
        _digest(secret),
        collections,
        scopes,
        label,
    )
    return f"fth_{key_id}_{secret}"


async def revoke_key(conn: asyncpg.Connection, key_id: str) -> bool:
    revoked = await conn.fetchval(
        "update fathom_api_keys set revoked_at = now() where id = $1 and revoked_at is null returning 1", key_id
    )
    return revoked is not None


class KeyVerifier:
    def __init__(
        self, pool: asyncpg.Pool, *, cache_seconds: float = 10.0, clock: Callable[[], float] = time.monotonic
    ) -> None:
        self._pool = pool
        self._ttl = cache_seconds
        self._now = clock
        self._cache: OrderedDict[str, tuple[float, Principal]] = OrderedDict()

    async def verify(self, presented: str) -> Principal | None:
        match = _KEY.match(presented)
        if match is None:
            return None
        key_id, secret = match.groups()
        cached = self._cache.get(presented)
        if cached is not None and self._now() - cached[0] < self._ttl:
            self._cache.move_to_end(presented)
            return cached[1]
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                "select secret_hash, collections, scopes from fathom_api_keys where id = $1 and revoked_at is null",
                key_id,
            )
        principal = None
        # Compare even when the row is missing, against a dummy, so timing does not reveal which ids exist.
        stored = bytes(row["secret_hash"]) if row is not None else _digest("no such key")
        if hmac.compare_digest(stored, _digest(secret)) and row is not None:
            principal = Principal(key_id, frozenset(row["collections"]), frozenset(row["scopes"]))
        if principal is not None:
            # Only good keys are cached, least recently used out first: a flood of made-up keys can cost lookups, but
            # it cannot push the real keys out of the cache.
            self._cache[presented] = (self._now(), principal)
            self._cache.move_to_end(presented)
            if len(self._cache) > _CACHE_SIZE:
                self._cache.popitem(last=False)
        return principal

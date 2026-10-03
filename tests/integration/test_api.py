"""The HTTP surface: keys and scopes, writes, search, limits."""

from collections.abc import AsyncIterator

import asyncpg
import httpx
import pytest
import pytest_asyncio

from fathom.api import Services, build_app
from fathom.auth import KeyVerifier, create_key, revoke_key
from fathom.embedding import HashingEmbedder, QueryCache
from tests.integration.conftest import index_all


@pytest_asyncio.fixture(loop_scope="session")
async def http(pool: asyncpg.Pool) -> AsyncIterator[httpx.AsyncClient]:
    app = build_app(max_payload_bytes=64 * 1024)
    app.state.services = Services(
        pool=pool, keys=KeyVerifier(pool, cache_seconds=0), queries=QueryCache(HashingEmbedder())
    )
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://fathom.test") as client:
        yield client


async def key(pool: asyncpg.Pool, collections: list[str], scopes: list[str]) -> dict[str, str]:
    async with pool.acquire() as conn:
        secret = await create_key(conn, collections, scopes)  # type: ignore[arg-type]
    return {"Authorization": f"Bearer {secret}"}


def doc(document_id: str, text: str, **extra: object) -> dict[str, object]:
    return {"id": document_id, "text": text} | extra


@pytest.mark.asyncio(loop_scope="session")
@pytest.mark.parametrize("header", [None, "Bearer nope", "Bearer fth_0123456789abcdef_" + "x" * 43])
async def test_a_missing_malformed_or_unknown_key_is_refused(http: httpx.AsyncClient, header: str | None) -> None:
    headers = {"Authorization": header} if header else {}

    response = await http.post("/v1/collections/kb/search", json={"query": "x"}, headers=headers)

    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"


@pytest.mark.asyncio(loop_scope="session")
async def test_a_key_reaches_only_its_collections_and_scopes(http: httpx.AsyncClient, pool: asyncpg.Pool) -> None:
    reader = await key(pool, ["kb"], ["read"])

    other = await http.post("/v1/collections/secret/search", json={"query": "x"}, headers=reader)
    write = await http.put("/v1/collections/kb/documents/a", json=doc("a", "text"), headers=reader)
    read = await http.post("/v1/collections/kb/search", json={"query": "x"}, headers=reader)

    assert (other.status_code, write.status_code, read.status_code) == (404, 404, 200)


@pytest.mark.asyncio(loop_scope="session")
async def test_a_revoked_key_stops_working(http: httpx.AsyncClient, pool: asyncpg.Pool) -> None:
    headers = await key(pool, ["*"], ["read"])
    assert (await http.get("/v1/collections/kb/stats", headers=headers)).status_code == 200

    async with pool.acquire() as conn:
        await revoke_key(conn, headers["Authorization"].split("_")[1])

    assert (await http.get("/v1/collections/kb/stats", headers=headers)).status_code == 401


@pytest.mark.asyncio(loop_scope="session")
async def test_write_index_search_round_trip(http: httpx.AsyncClient, pool: asyncpg.Pool) -> None:
    writer = await key(pool, ["kb"], ["read", "write"])
    batch = {
        "documents": [
            doc("eiffel", "The Eiffel Tower was designed by Gustave Eiffel.", title="Eiffel Tower"),
            doc("louvre", "The Louvre is a museum in Paris.", metadata={"kind": "museum"}),
        ]
    }

    written = await http.post("/v1/collections/kb/documents", json=batch, headers=writer)
    await index_all(pool, HashingEmbedder())
    found = await http.post(
        "/v1/collections/kb/search", json={"query": "who designed the tower", "explain": True}, headers=writer
    )
    again = await http.put("/v1/collections/kb/documents/eiffel", json=batch["documents"][0], headers=writer)

    assert written.status_code == 202
    assert [w["id"] for w in written.json()] == ["eiffel", "louvre"]
    body = found.json()
    assert body["hits"][0]["document_id"] == "eiffel"
    assert set(body["hits"][0]["ranks"]) == {"lexical", "vector"}
    assert (again.status_code, again.json()["unchanged"]) == (200, True)
    status = (await http.get("/v1/collections/kb/documents/eiffel", headers=writer)).json()
    assert (status["chunks"], status["embedded"]) == (1, 1)


@pytest.mark.asyncio(loop_scope="session")
async def test_bad_writes_are_refused_before_anything_is_stored(http: httpx.AsyncClient, pool: asyncpg.Pool) -> None:
    writer = await key(pool, ["kb"], ["write", "read"])

    duplicate = await http.post(
        "/v1/collections/kb/documents", json={"documents": [doc("a", "x"), doc("a", "y")]}, headers=writer
    )
    mismatch = await http.put("/v1/collections/kb/documents/a", json=doc("b", "x"), headers=writer)
    bad_name = await http.put("/v1/collections/Bad%20Name/documents/a", json=doc("a", "x"), headers=writer)
    slash = await http.post("/v1/collections/kb/documents", json={"documents": [doc("a/b", "x")]}, headers=writer)
    huge = await http.put("/v1/collections/kb/documents/a", json=doc("a", "x" * 70_000), headers=writer)

    assert (duplicate.status_code, mismatch.status_code, bad_name.status_code, huge.status_code) == (
        422,
        422,
        422,
        413,
    )
    assert slash.status_code == 422, "an id the single-document routes could never address is refused"
    assert mismatch.json()["title"] == "Invalid request"
    stats = (await http.get("/v1/collections/kb/stats", headers=writer)).json()
    assert stats["documents"] == 0


@pytest.mark.asyncio(loop_scope="session")
async def test_deleting_a_document_removes_it_from_search(http: httpx.AsyncClient, pool: asyncpg.Pool) -> None:
    writer = await key(pool, ["kb"], ["read", "write"])
    await http.put("/v1/collections/kb/documents/gone", json=doc("gone", "Ephemeral words."), headers=writer)

    deleted = await http.delete("/v1/collections/kb/documents/gone", headers=writer)
    again = await http.delete("/v1/collections/kb/documents/gone", headers=writer)
    found = await http.post("/v1/collections/kb/search", json={"query": "ephemeral", "mode": "lexical"}, headers=writer)

    assert (deleted.status_code, again.status_code) == (204, 404)
    assert found.json()["hits"] == []

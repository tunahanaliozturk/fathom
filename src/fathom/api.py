"""HTTP API: write documents, search them. Every route needs a key with the right scope for the collection."""

import contextlib
import time
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from typing import Annotated, Any, Literal

import asyncpg
from fastapi import Depends, FastAPI, Path, Request, Response
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from fathom import store, telemetry
from fathom.auth import KeyVerifier, Principal
from fathom.chunking import chunk
from fathom.embedding import Embedder, QueryCache
from fathom.search import Mode, SearchOptions, search
from fathom.settings import Settings

_COLLECTION = r"^[a-z0-9][a-z0-9_-]{0,62}$"
_DOCUMENT_ID = r"^[A-Za-z0-9._:@-]{1,256}$"

_TITLES = {401: "Unauthorised", 404: "Not found", 422: "Invalid request"}

type Lifespan = Callable[[FastAPI], contextlib.AbstractAsyncContextManager[None]]
type Collection = Annotated[str, Path(pattern=_COLLECTION)]


@dataclass
class Services:
    """What the routes need. Built by the lifespan in production, by the test fixture in tests."""

    pool: asyncpg.Pool
    keys: KeyVerifier
    queries: QueryCache
    chunk_max_words: int = 180
    chunk_overlap_sentences: int = 1
    candidates: int = 50
    ef_search: int = 100
    rrf_k: int = 10


class DocumentIn(BaseModel):
    id: str = Field(pattern=_DOCUMENT_ID)
    title: str = Field(default="", max_length=1000)
    text: str = Field(min_length=1)
    metadata: dict[str, Any] = Field(default_factory=dict)


class DocumentBatch(BaseModel):
    documents: list[DocumentIn] = Field(min_length=1, max_length=100)


class DocumentWritten(BaseModel):
    id: str
    chunks: int
    reused_embeddings: int
    unchanged: bool


class DocumentView(BaseModel):
    id: str
    title: str
    metadata: dict[str, Any]
    chunks: int
    embedded: int


class SearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=1000)
    k: int = Field(default=10, ge=1, le=100)
    mode: Mode = "hybrid"
    filter: dict[str, Any] | None = Field(default=None, description="JSON containment on document metadata")
    explain: bool = Field(default=False, description="Include each hit's rank in each retriever")


class HitView(BaseModel):
    document_id: str
    ordinal: int
    title: str
    snippet: str = Field(description="Plain text with matches between « and ». Escape it before rendering as HTML.")
    metadata: dict[str, Any]
    score: float
    ranks: dict[str, int] | None = None


class SearchResponse(BaseModel):
    mode: Mode
    took_ms: float
    hits: list[HitView]


class Stats(BaseModel):
    documents: int
    chunks: int
    pending: int


def _problem(status: int, title: str, detail: str, headers: dict[str, str] | None = None) -> JSONResponse:
    return JSONResponse(
        {"type": "about:blank", "title": title, "status": status, "detail": detail},
        status_code=status,
        media_type="application/problem+json",
        headers=headers,
    )


class _Denied(Exception):
    def __init__(self, status: int, detail: str) -> None:
        self.status = status
        self.detail = detail


class BodyLimit:
    """Refuses bodies over a size. It reads the body itself, so leaving out Content-Length does not get past it."""

    def __init__(self, app: ASGIApp, max_bytes: int) -> None:
        self._app = app
        self._max = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self._app(scope, receive, send)
            return
        too_large = _problem(413, "Payload too large", f"bodies are limited to {self._max} bytes")
        declared = dict(scope["headers"]).get(b"content-length")
        if declared is not None and int(declared) > self._max:
            await too_large(scope, receive, send)
            return
        body = bytearray()
        while True:
            message = await receive()
            if message["type"] != "http.request":
                break
            body += message.get("body", b"")
            if len(body) > self._max:
                await too_large(scope, receive, send)
                return
            if not message.get("more_body", False):
                break
        replayed = False

        async def replay() -> Message:
            nonlocal replayed
            if replayed:
                return await receive()
            replayed = True
            return {"type": "http.request", "body": bytes(body), "more_body": False}

        await self._app(scope, replay, send)


def _services(request: Request) -> Services:
    services: Services = request.app.state.services
    return services


type _Services = Annotated[Services, Depends(_services)]
_bearer = HTTPBearer(auto_error=False)


async def _principal(
    services: _Services, credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)]
) -> Principal:
    principal = await services.keys.verify(credentials.credentials) if credentials is not None else None
    if principal is None:
        raise _Denied(401, "a valid API key is required")
    return principal


type _Principal = Annotated[Principal, Depends(_principal)]


def _require(principal: Principal, scope: Literal["read", "write"], collection: str) -> None:
    if not principal.may(scope, collection):
        # 404 rather than 403: a key should not be able to learn which collections exist outside its reach.
        raise _Denied(404, f"no collection {collection!r} for this key")


def build_app(max_payload_bytes: int, lifespan: Lifespan | None = None) -> FastAPI:
    app = FastAPI(title="fathom", version="0.1.0", docs_url="/docs", redoc_url=None, lifespan=lifespan)

    @app.exception_handler(_Denied)
    async def denied(_: Request, exc: Exception) -> Response:
        assert isinstance(exc, _Denied)  # noqa: S101
        headers = {"WWW-Authenticate": "Bearer"} if exc.status == 401 else None  # noqa: PLR2004
        return _problem(exc.status, _TITLES.get(exc.status, "Error"), exc.detail, headers)

    @app.put("/v1/collections/{collection}/documents/{document_id}", response_model=DocumentWritten)
    async def put_document(  # noqa: PLR0917  # FastAPI injects each dependency as a parameter
        collection: Collection,
        document_id: Annotated[str, Path(pattern=_DOCUMENT_ID)],
        body: DocumentIn,
        services: _Services,
        principal: _Principal,
        response: Response,
    ) -> DocumentWritten:
        _require(principal, "write", collection)
        if body.id != document_id:
            raise _Denied(422, "the id in the body must match the id in the path")
        [written] = await _write(services, collection, [body])
        response.status_code = 200 if written.unchanged else 202
        return written

    @app.post("/v1/collections/{collection}/documents", status_code=202, response_model=list[DocumentWritten])
    async def post_documents(
        collection: Collection, body: DocumentBatch, services: _Services, principal: _Principal
    ) -> list[DocumentWritten]:
        _require(principal, "write", collection)
        if len({d.id for d in body.documents}) != len(body.documents):
            raise _Denied(422, "document ids in one batch must be unique")
        return await _write(services, collection, body.documents)

    @app.get("/v1/collections/{collection}/documents/{document_id}", response_model=DocumentView)
    async def get_document(
        collection: Collection, document_id: str, services: _Services, principal: _Principal
    ) -> DocumentView:
        _require(principal, "read", collection)
        async with services.pool.acquire() as conn:
            status = await store.document_status(conn, collection, document_id)
        if status is None:
            raise _Denied(404, f"no document {document_id!r}")
        return DocumentView(
            id=status.id, title=status.title, metadata=status.metadata, chunks=status.chunks, embedded=status.embedded
        )

    @app.delete("/v1/collections/{collection}/documents/{document_id}", status_code=204)
    async def delete_document(
        collection: Collection, document_id: str, services: _Services, principal: _Principal
    ) -> Response:
        _require(principal, "write", collection)
        async with services.pool.acquire() as conn:
            if not await store.delete_document(conn, collection, document_id):
                raise _Denied(404, f"no document {document_id!r}")
        return Response(status_code=204)

    @app.get("/v1/collections/{collection}/stats", response_model=Stats)
    async def stats(collection: Collection, services: _Services, principal: _Principal) -> Stats:
        _require(principal, "read", collection)
        async with services.pool.acquire() as conn:
            return Stats(**await store.collection_stats(conn, collection))

    @app.post("/v1/collections/{collection}/search", response_model=SearchResponse, response_model_exclude_none=True)
    async def run_search(
        collection: Collection, body: SearchRequest, services: _Services, principal: _Principal
    ) -> SearchResponse:
        _require(principal, "read", collection)
        started = time.perf_counter()
        embedding = None if body.mode == "lexical" else await services.queries.embed(body.query)
        options = SearchOptions(
            k=body.k,
            candidates=max(services.candidates, body.k),
            mode=body.mode,
            filter=body.filter,
            rrf_k=services.rrf_k,
            ef_search=services.ef_search,
        )
        with telemetry.tracer.start_as_current_span("fathom.search", attributes={"search.mode": body.mode}):
            hits = await search(services.pool, collection, body.query, embedding, options)
        took = time.perf_counter() - started
        telemetry.searches.add(1, {"mode": body.mode})
        telemetry.search_duration.record(took, {"mode": body.mode})
        return SearchResponse(
            mode=body.mode,
            took_ms=round(took * 1000, 2),
            hits=[
                HitView(
                    document_id=h.document_id,
                    ordinal=h.ordinal,
                    title=h.title,
                    snippet=h.snippet,
                    metadata=h.metadata,
                    score=h.score,
                    ranks=h.ranks if body.explain else None,
                )
                for h in hits
            ],
        )

    @app.get("/healthz", include_in_schema=False)
    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/readyz", include_in_schema=False)
    async def readyz(services: _Services) -> Response:
        try:
            async with services.pool.acquire() as conn:
                await conn.fetchval("select 1")
        except asyncpg.PostgresError, asyncpg.InterfaceError, OSError:
            return _problem(503, "Not ready", "the database is unreachable")
        return JSONResponse({"status": "ready"})

    app.add_middleware(BodyLimit, max_bytes=max_payload_bytes)
    return app


async def _write(services: Services, collection: str, documents: list[DocumentIn]) -> list[DocumentWritten]:
    """Write a batch in one transaction, in id order, so two batches touching the same documents cannot deadlock."""
    written: dict[str, DocumentWritten] = {}
    async with services.pool.acquire() as conn, conn.transaction():
        for document in sorted(documents, key=lambda d: d.id):
            chunks = chunk(
                document.text,
                max_words=services.chunk_max_words,
                overlap_sentences=services.chunk_overlap_sentences,
            )
            result = await store.upsert_document(
                conn,
                collection=collection,
                document_id=document.id,
                title=document.title,
                text=document.text,
                metadata=document.metadata,
                chunks=chunks,
            )
            written[document.id] = DocumentWritten(
                id=document.id,
                chunks=result.chunks,
                reused_embeddings=result.reused_embeddings,
                unchanged=result.unchanged,
            )
            telemetry.documents_written.add(1, {"outcome": "unchanged" if result.unchanged else "written"})
    return [written[d.id] for d in documents]


def create_app(settings: Settings, embedder_factory: Callable[[], Embedder]) -> FastAPI:
    """The production app. It owns its pool and its model for the lifetime of the process."""

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        pool = await store.create_pool(settings.database_url.get_secret_value(), max_size=settings.pool_size)
        app.state.services = Services(
            pool=pool,
            keys=KeyVerifier(pool, cache_seconds=settings.key_cache_seconds),
            queries=QueryCache(embedder_factory()),
            chunk_max_words=settings.chunk_max_words,
            chunk_overlap_sentences=settings.chunk_overlap_sentences,
            candidates=settings.candidates,
            ef_search=settings.ef_search,
            rrf_k=settings.rrf_k,
        )
        try:
            yield
        finally:
            await pool.close()

    return build_app(settings.max_payload_bytes, lifespan)

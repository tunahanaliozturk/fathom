"""Turning text into vectors.

Production uses a small ONNX model through fastembed: no PyTorch, no GPU, a 66 MB download. It is compute-bound and not
fast: a 133-token SQuAD paragraph costs a few billion floating-point operations, and a laptop CPU embeds about 18 of
them a second (docs/benchmark-results). Writing never waits for it; indexers catch up, and more indexer processes catch
up faster. Tests use :class:`HashingEmbedder`, which needs no download and is deterministic; it is a bag of hashed
words, so it behaves like a crude lexical retriever, which is enough to exercise every code path but says nothing about
relevance. Only the evaluation harness measures relevance, and it always uses the real model.
"""

import asyncio
import hashlib
import re
from collections import OrderedDict
from collections.abc import Callable, Iterable, Sequence
from pathlib import Path
from typing import Protocol

import numpy as np
import numpy.typing as npt

type Vectors = npt.NDArray[np.float32]

DIMENSIONS = 384
"""The width of the vector column in the schema. A model with another width is refused at start-up."""


class Embedder(Protocol):
    @property
    def name(self) -> str: ...

    @property
    def dimensions(self) -> int: ...

    def embed_passages(self, texts: Sequence[str]) -> Vectors:
        """One unit-length row per text. CPU-bound: call it through ``asyncio.to_thread``."""
        ...

    def embed_queries(self, texts: Sequence[str]) -> Vectors:
        """One unit-length row per query. Queries may be embedded differently from passages (an instruction prefix)."""
        ...

    def embed_query(self, text: str) -> Vectors: ...


class FastEmbedder:
    """BAAI/bge-small-en-v1.5 by default (MIT licence, 384 dimensions), run by onnxruntime on the CPU."""

    # bge models were trained with this instruction in front of short queries and nothing in front of passages.
    QUERY_PREFIX = "Represent this sentence for searching relevant passages: "

    def __init__(
        self, model: str = "BAAI/bge-small-en-v1.5", cache_dir: Path | None = None, threads: int | None = None
    ) -> None:
        from fastembed import TextEmbedding  # noqa: PLC0415  # imports onnxruntime; only processes that embed pay

        self._model = TextEmbedding(model_name=model, cache_dir=str(cache_dir) if cache_dir else None, threads=threads)
        self._name = model
        self._dimensions = int(self.embed_passages(["probe"]).shape[1])

    @property
    def name(self) -> str:
        return self._name

    @property
    def dimensions(self) -> int:
        return self._dimensions

    def embed_passages(self, texts: Sequence[str]) -> Vectors:
        return in_length_order(texts, lambda batch: list(self._model.embed(batch, batch_size=len(batch))), 16)

    def embed_queries(self, texts: Sequence[str]) -> Vectors:
        return self.embed_passages([self.QUERY_PREFIX + t for t in texts])

    def embed_query(self, text: str) -> Vectors:
        vector: Vectors = self.embed_queries([text])[0]
        return vector


def in_length_order(texts: Sequence[str], embed: Callable[[list[str]], Iterable[npt.ArrayLike]], batch: int) -> Vectors:
    """Embed in small batches of similar length, and hand the rows back in the original order.

    A batch is padded to its longest text, so a batch mixing a 40-token and a 400-token passage spends most of its
    work on padding. Sorting first doubled throughput on the evaluation corpus (docs/benchmark-results).
    """
    if not texts:
        return np.zeros((0, 0), dtype=np.float32)
    order = sorted(range(len(texts)), key=lambda i: len(texts[i]))
    rows: list[npt.ArrayLike] = [[] for _ in texts]
    for start in range(0, len(order), batch):
        positions = order[start : start + batch]
        for position, row in zip(positions, embed([texts[i] for i in positions]), strict=True):
            rows[position] = row
    vectors: Vectors = np.asarray(rows, dtype=np.float32).reshape(len(texts), -1)
    return vectors


_TOKEN = re.compile(r"[a-z0-9]+")


class HashingEmbedder:
    """Hashed bag of words, signed to cancel collisions on average, then normalised. For tests only."""

    def __init__(self, dimensions: int = DIMENSIONS) -> None:
        self._dimensions = dimensions

    @property
    def name(self) -> str:
        return "hashing"

    @property
    def dimensions(self) -> int:
        return self._dimensions

    def _one(self, text: str) -> Vectors:
        vector = np.zeros(self._dimensions, dtype=np.float32)
        for token in _TOKEN.findall(text.lower()):
            digest = hashlib.blake2b(token.encode(), digest_size=8).digest()
            value = int.from_bytes(digest, "little")
            vector[value % self._dimensions] += 1.0 if value >> 63 else -1.0
        norm = float(np.linalg.norm(vector))
        return vector / norm if norm else vector

    def embed_passages(self, texts: Sequence[str]) -> Vectors:
        return np.stack([self._one(t) for t in texts]) if texts else np.zeros((0, self._dimensions), np.float32)

    def embed_queries(self, texts: Sequence[str]) -> Vectors:
        return self.embed_passages(texts)

    def embed_query(self, text: str) -> Vectors:
        return self._one(text)


class QueryCache:
    """Recent query vectors, so a repeated query skips the model. Bounded, least recently used out first."""

    def __init__(self, embedder: Embedder, size: int = 2048) -> None:
        self._embedder = embedder
        self._size = size
        self._entries: OrderedDict[str, Vectors] = OrderedDict()
        self.hits = 0
        self.misses = 0

    async def embed(self, text: str) -> Vectors:
        if (cached := self._entries.get(text)) is not None:
            self._entries.move_to_end(text)
            self.hits += 1
            return cached
        self.misses += 1
        vector = await asyncio.to_thread(self._embedder.embed_query, text)
        self._entries[text] = vector
        if len(self._entries) > self._size:
            self._entries.popitem(last=False)
        return vector

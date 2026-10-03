"""Splitting a document into the passages that get indexed and returned.

Chunks follow sentence boundaries and stay under a word budget, with the last sentence of one chunk repeated at the
start of the next so that an answer straddling the boundary is still found whole in one of them. Each chunk carries a
hash of its text: re-indexing a document re-embeds only the chunks whose text changed.
"""

import hashlib
import re
from dataclasses import dataclass

_SENTENCE_END = re.compile(r"(?<=[.!?])\s+(?=[\"'(\[]?[A-Z0-9])")
_PARAGRAPH = re.compile(r"\n\s*\n")


@dataclass(frozen=True)
class Chunk:
    ordinal: int
    text: str
    content_hash: str


def _sentences(text: str) -> list[str]:
    sentences: list[str] = []
    for paragraph in _PARAGRAPH.split(text):
        flat = " ".join(paragraph.split())
        if flat:
            sentences.extend(s for s in _SENTENCE_END.split(flat) if s)
    return sentences


def _words(sentence: str) -> int:
    return len(sentence.split())


def _split_long(sentence: str, budget: int) -> list[str]:
    """A single sentence over budget (a table row, a run-on list) is cut on word boundaries."""
    words = sentence.split()
    return [" ".join(words[i : i + budget]) for i in range(0, len(words), budget)]


def content_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def chunk(text: str, *, max_words: int = 180, overlap_sentences: int = 1) -> list[Chunk]:
    """Chunks of at most ``max_words`` words, in order. Empty or whitespace-only text gives no chunks."""
    if max_words < 1 or overlap_sentences < 0:
        raise ValueError("max_words must be positive and overlap_sentences not negative")
    pieces = [p for s in _sentences(text) for p in (_split_long(s, max_words) if _words(s) > max_words else [s])]
    chunks: list[list[str]] = []
    current: list[str] = []
    for piece in pieces:
        if current and sum(map(_words, current)) + _words(piece) > max_words:
            chunks.append(current)
            carried = current[-overlap_sentences:] if overlap_sentences else []
            # Carry the overlap only if it leaves room for the new sentence; otherwise start clean.
            current = carried if sum(map(_words, carried)) + _words(piece) <= max_words else []
        current.append(piece)
    if current:
        chunks.append(current)
    return [Chunk(i, " ".join(c), content_hash(" ".join(c))) for i, c in enumerate(chunks)]

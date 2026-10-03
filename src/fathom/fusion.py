"""Combining ranked lists from different retrievers into one.

Reciprocal rank fusion scores an item by the sum of ``weight / (k + rank)`` over every list it appears in. It looks only
at ranks, never at raw scores, which is the point: a full-text rank and a cosine similarity are not on any common
scale, and normalising them against each other is where hybrid search usually goes quietly wrong. ``k`` damps the
difference between the top few places. The original paper (Cormack, Clarke and Buettcher, 2009) used 60; on the
evaluation set 10 did better on both profiles, so the service defaults to 10 (docs/evaluation.md, ADR 3). The
function's own default stays at the paper's value.
"""

from collections.abc import Hashable, Mapping, Sequence
from dataclasses import dataclass, field


@dataclass(frozen=True)
class Fused[K: Hashable]:
    key: K
    score: float
    ranks: dict[str, int] = field(default_factory=dict)
    """1-based rank in each list the item appeared in. Absent means the retriever did not return it."""


def reciprocal_rank_fusion[K: Hashable](
    rankings: Mapping[str, Sequence[K]], *, k: int = 60, weights: Mapping[str, float] | None = None
) -> list[Fused[K]]:
    """Fuse ranked lists, best first. Ties keep the order in which items were first seen, so output is stable."""
    if k < 0:
        raise ValueError("k must not be negative")
    scores: dict[K, float] = {}
    ranks: dict[K, dict[str, int]] = {}
    for source, ranking in rankings.items():
        weight = 1.0 if weights is None else weights.get(source, 1.0)
        for position, key in enumerate(ranking, start=1):
            if source in ranks.get(key, {}):
                continue  # a retriever listing an item twice gets credit once, at its better rank
            scores[key] = scores.get(key, 0.0) + weight / (k + position)
            ranks.setdefault(key, {})[source] = position
    order = sorted(scores, key=lambda key: -scores[key])  # sorted() is stable: first seen wins a tie
    return [Fused(key, scores[key], ranks[key]) for key in order]

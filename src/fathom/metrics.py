"""Ranking quality measures, written out so a reader can check them against the definitions.

``relevant`` maps a document to its graded relevance (1 for a plain binary judgement). Documents missing from it have
relevance 0. Every function takes the ranking the system produced, best first.
"""

import math
from collections.abc import Mapping, Sequence


def dcg_at_k(ranking: Sequence[str], relevant: Mapping[str, float], k: int) -> float:
    """Discounted cumulative gain with the exponential gain used by most IR evaluations: (2^rel - 1) / log2(i + 1)."""
    return sum((2 ** relevant.get(doc, 0.0) - 1) / math.log2(i + 2) for i, doc in enumerate(ranking[:k]))


def ndcg_at_k(ranking: Sequence[str], relevant: Mapping[str, float], k: int) -> float:
    """DCG divided by the DCG of the best possible ranking. 1.0 is perfect; 0.0 means nothing relevant in the top k."""
    ideal = dcg_at_k(sorted(relevant, key=lambda d: -relevant[d]), relevant, k)
    return 0.0 if ideal == 0 else dcg_at_k(ranking, relevant, k) / ideal


def recall_at_k(ranking: Sequence[str], relevant: Mapping[str, float], k: int) -> float:
    """Share of the relevant documents that appear in the top k."""
    wanted = {d for d, grade in relevant.items() if grade > 0}
    return 0.0 if not wanted else len(wanted.intersection(ranking[:k])) / len(wanted)


def reciprocal_rank_at_k(ranking: Sequence[str], relevant: Mapping[str, float], k: int) -> float:
    """1 / position of the first relevant document, or 0 if none is in the top k."""
    for i, doc in enumerate(ranking[:k], start=1):
        if relevant.get(doc, 0.0) > 0:
            return 1.0 / i
    return 0.0

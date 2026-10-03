"""Chunking, fusion and the ranking metrics: no database, no model."""

import math

import pytest
from hypothesis import given
from hypothesis import strategies as st

from fathom.chunking import chunk
from fathom.fusion import reciprocal_rank_fusion
from fathom.metrics import ndcg_at_k, recall_at_k, reciprocal_rank_at_k

# Chunking


def test_short_text_is_one_chunk_and_whitespace_is_none() -> None:
    assert [c.text for c in chunk("One sentence. Two sentences.")] == ["One sentence. Two sentences."]
    assert chunk("   \n\n  ") == []


def test_chunks_break_on_sentences_and_repeat_the_last_one_as_overlap() -> None:
    text = "Alpha beta gamma. Delta epsilon zeta. Eta theta iota. Kappa lambda mu."

    chunks = chunk(text, max_words=6, overlap_sentences=1)

    assert [c.text for c in chunks] == [
        "Alpha beta gamma. Delta epsilon zeta.",
        "Delta epsilon zeta. Eta theta iota.",
        "Eta theta iota. Kappa lambda mu.",
    ]
    assert [c.ordinal for c in chunks] == [0, 1, 2]


def test_a_sentence_longer_than_the_budget_is_cut_on_words() -> None:
    chunks = chunk(" ".join(f"w{i}" for i in range(25)) + ".", max_words=10, overlap_sentences=0)

    assert [len(c.text.split()) for c in chunks] == [10, 10, 5]


def test_unchanged_text_keeps_its_hash_so_its_embedding_can_be_reused() -> None:
    before = chunk("Stays the same. Changes here.", max_words=3, overlap_sentences=0)
    after = chunk("Stays the same. Changed now.", max_words=3, overlap_sentences=0)

    assert before[0].content_hash == after[0].content_hash
    assert before[1].content_hash != after[1].content_hash


words = st.text(alphabet="abcdefgh", min_size=1, max_size=8)
sentences = st.lists(words, min_size=1, max_size=30).map(lambda ws: " ".join(ws).capitalize() + ".")


@given(st.lists(sentences, min_size=1, max_size=40), st.integers(min_value=5, max_value=60), st.integers(0, 2))
def test_no_chunk_exceeds_the_budget_and_no_word_is_lost(document: list[str], max_words: int, overlap: int) -> None:
    text = " ".join(document)
    chunks = chunk(text, max_words=max_words, overlap_sentences=overlap)

    assert all(len(c.text.split()) <= max_words for c in chunks)
    covered = " ".join(c.text for c in chunks).split()
    assert set(text.split()) <= set(covered)
    if overlap == 0:
        assert covered == text.split(), "without overlap, the chunks are the text, in order"


# Fusion


def test_rrf_rewards_agreement_between_retrievers() -> None:
    fused = reciprocal_rank_fusion({"lexical": ["a", "b", "c"], "vector": ["c", "a", "d"]}, k=60)

    assert [f.key for f in fused] == ["a", "c", "b", "d"]
    assert fused[0].ranks == {"lexical": 1, "vector": 2}
    assert fused[0].score == pytest.approx(1 / 61 + 1 / 62)


def test_rrf_weights_tilt_toward_one_retriever() -> None:
    rankings = {"lexical": ["a", "b"], "vector": ["b", "a"]}

    assert reciprocal_rank_fusion(rankings, weights={"lexical": 2.0})[0].key == "a"
    assert reciprocal_rank_fusion(rankings, weights={"vector": 2.0})[0].key == "b"


def test_rrf_counts_a_duplicate_once_at_its_better_rank_and_breaks_ties_by_first_seen() -> None:
    fused = reciprocal_rank_fusion({"lexical": ["a", "a", "b"], "vector": ["b", "a"]})

    assert fused[0].ranks == {"lexical": 1, "vector": 2}
    tie = reciprocal_rank_fusion({"one": ["x"], "two": ["y"]})
    assert [f.key for f in tie] == ["x", "y"]


# Metrics


def test_ndcg_is_one_for_the_ideal_ranking_and_matches_a_hand_computation() -> None:
    relevant = {"a": 3.0, "b": 1.0}

    assert ndcg_at_k(["a", "b", "x"], relevant, 10) == pytest.approx(1.0)
    swapped = (1 + 7 / math.log2(3)) / (7 + 1 / math.log2(3))
    assert ndcg_at_k(["b", "a"], relevant, 10) == pytest.approx(swapped)
    assert ndcg_at_k(["x", "y"], relevant, 10) == 0.0


def test_recall_and_reciprocal_rank_only_look_at_the_top_k() -> None:
    relevant = {"a": 1.0, "b": 1.0}
    ranking = ["x", "a", "y", "b"]

    assert recall_at_k(ranking, relevant, 2) == 0.5
    assert recall_at_k(ranking, relevant, 4) == 1.0
    assert reciprocal_rank_at_k(ranking, relevant, 10) == 0.5
    assert reciprocal_rank_at_k(ranking, relevant, 1) == 0.0

from fathom.embedding import HashingEmbedder, in_length_order


def test_length_ordered_batches_come_back_in_the_original_order() -> None:
    texts = ["a" * 9, "b", "c" * 5, "d" * 2, "e" * 7]
    batches: list[list[str]] = []

    def embed(batch: list[str]) -> list[list[float]]:
        batches.append(batch)
        return [[float(len(t)), float(ord(t[0]))] for t in batch]

    vectors = in_length_order(texts, embed, 2)

    assert [row[1] for row in vectors.tolist()] == [ord(t[0]) for t in texts]
    assert batches == [["b", "dd"], ["ccccc", "eeeeeee"], ["aaaaaaaaa"]]


def test_hashing_vectors_are_unit_length_and_deterministic() -> None:
    embedder = HashingEmbedder()
    first = embedder.embed_passages(["the same words", "other words"])
    again = embedder.embed_passages(["the same words", "other words"])

    assert (first == again).all()
    assert abs(float((first[0] ** 2).sum()) - 1.0) < 1e-5
    assert embedder.embed_passages([]).shape == (0, 384)

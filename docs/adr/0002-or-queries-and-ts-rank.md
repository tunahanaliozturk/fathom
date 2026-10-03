# 2. Text queries are OR queries, ranked by ts_rank

## Context

Postgres has two ways to turn user text into a full-text query that ships with it, `plainto_tsquery` and
`websearch_to_tsquery`, and both AND the words together. That suits a search box where people type keywords. It does not
suit questions: "who designed the eiffel tower" requires a document to contain "design", "eiffel" and "tower", and a
paragraph that says "the tower was built by Gustave Eiffel's company" is never returned at all.

Postgres also has two ranking functions, `ts_rank` (term frequency) and `ts_rank_cd` (cover density: how close together
the matched terms sit).

## Decision

Parse with `plainto_tsquery` (stemming, stop words), then join the lexemes with OR instead of AND. Rank with `ts_rank`,
normalised by `1 + log(length)` (flag 1), so long chunks do not win just by containing more words.

The choice of ranker was not a guess. On the evaluation set (docs/evaluation.md):

| lexical ranker | nDCG@10 | Recall@10 |
|---|---|---|
| `ts_rank`, normalisation 1 | 0.846 | 0.958 |
| `ts_rank`, normalisation 0 | 0.855 | 0.953 |
| `ts_rank_cd`, normalisation 1 | 0.600 | 0.825 |

`ts_rank_cd` collapses with OR queries: cover density rewards documents where all query terms appear close together,
and with an OR query most good matches contain only some of the terms. Normalisation 0 scores slightly higher on
nDCG@10 alone, but it scores the same in hybrid mode and slightly lower on recall, and without length normalisation a
long chunk outranks a short precise one; flag 1 stays.

## Consequences

- The text retriever finds paragraphs that share only some words with the question, which is what fusion needs from it.
- An OR query matches many more rows than an AND query, and every match is ranked. The GIN index finds them; ranking is
  the cost, and it makes the text retriever the slower half of a hybrid search: 37 ms median against 23 ms for vectors
  on 11,000 chunks under load (docs/benchmark-results/2026-10-04-laptop.md).
- A query of stop words only becomes an empty query and finds nothing by text, without an error; vectors still answer.

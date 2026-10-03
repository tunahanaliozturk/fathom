# 3. Reciprocal rank fusion, in the application

## Context

Two retrievers return two ranked lists with scores on unrelated scales: a `ts_rank` value that depends on document
length and term counts, and a cosine distance. Combining the raw scores means normalising one against the other, and
whatever normalisation is chosen, it shifts with the corpus, the query length and the model.

## Decision

Reciprocal rank fusion: each retriever contributes its top `candidates` (50) chunks, and a chunk scores
`sum(weight / (k + rank))` over the lists it appears in. Only ranks are used. It runs in Python (`fusion.py`, a pure
function with its own tests), after the two retrievers run concurrently on two connections. Then the best chunk per
document is kept and only the winners' text and highlighted snippets are read from the database.

`k` is set from measurement, not from the paper's default of 60. Hybrid nDCG@10 (docs/evaluation.md):

| k | CI profile (400 questions, 2,067 passages) | full profile (2,000 questions, 10,067 passages) |
|---|---|---|
| 10 | 0.903 | 0.851 |
| 30 | 0.897 | 0.846 |
| 60 | 0.894 | 0.844 |
| 100 | 0.893 | not run |

Smaller `k` trusts the top of each list more. Both profiles prefer 10, so 10 is the default
(`FATHOM_RRF_K`), and the CI baseline was recorded with it. The differences are small, about the size of the CI
profile's standard error, which is why the decision waited for the full profile.

Equal weights. Doubling the text retriever's weight changed nothing measurable (0.894); doubling the vector retriever's
made things worse (0.875).

## Consequences

- `explain: true` returns each hit's rank in each retriever, because that is all the fusion used.
- Fusion is unit-tested without a database, and the SQL stays two plain top-N queries that the planner can serve from
  their indexes.
- A chunk that one retriever ranks first and the other does not return at all can lose to a chunk both rank in the
  middle. That is RRF's bias toward agreement, and on this data it is the right bias.

## Alternatives

- **Fusing in SQL** with a full outer join of two CTEs. One round trip fewer, but the logic becomes untestable on its
  own, and the explain output harder to produce.
- **Score normalisation** (min-max per query, then a weighted sum). Sensitive to outliers in each list, and the weights
  do not transfer between corpora.

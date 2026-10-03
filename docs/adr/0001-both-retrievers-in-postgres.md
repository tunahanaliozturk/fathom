# 1. Both retrievers live in Postgres

## Context

Hybrid search needs a full-text index and a vector index. The common setup is Elasticsearch or OpenSearch for text plus
a vector database (Qdrant, Weaviate, Pinecone) for embeddings, with the application keeping the two in step with the
source of truth. That is two more stateful systems, two more consistency problems ("the document was deleted, but its
vector is still returned"), and a dual write on every change.

## Decision

Postgres holds the documents, a generated `tsvector` column with a GIN index for text, and a `vector(384)` column with
an HNSW index (pgvector 0.8) for meaning. A document, its chunks, their text index and their vectors change in one
transaction, or not at all.

## Consequences

- A delete or an update is visible to both retrievers at the same moment. There is no sync job and no window of drift.
- Metadata filters are a `jsonb @>` predicate in both queries, served by one GIN index, rather than two filter
  languages kept equivalent by hand.
- Postgres full-text ranking is not BM25. ADR 2 covers how much that matters, measured.
- One Postgres primary is the ceiling for writes and for the vector index's memory. At the sizes this is built for
  (up to a few million chunks) that is comfortable; beyond, a dedicated engine starts to earn its keep.

## Alternatives

- **Elasticsearch plus a vector store.** Better lexical ranking out of the box (BM25), much more to run, and the
  consistency problem above.
- **ParadeDB's pg_search for BM25 inside Postgres.** Its licence is AGPL-3.0, which the licence policy for these
  repositories does not allow.
- **Vectors only.** Simpler, and measurably worse: on the evaluation set vector-only search scores 0.816 nDCG@10 against
  0.846 for text-only and 0.903 for both (docs/evaluation.md).

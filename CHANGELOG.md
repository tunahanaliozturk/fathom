# Changelog

## 0.1.0 (2026-10-04)

First release.

- Documents in collections over HTTP, chunked on sentence boundaries with overlap; unchanged documents are no-ops and
  edits re-embed only changed chunks.
- Lexical search (OR query over stemmed words, `ts_rank`), vector search (pgvector HNSW, iterative scans for filters),
  and hybrid search fused by reciprocal rank (k = 10, chosen by measurement), one chunk per document, highlighted
  snippets, per-retriever ranks on request.
- Indexer processes that lease work, embed with no transaction open, and scale out.
- Scoped API keys stored as hashes.
- `fathom eval` on SQuAD 1.1 with a CI gate on nDCG@10; search load and embedding benchmarks.

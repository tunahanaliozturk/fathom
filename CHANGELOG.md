# Changelog

## 0.2.0 (2026-10-13)

A browser console, and what it needs. Search results and the HTTP API are unchanged.

- `web/`: a page that shows, for one query, what the lexical and the vector retriever each found and how fusion
  ranked the two lists. Search as you type with the query and the mode in the address; a three-way comparison with
  each fused result's score worked out; an index status line.
- `docker compose up --build --wait` now also seeds a `demo` collection with this repository's documentation and
  serves the console on <http://127.0.0.1:8340>. The browser holds no key: nginx adds a read-only one, forwards two
  routes of that collection, refuses everything else under `/api/` and rate-limits searches per client address.
- `tools/seed.py` (the seed step), `tools/openapi.py` (writes `docs/openapi.json` without a database), and
  `corpus/glossary.md`.
- The image has a directory its non-root user may write, `/var/lib/fathom`. Nothing but the seed step uses it.
- CI: type-check, lint, format, licences and audit for the console; unit and component tests with coverage
  thresholds; bundle budgets and Lighthouse; a scan of the web image; a contract job that fails when the OpenAPI
  document or the generated types are stale; browser journeys in Chromium and Firefox against the compose stack.

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

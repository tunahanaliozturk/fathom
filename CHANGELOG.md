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

Fixed before release, from review:

- The web container accepted a key file whose first line was a key and whose second line was nginx configuration,
  and wrote both into its configuration. It now accepts exactly one key.
- Guillemets that belong to a document were taken for the API's match markers, so "« and »" lost its marks and
  gained a highlight. A match is now one token.
- Choosing an example from the keyboard, or pressing "Search again", left focus on nothing. It goes to the query box.
- Text typed in the last 300 ms before a click on the other view was dropped.
- While another mode or query was loading, the previous answer was described in the new one's terms ("not run"
  became "not in its top 50", an empty lexical answer became "no passage has a vector yet"), and the comparison
  could show one query's lexical list beside another query's fused list.
- A query of nothing but spaces was searched.
- The proxy's own 404, 429 and 503 had no content security policy or Referrer-Policy, and a 404 for a missing file
  under `/assets/` was marked immutable for a year.
- The access log recorded every query, because the query is in the address.
- The 429 for the counts route said that ten searches a second are allowed. The counts route now has the same
  allowance as search, in its own bucket, after two a second proved too few for several page loads at once.
- A truncated list of seeded sections made every later start fail, and a failed delete was forgotten.
- A tab left open across a deploy could not open the other view, and said nothing. It reloads once.
- Comparison rows had accessible names put together from fragments, cut-off names had no full text, and pinning a
  row was not announced.
- The worked score did not say that its figures are rounded, and some sums looked wrong by one in the last digit.
- The glossary said that "ran" stems to the same term as "runs", and that a passage outside the lexical
  retriever's 50 candidates is lost to fusion.
- Lighthouse was judged by its best run of three, not the median.

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

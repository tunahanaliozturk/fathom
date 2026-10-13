# fathom

[![ci](https://github.com/tunahanaliozturk/fathom/actions/workflows/ci.yml/badge.svg)](https://github.com/tunahanaliozturk/fathom/actions/workflows/ci.yml)

Hybrid search on plain Postgres, with an evaluation harness that fails the build when relevance drops.

Documents go in over HTTP. Each is chunked on sentence boundaries and stored with a full-text index and, a few seconds
later, a vector from a small local model. A query runs both retrievers at once (an OR query over stemmed words, and an
HNSW nearest-neighbour search), fuses the two rankings by rank, keeps the best chunk per document, and returns
highlighted snippets. Everything lives in one Postgres database: no Elasticsearch, no vector store, nothing to keep in
sync.

What makes it more than a demo is that every ranking decision was measured, and is measured again on every push.

## Try it in a browser

Needs Docker, and nothing else: no key to create, nothing to paste.

```sh
docker compose up --build --wait
```

Then open <http://127.0.0.1:8340>. The stack indexes this repository's own documentation as a demo collection and
waits until every chunk has a vector before it reports healthy.

![The comparison view: one query run three ways, with lines from each retriever's list to the fused list](docs/images/compare.png)

The page shows one thing: for the same query, what each retriever found, and how fusion turned two rankings into one.

- **Search** returns results as you type, in the mode you pick, each with its rank in the lexical and in the vector
  retriever. The query and the mode are the address, so a search is a link.
- **Compare** runs the query three ways. A line joins each fused result to the place it held in each retriever's
  list; a result one retriever never returned has no line on that side. Under the picture, the selected passage's score
  is worked out: 1 / (10 + rank) from each retriever, added.
- Four example queries are picked so that the retrievers disagree: a paraphrase that shares no word with its answer,
  an exact number that only the lexical retriever puts first, a question each retriever answers differently, and one
  where they agree.

The browser never holds an API key. nginx, in the web container, adds a read-only key for that one collection, forwards
two routes and refuses the rest, and limits how fast one address may search
([ADR 8](docs/adr/0008-the-web-proxy-holds-the-read-key.md)). How the corpus gets there is
[ADR 9](docs/adr/0009-the-demo-corpus-is-this-repository.md), and how the page is built is
[ADR 10](docs/adr/0010-the-browser-client.md).

## Relevance

SQuAD 1.1 as a retrieval task: find the one paragraph that answers each question. Full method and every experiment in
[docs/evaluation.md](docs/evaluation.md).

| | lexical only | vector only | **hybrid** |
|---|---|---|---|
| nDCG@10, 400 questions over 2,067 passages (the CI gate) | 0.846 | 0.816 | **0.903** |
| nDCG@10, 2,000 questions over 10,067 passages | 0.768 | 0.766 | **0.851** |
| Recall@10, 2,000 questions over 10,067 passages | 0.877 | 0.902 | **0.954** |

Things the measurements decided, each in an ADR with its table:

- Postgres' own query parsers AND the words of a question together; fathom ORs them, because a question shares only
  some words with its answer. Ranking those OR queries with `ts_rank_cd` instead of `ts_rank` drops lexical nDCG from
  0.846 to 0.600 ([ADR 2](docs/adr/0002-or-queries-and-ts-rank.md)).
- Reciprocal rank fusion with k = 10 beats the usual k = 60 on both profiles
  ([ADR 3](docs/adr/0003-reciprocal-rank-fusion-in-the-application.md)).
- Sorting each embedding batch by length doubled indexing throughput
  ([ADR 6](docs/adr/0006-a-small-onnx-model-on-the-cpu.md)).

CI runs the CI profile with the real model on every push and fails if any mode's nDCG@10 falls more than 0.01 below
[eval/baseline.json](eval/baseline.json) ([ADR 4](docs/adr/0004-relevance-is-a-build-gate.md)). Switching the ranker
to `ts_rank_cd`, for instance, fails it:

```
REGRESSION lexical: nDCG@10 0.6003 is below the baseline 0.8462
REGRESSION hybrid: nDCG@10 0.8239 is below the baseline 0.9032
```

## Speed

On a laptop (Core Ultra 7 255H, Postgres in Docker Desktop), 11,122 chunks, 16 concurrent clients
([details](docs/benchmark-results/2026-10-04-laptop.md)):

| | searches/s | p50 | p99 |
|---|---|---|---|
| hybrid | 209 | 65 ms | 224 ms |
| vector only | 681 | 23 ms | 38 ms |
| lexical only | 353 | 37 ms | 144 ms |

Plus about 19 ms to embed the query. The model is the slow part of indexing: about 18 paragraphs a second per indexer
process on that laptop, which is why writes never wait for it.

## Quick start with the API

Needs Docker. The image carries the model, so nothing is downloaded at run time. The API listens on
<http://127.0.0.1:8300>.

```sh
docker compose up --build --wait
docker compose run --rm api keys create --collections '*' --scopes read,write --label laptop
```

The second command prints an API key, once. Paste it into [requests.http](requests.http) and work through it, or run
the same walk-through as a script:

```sh
uv run --no-project python tools/smoke.py fth_...
```

## How it works

```mermaid
sequenceDiagram
    participant C as client
    participant A as API
    participant P as Postgres
    participant I as indexer
    C->>A: POST documents
    A->>P: chunk, upsert (chunks with no vector yet), NOTIFY
    A-->>C: 202, searchable by text already
    P-->>I: NOTIFY
    I->>P: lease a batch of chunks without vectors
    Note over I: embed, no transaction open
    I->>P: store the vectors
    C->>A: POST search
    par concurrently
        A->>P: OR query on the tsvector, ts_rank, top 50
    and
        A->>P: HNSW cosine search, top 50
    end
    Note over A: reciprocal rank fusion, best chunk per document
    A->>P: read the winners and their snippets
    A-->>C: hits, with each one's rank in each retriever if asked
```

- **One database** for documents, text index and vectors, so a delete or an update reaches both retrievers in the same
  transaction ([ADR 1](docs/adr/0001-both-retrievers-in-postgres.md)).
- **Writes never wait for the model.** Indexers lease work, embed with no transaction open, and write back only if the
  chunk is still the one they embedded. Rewriting a document re-embeds only the chunks whose text changed
  ([ADR 5](docs/adr/0005-embeddings-are-asynchronous.md)).
- **Keys** are scoped to collections and to read or write, stored as SHA-256 digests, compared in constant time; a key
  that cannot reach a collection gets 404, not 403 ([ADR 7](docs/adr/0007-scoped-api-keys.md)).

## What the tests hold it to

| promise | test |
|---|---|
| Hybrid relevance does not regress | the `relevance` CI job, against `eval/baseline.json` |
| A write does not wait for the model, and a vector computed for replaced text is never stored | `test_a_write_does_not_wait_for_the_model` |
| Editing one paragraph re-embeds one chunk; a document with repeated paragraphs can still be edited | `test_editing_one_paragraph_re_embeds_only_that_chunk`, `test_editing_a_document_with_two_identical_paragraphs_works` |
| Two indexers never embed the same chunk; a failed batch is retried | `test_two_indexers_share_the_backlog_and_embed_each_chunk_once`, `test_a_batch_whose_embedding_fails_stays_pending_for_the_next_attempt` |
| A key reaches only its collections and scopes; revoked keys stop working | `test_a_key_reaches_only_its_collections_and_scopes`, `test_a_revoked_key_stops_working` |
| A metadata filter applies inside both retrievers | `test_a_metadata_filter_applies_to_both_retrievers` |
| Chunks never exceed their budget and lose no words | `test_no_chunk_exceeds_the_budget_and_no_word_is_lost` (Hypothesis) |
| The browser never sends or receives an API key | `the page never sends or receives an API key` (Playwright, real stack) |
| The proxy forwards two routes of one collection, refuses the rest, limits the rate, and sends the same security headers with every answer | the eight tests in `web/e2e/proxy.spec.ts` |
| The web container starts only with a key file that is one key and nothing else | `test_a_good_first_line_does_not_let_a_second_line_into_the_configuration`, and a CI step against the image |
| The seed step deletes what left the corpus, keeps the proxy's key, and revokes its own | `tests/unit/test_seed_run.py` |
| What people search for is not written to the proxy's log | the `quickstart` CI job sends a marked query and looks for it |
| Text from a document is shown as text, never run | `shows markup inside a document as text and never builds an element from it` |
| A change to a response field fails the build | the `contract` CI job and the type-check ([ADR 10](docs/adr/0010-the-browser-client.md)) |
| A query that has been replaced has its request cancelled | `cancels the request for a query that has been replaced` |
| Each example query on the page does what the page says | `each example query does what the page says it does` (Playwright, real stack) |

Before the first release, a review set on breaking it found eleven problems; each fix came with one of the tests above.

## Running the checks

```sh
uv sync
uv run ruff check . && uv run ruff format --check .
uv run mypy src tests benchmarks
uv run lint-imports                      # chunking, fusion and the metrics may not touch the database or the model
uv run pytest tests                      # needs Docker: pgvector runs in a container
uv run python tools/license_audit.py     # every installed distribution must be permissively licensed
```

The console has its own, in `web/` (Node 24):

```sh
npm ci
npm run type-check && npm run lint && npm run format:check
npm run test:unit                        # Vitest and Testing Library; fails below the coverage it holds today
npm run build && npm run size            # fails above the bundle budgets
npm run lighthouse                       # fails below performance 0.95 or accessibility 1.0
npm run licences && npm audit --audit-level=high
npx playwright install chromium firefox
npx playwright test                      # needs the compose stack up: the real API, model and corpus
```

And one check that spans both: the OpenAPI document and the types generated from it must be what the code produces.

```sh
uv run python tools/openapi.py && npm --prefix web run generate:api && git diff --exit-code
```

### The console, measured

Measured on 2026-10-14 on the laptop in [the benchmark run](docs/benchmark-results/2026-10-04-laptop.md). Lighthouse
has not been run on a CI runner.

| | measured | the build fails beyond |
|---|---|---|
| First load of the search view, script and style, gzip (`npm run size`) | 80.5 kB | 88 kB |
| Comparison view, added to that | 5.3 kB | 6 kB |
| Lighthouse performance, built page, mobile profile, simulated throttling, each of 3 runs | 0.99 | 0.95 at the median |
| Lighthouse accessibility, same runs | 1.0 | 1.0 |
| Largest contentful paint, same runs | 1.90, 1.88 and 1.88 s | 2.5 s at the median |
| Cumulative layout shift, same runs | 0 | 0.1 |
| Unit and component tests (`npm run test:unit`) | 86, covering 98.94% of statements and 93.44% of branches | 98% and 93% |
| Journeys against the compose stack (`npx playwright test`) | 26 in Chromium, 26 in Firefox, 8 against the proxy | any failure, any axe violation |

## Limitations

- English only (the `english` text search configuration and an English model).
- Postgres text ranking is not BM25 (ADR 2 measures what that costs here).
- Vectors lag writes by however long the indexers take; text search covers the gap.
- SQuAD questions share vocabulary with their answers, which flatters lexical search. The numbers compare versions of
  this system; they are not a claim about other data.
- The console's proxy makes one collection readable by anyone who can reach its port. That suits a demo of public
  documentation and nothing private (ADR 8). The console is read-only, light theme only, and shows ten results.

[docs/operations.md](docs/operations.md) has the configuration table, what to watch, and the runbooks.

## Licence

MIT for the code. The evaluation downloads SQuAD 1.1 (CC BY-SA 4.0) at run time and never stores it in the repository.
The demo corpus is this repository's own documentation and `corpus/glossary.md`, both MIT. The default model,
`BAAI/bge-small-en-v1.5`, is MIT. Every Python and npm dependency, at every depth, is permissively licensed, and CI
checks both.

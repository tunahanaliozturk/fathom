# Operations

## Processes

| command | what it does | how many |
|---|---|---|
| `fathom migrate` | creates the `vector` extension and the schema, under an advisory lock, then exits | once per deploy, first |
| `fathom api --host --port` | the HTTP API; embeds each query with the model it loads at start-up | as many as you like |
| `fathom indexer` | embeds chunks that have no vector yet | as many as the CPU budget allows; they share the backlog |
| `fathom keys create / revoke` | manages API keys; `create` prints the key once | by hand |
| `fathom eval` | measures relevance on SQuAD; with `--baseline`, exits 1 on a regression | in CI, and before changing a ranking default |

The compose stack adds two things that are not part of the service:

| service | what it does | how many |
|---|---|---|
| `seed` | `tools/seed.py`, in the fathom image: creates the console's read key, sends the demo corpus through the API, waits until `pending` is 0, runs one search, exits | once per `docker compose up` |
| `web` | nginx: serves the console and proxies two routes of the `demo` collection with that key | one |

## Configuration

| variable | default | meaning |
|---|---|---|
| `FATHOM_DATABASE_URL` | required | `postgresql://user:password@host:port/db`; the database needs pgvector 0.8 or later |
| `FATHOM_POOL_SIZE` | 10 | connections per process; a hybrid search holds two at once |
| `FATHOM_EMBEDDING_MODEL` | `BAAI/bge-small-en-v1.5` | any fastembed model that produces 384-dimensional vectors |
| `FATHOM_MODEL_CACHE_DIR` | fastembed's default | where the model files are; the image sets `/models` and works offline |
| `FATHOM_EMBEDDING_THREADS` | onnxruntime's default | threads per embedding call |
| `FATHOM_CHUNK_MAX_WORDS` | 180 | chunk size budget; changing it changes what is embedded, so re-run the evaluation |
| `FATHOM_CHUNK_OVERLAP_SENTENCES` | 1 | sentences repeated at the start of the next chunk |
| `FATHOM_CANDIDATES` | 50 | how many each retriever contributes before fusion |
| `FATHOM_EF_SEARCH` | 100 | HNSW search breadth; never below `FATHOM_CANDIDATES` |
| `FATHOM_RRF_K` | 10 | fusion damping, chosen by measurement (ADR 3); re-run the evaluation before changing it |
| `FATHOM_INDEXER_BATCH` | 64 | chunks an indexer claims and embeds per transaction |
| `FATHOM_INDEXER_IDLE_WAIT_SECONDS` | 5 | longest an idle indexer waits without a NOTIFY before looking again |
| `FATHOM_KEY_CACHE_SECONDS` | 10 | how long a verified key is trusted without a lookup; also the longest a revoked key keeps working |
| `FATHOM_MAX_PAYLOAD_BYTES` | 4 MiB | largest request body |
| `FATHOM_OTLP_ENDPOINT` | unset | base URL of an OTLP/HTTP collector; traces and metrics are off without it |
| `FATHOM_LOG_LEVEL` | INFO | JSON logs on stdout |

The console's proxy has its settings in `web/nginx.conf`, not in the environment:

| setting | value | raising it | lowering it |
|---|---|---|---|
| `limit_req_zone ... zone=search rate=` | 10 requests a second per client address, burst 30 | one address can put more load on the API | the comparison view, which sends three searches per pause in typing, starts getting 429s |
| `limit_req_zone ... zone=stats rate=` | 2 requests a second per client address, burst 10 | more polling of a query that counts rows | the status line shows "unavailable" on busy shared addresses |
| `client_max_body_size` | 8 KB | larger filters and queries reach the API | a 1,000-character query in a multi-byte script is refused with 413 |
| `proxy_read_timeout` | 15 seconds | a stuck API holds a connection longer | a slow first search after a restart, while the model loads, is cut off with 503 |
| the collection | `demo`, written into both `location =` lines and their `proxy_pass` | | |

## What to watch

| signal | why | alert when |
|---|---|---|
| backlog: `select count(*) from fathom_chunks where embedding is null` | chunks findable by text but not by meaning | growing for 15 minutes; add indexers |
| `fathom.embed.batch.duration` | the model's speed; it is most of an indexer's time | p95 well above its usual value (CPU contention) |
| `fathom.search.duration` by mode | user-facing latency | p95 above your budget for 10 minutes |
| `fathom.searches` | traffic | as a denominator for everything else |
| `pg_stat_user_indexes` for `fathom_chunks_embedding` | the HNSW index must fit in memory to be fast | index size approaching `shared_buffers` plus page cache |

## Runbooks

**Indexing is behind.** Each indexer embeds roughly 9 to 18 average paragraphs a second on a laptop core set; check
`fathom.embed.batch.duration` first. Start more indexer processes (they share work through `SKIP LOCKED`), or give each
more threads. Searches keep working from text in the meantime.

**Results got worse after a deploy.** Run `fathom eval --profile ci --baseline eval/baseline.json` against the deployed
configuration. CI runs the same check, so a regression usually means configuration drift (`FATHOM_RRF_K`,
`FATHOM_CHUNK_MAX_WORDS`, a different model), not code.

**Changing the model or the chunk size.** Both change what is stored. Set the new value, then clear the vectors so the
indexers rebuild them: `update fathom_chunks set embedding = null`. For the chunk size, re-send the documents instead:
the document hash covers the chunking, so a re-send with new settings is not mistaken for a no-op. Expect
the backlog alert while they catch up.

**A key leaked.** `fathom keys revoke <id>` (the id is the part after `fth_`). It stops working everywhere within
`FATHOM_KEY_CACHE_SECONDS`.

**The console says "The server refused the search (401 Unauthorised)".** The proxy's key is no longer accepted: it was
revoked, or the database volume was replaced while the key volume was kept. Confirm with
`docker compose exec web wget -q -O - http://127.0.0.1:8080/api/v1/collections/demo/stats`, which prints the counts
when the key works and fails with `401` when it does not. Then:

```sh
docker compose run --rm seed   # sees the key refused, creates another, writes it to the volume
docker compose restart web     # nginx reads the key only when it starts
```

The same wget prints the counts afterwards. Do not edit the key file by hand: the web container refuses to start on
anything that is not shaped like a key, by design.

**The web container exits at start with "read.key is missing" or "does not hold an API key".** The seed step did not
finish. `docker compose logs seed` says why: usually the API was not reachable, or the indexer did not embed the
corpus within the seed step's ten minutes ("the indexer did not finish"), in which case see "Indexing is behind".

**The console says "Too many searches".** One address sent more than 10 searches a second for longer than the burst
allows. Behind Docker Desktop, or any proxy that hides client addresses, all clients count as one address
(`docker compose logs web | grep " 429 "` shows the requests). Waiting three seconds refills the burst. Raising the
rate in `web/nginx.conf` raises what one caller may cost the API; if real clients sit behind a trusted proxy, set
`set_real_ip_from` and `real_ip_header` instead.

**The demo returns a section that no longer exists, or misses a new one.** The corpus is read when the stack starts.
`docker compose run --rm seed` runs the seed step again: it writes changed sections, deletes the ones that are gone,
prints how many of each, and returns when the indexer has caught up.

## Known limitations

- **English only.** The text index uses Postgres' `english` configuration and the default model is English.
- **Postgres ranking is not BM25.** Measured in ADR 2; good enough here, not state of the art.
- **Vectors lag writes** by however long the indexers take (ADR 5).
- **One database.** The HNSW index needs memory roughly proportional to the number of chunks; a few million chunks of
  384 floats is a few gigabytes.
- **Snippets are plain text** with « and » around matches. They are not HTML-escaped: escape them before rendering.
- **The evaluation is SQuAD**, whose questions share many words with their answers. It is a regression gate for this
  code, not a claim about other corpora (ADR 4).
- **The console is a demo of one collection.** Its proxy lets anyone who reaches the port read `demo`, its rate limit
  is per address as nginx sees it, and the page assumes the default `FATHOM_RRF_K` and `FATHOM_CANDIDATES` when it
  works out a score (ADR 8, ADR 10).

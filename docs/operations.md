# Operations

## Processes

| command | what it does | how many |
|---|---|---|
| `fathom migrate` | creates the `vector` extension and the schema, under an advisory lock, then exits | once per deploy, first |
| `fathom api --host --port` | the HTTP API; embeds each query with the model it loads at start-up | as many as you like |
| `fathom indexer` | embeds chunks that have no vector yet | as many as the CPU budget allows; they share the backlog |
| `fathom keys create / revoke` | manages API keys; `create` prints the key once | by hand |
| `fathom eval` | measures relevance on SQuAD; with `--baseline`, exits 1 on a regression | in CI, and before changing a ranking default |

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

## Known limitations

- **English only.** The text index uses Postgres' `english` configuration and the default model is English.
- **Postgres ranking is not BM25.** Measured in ADR 2; good enough here, not state of the art.
- **Vectors lag writes** by however long the indexers take (ADR 5).
- **One database.** The HNSW index needs memory roughly proportional to the number of chunks; a few million chunks of
  384 floats is a few gigabytes.
- **Snippets are plain text** with « and » around matches. They are not HTML-escaped: escape them before rendering.
- **The evaluation is SQuAD**, whose questions share many words with their answers. It is a regression gate for this
  code, not a claim about other corpora (ADR 4).

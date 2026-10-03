# 5. Embedding happens after the write, in separate indexer processes

## Context

The embedding model is CPU-bound and slow next to everything else: about 18 paragraphs a second on a laptop
(docs/benchmark-results). Embedding inside the write request would make a 100-document batch take five seconds and tie
a web worker's CPU to it.

## Decision

A write stores the document and its chunks with no vector, in one transaction, and returns 202. The chunks are
searchable by text immediately. `fathom indexer` processes claim chunks without a vector in batches
(`FOR UPDATE SKIP LOCKED`, so several indexers never take the same chunk), embed them off the event loop, and write the
vectors in the same transaction. `NOTIFY` wakes an idle indexer when a write leaves work.

Rewriting a document keeps the vector of every chunk whose text (and title, which is part of what gets embedded) did not
change, inside the same statement that replaces the chunks. Sending an unchanged document is a no-op.

## Consequences

- Write latency does not depend on the model, and indexing throughput scales with the number of indexer processes.
- Between the write and the indexer catching up, a new chunk is found by text but not by meaning. `GET .../stats` shows
  the backlog (`pending`) and docs/operations.md has the alert for it.
- A crashed indexer's transaction rolls back and its batch is claimed again (`test_a_batch_whose_embedding_fails_stays_
  pending_for_the_next_attempt`).
- Editing one paragraph of a long document costs one embedding, not one per chunk
  (`test_editing_one_paragraph_re_embeds_only_that_chunk`).

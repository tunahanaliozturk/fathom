# 4. Relevance is a build gate

## Context

Every change to chunking, the text query, the ranker, fusion, the model or an index parameter changes which results come
back. Unit tests check that the code does what it says. They cannot say whether the results got better or worse, and
search systems usually find out from users.

## Decision

`fathom eval` measures relevance on a fixed task, and CI runs it on every push. The task is SQuAD 1.1 used as retrieval:
each question has exactly one paragraph that answers it, and the system has to put that paragraph near the top among
all the others. The report has nDCG@10, Recall@10, Recall@50, MRR@10 and latency per mode. `eval/baseline.json` holds
the expected scores; CI fails if hybrid, lexical or vector nDCG@10 drops more than 0.01 below them.

Everything goes through the production code paths: documents are chunked and written with `upsert_document`, embedded
by the `Indexer`, and queried with `search`. The dataset is downloaded on first use and refused unless its SHA-256
matches the pinned value, so a changed upstream file cannot move the baseline without anyone noticing. It is never
committed here (CC BY-SA 4.0 data in an MIT repository would need its own licensing story).

## Consequences

- A change that improves relevance updates `eval/baseline.json` in the same pull request, so the improvement is visible
  in review.
- The CI profile (400 questions, 2,067 paragraphs) takes a few minutes on a runner, most of it embedding the
  paragraphs. The model and dataset are cached between runs.
- SQuAD questions were written by people looking at the paragraph, so they share more words with it than real search
  queries do. That flatters the text retriever, and every number here should be read as "on SQuAD", not as general
  truth. The point of the gate is the comparison between versions of this code, which the bias does not affect.
- 400 questions give a standard error of roughly 0.01 on nDCG@10 near 0.9, which is why the tolerance is 0.01 and why
  tuning decisions are checked on the larger `full` profile before they change a default.

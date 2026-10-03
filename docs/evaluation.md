# Evaluation

Every number on this page comes from `fathom eval`, run on the laptop described in
docs/benchmark-results/2026-10-04-laptop.md, with `BAAI/bge-small-en-v1.5` and the default settings unless a row says
otherwise. The raw reports for the defaults are `eval/baseline.json` (CI profile) and the table below (full profile).

## The task

SQuAD 1.1 used as retrieval. Each question was written by someone reading one Wikipedia paragraph, so it has exactly one
relevant passage, and the system has to rank that passage near the top among all the others.

| profile | questions | passages | in CI |
|---|---|---|---|
| `ci` | 400, sampled from the development set | the 2,067 development-set paragraphs | yes, on every push |
| `full` | 2,000, sampled the same way | those, plus 8,000 training-set paragraphs as distractors | by hand |

The sample is seeded, so every run uses the same questions. Measures, averaged over questions: nDCG@10 (the headline),
Recall@10, Recall@50, MRR@10, and search latency at 8 concurrent queries.

A caveat that matters: SQuAD questions share a lot of vocabulary with their paragraphs, because their authors were
looking at them. That flatters lexical search compared with real user queries. The numbers are for comparing versions of
this system against each other, not for comparing it with systems measured on other data.

## Results with the defaults

| profile | mode | nDCG@10 | Recall@10 | Recall@50 | MRR@10 |
|---|---|---|---|---|---|
| ci | lexical | 0.846 | 0.958 | 0.990 | 0.810 |
| ci | vector | 0.816 | 0.943 | 0.990 | 0.775 |
| ci | **hybrid** | **0.903** | **0.990** | 0.998 | **0.874** |
| full | lexical | 0.768 | 0.877 | 0.964 | 0.733 |
| full | vector | 0.766 | 0.902 | 0.959 | 0.723 |
| full | **hybrid** | **0.851** | **0.954** | 0.982 | **0.818** |

Hybrid beats either retriever alone by 6 to 9 points of nDCG@10, and the margin grows with the distractors: the two
retrievers make different mistakes, and fusion keeps what they agree on. With 10,000 passages, the right one is in
hybrid's top ten for 95 percent of questions.

## What was tried, and what it changed

CI profile, hybrid nDCG@10 unless stated. Each row changes one thing from the defaults of the time (`rrf_k` was 60 when
this sweep ran; the winning value is now the default).

| change | lexical | hybrid | kept? |
|---|---|---|---|
| defaults at the time (`ts_rank`, normalisation 1, RRF k = 60, 50 candidates) | 0.846 | 0.894 | |
| `ts_rank_cd` instead of `ts_rank` | **0.600** | 0.813 | no: cover density punishes OR queries (ADR 2) |
| length normalisation 0 | 0.855 | 0.893 | no: no gain once fused, longer chunks win more |
| length normalisation 32 | 0.855 | 0.893 | no |
| RRF k = 10 | | **0.903** | **yes**, confirmed on full: 0.851 against 0.844 |
| RRF k = 30 | | 0.897 | |
| RRF k = 100 | | 0.893 | |
| lexical weight 2 | | 0.894 | no effect |
| vector weight 2 | | 0.875 | no: worse |
| 20 candidates per retriever instead of 50 | | 0.894 | no measurable loss; 50 kept for headroom on bigger corpora |
| HNSW `ef_search` 40 instead of 100 (vector alone: 0.809 against 0.816) | | 0.891 | no |

The CI profile's standard error on nDCG@10 is about 0.01, so differences smaller than that are noise there; that is
why the RRF change waited for the full profile before becoming the default.

## Running it

```sh
docker compose up -d --wait postgres
export FATHOM_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55435/fathom
uv run fathom migrate
uv run fathom eval --profile ci                                   # build the index once, then score
uv run fathom eval --profile ci --set rrf_k=30                    # try a change; the index is reused
uv run fathom eval --profile ci --baseline eval/baseline.json     # what CI runs; exits 1 on a regression
```

The index is rebuilt automatically when the model, the chunking or the profile changes, and any chunk still missing a
vector is embedded before scoring, so a run never scores a half-built index.

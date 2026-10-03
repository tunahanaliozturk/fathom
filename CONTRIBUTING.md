# Contributing

Thanks for looking. A few things make a change easy to accept.

## Setting up

```sh
uv sync
docker info   # the integration tests start pgvector in a container
```

## What a change needs

- `uv run ruff check .`, `uv run ruff format --check .`, `uv run mypy src tests benchmarks` and `uv run lint-imports`
  clean. CI runs the same.
- A test that fails without the change. Anything touching SQL is tested against Postgres in `tests/integration`.
- **If it can change which results come back** (chunking, the text query, ranking, fusion, the model, an index
  parameter), the output of `fathom eval --profile ci` before and after, in the pull request. If relevance improves,
  update `eval/baseline.json` in the same change; if it drops, explain why that is worth it.
- Defaults that come from measurement are changed only with a measurement on the `full` profile as well, because 400
  questions are too few to trust a difference under 0.01.
- An ADR for any decision someone could reasonably have made differently.
- New dependencies permissively licensed at every depth; `uv run python tools/license_audit.py` checks.

## Commits

Conventional commit subjects (`fix(search): ...`, `feat(api): ...`), one logical change per commit.

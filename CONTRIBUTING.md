# Contributing

Thanks for looking. A few things make a change easy to accept.

## Setting up

```sh
uv sync
docker info   # the integration tests start pgvector in a container
cd web && npm ci   # only for changes to the console; Node 24
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
- New dependencies permissively licensed at every depth; `uv run python tools/license_audit.py` checks, and
  `npm run licences` does the same for the console.
- **If it changes a request or a response**, run `uv run python tools/openapi.py` and
  `npm --prefix web run generate:api`, and commit both files. CI fails if they are stale, and the console's type-check
  fails if it no longer agrees with them.
- **If it changes the console**, `npm run type-check`, `npm run lint`, `npm run format:check` and `npm run test:unit`
  in `web/`, and the journeys (`npx playwright test`) against `docker compose up --build --wait`. A new view gets an
  axe check in `e2e/journeys.spec.ts`. Server answers are parsed in `src/shared/api/fathom.ts` and nowhere else.
- **If it changes the documentation**, remember that the documentation is the demo corpus (ADR 9). The journeys
  assert what the four example queries return, and will say so if an edit moved them.

## Commits

Conventional commit subjects (`fix(search): ...`, `feat(api): ...`), one logical change per commit.

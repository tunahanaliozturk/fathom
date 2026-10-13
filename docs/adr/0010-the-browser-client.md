# 10. The browser client: a generated contract, parsed answers, state in the address

## Context

The console in `web/` is the first TypeScript in a Python repository, and the first client of the API that lives next
to it. Two things go wrong with such a pair. The client's idea of a response drifts from the server's, usually over an
optional field, and nothing notices until a page renders `undefined`. And state that belongs to the server or to the
address ends up copied into a store that then has to be kept in step by hand.

## Decision

**The OpenAPI document is the contract, and it is checked twice.**

- `tools/openapi.py` builds the FastAPI routes without a database and writes `docs/openapi.json`.
  `npm run generate:api` turns that into `web/src/shared/api/schema.d.ts` with openapi-typescript. Both files are
  committed. The `contract` job in CI runs both commands again and fails on any difference.
- Every response is parsed with Zod where it enters the page (`web/src/shared/api/fathom.ts`). There is no `as` at
  that boundary. A type in the same file, `Accepts`, compiles only while everything the generated types say the
  server sends is something the parser accepts; request bodies are typed with the generated types directly.

Renaming `took_ms` to `took_millis` in `SearchResponse` on the server, regenerating, and running the two checks gives
this (the long object types are shortened here):

```
$ git diff --exit-code --stat -- docs/openapi.json web/src/shared/api/schema.d.ts
 docs/openapi.json              | 6 +++---
 web/src/shared/api/schema.d.ts | 4 ++--
 2 files changed, 5 insertions(+), 5 deletions(-)
$ npm run type-check
src/shared/api/fathom.ts(54,59): error TS2344: Type '{ hits: ...; mode: ...; took_millis: number; }' does not satisfy
the constraint '{ mode: ...; took_ms: number; hits: ...; }'.
  Property 'took_ms' is missing in type '{ hits: ...; mode: ...; took_millis: number; }' but required in type ...
```

The first command exits 1 and the second exits 2.

**State lives where it already is.** The query and the mode are the address (`?q=...&mode=...`), read and validated in
`web/src/router.ts`, so a search is a link and the back button works. Server data lives in the TanStack Query cache.
There is no Pinia store, because nothing is global. Typing is debounced by 300 ms, and leaving the box sends what is
in it at once, so text typed just before a click on the other view is not lost. A query that has been replaced has
its request cancelled through the `AbortSignal` the cache hands to `fetch`; the previous results stay on screen,
dimmed, until the next ones arrive, and a live region says "Searching." meanwhile. What stays is described as what it
is: a row keeps the mode its answer came from, an empty previous answer is not called "Nothing matched" for the query
that is still loading, and the comparison keeps the last three lists that belong to one query until all three for
the next one are in (`keeps the last complete picture until all three answers to a new query are in`).

**One origin.** nginx serves the page and proxies the API under `/api/` (ADR 8). The page never sees a key, there is
no CORS, and the content security policy is `default-src 'self'`: no inline script and no inline style, which is why
the comparison is drawn with SVG attributes and classes.

**Snippets are text.** The API marks matches with « and » and does not escape anything. `SnippetText.vue` splits a
snippet into text nodes and `<mark>` elements. `v-html` is not used anywhere and the lint rule that forbids it is an
error. `SnippetText.test.ts` renders a snippet containing an `<img onerror>`, a `<script>` and badly nested markers,
and checks that no element was created from them.

The two marker characters also occur in documents, this one included. The page takes a pair for a match only when
there is no space between them, because the API wraps single tokens; a pair around a phrase, an empty pair or an
unclosed one is shown as the document wrote it (`leaves guillemets that belong to the document alone`, and the
journey `guillemets that belong to a document are shown, not taken for the marks of a match`).

**A view that cannot be fetched reloads the page.** Each view is a file named after its content. A tab left open
across a deploy asks for a name that no longer exists, and the navigation fails without a trace. The router catches
that one error and loads the page again at the address it was going to, once; a note in session storage stops it from
doing so twice for the same address, and where storage is refused it does not reload at all.

## Consequences

- A change to a response field cannot merge unnoticed: the contract job, the type-check or both fail, as above.
- The first load of the search view is 80.5 kB of script and style, gzipped, of which Zod and the query library are
  about 36 kB; the comparison view adds 5.3 kB (`npm run size`, which fails the build above 88 kB and 6 kB).
- Lighthouse on the built page, mobile profile with simulated throttling, three runs, judged by their median:
  performance 0.99, accessibility 1.0, layout shift 0, largest contentful paint 1,897, 1,877 and 1,875 ms against a
  limit of 2,500
  (`npm run lighthouse`). The paint was 2,244 to 2,249 ms until the search view's scripts were named in the HTML
  (`preloadFirstRoute` in `web/vite.config.ts`) and the page was mounted after the first view had arrived; before
  that the browser learned which scripts the view needed only once the entry script had run. It has not been
  measured on a CI runner.
- A snippet from a document that itself contains `«word»`, with no space inside, shows that word as a match. The
  page cannot tell it from one the API marked, and neither could any other client: the markers are plain characters
  with no escape. Changing that is a change to the API's response, not to the page.
- The three lists of the comparison are thirty buttons, and a keyboard user passes all of them between the query box
  and what follows. A roving tabindex would make that three stops. It was not done: focusing a row is what draws its
  path, so tabbing down a list is the keyboard's way of doing what a pointer does by moving over it, and arrow keys
  inside a list of buttons are a convention nothing on the screen announces. The cost is real for someone who only
  wants the examples under the picture; they are also on the search view, before any result.
- Pinning a row rewrites the worked score under the picture. One sentence in a polite live region says which
  passage it now shows; each row has one accessible name, and a name cut short by the column has its full text as a
  title.
- The worked score shows each term and the total to four places and says so, because the rounded terms of some
  rows add up to one less in the last digit than the rounded total (1/13 + 1/14: 0.0769 + 0.0714 against 0.1484).
- Zod runs without its compiled fast path (`z.config({ jitless: true })`). The fast path uses `new Function`, which
  the content security policy forbids, and Zod's test for whether it may use it is itself reported as a violation.
  The journey `the page loads nothing the content security policy refuses` found that.
- The page shows the arithmetic of a fused score, 1 / (10 + rank) per retriever, and for that it carries two of the
  service's settings as constants: 10 for `FATHOM_RRF_K` and 50 for `FATHOM_CANDIDATES`. The API does not report them.
  A stack started with other values would show sums that do not match the score beside them. The journey
  `the comparison shows the same query three ways` checks the sum against the score on the stack compose starts.
- The page always asks for `explain` and for ten results. There is no paging.
- Light theme only, English only.

Where this departs from the house standard for front ends, and why:

- openapi-typescript and Lighthouse CI run through `npx` at pinned versions instead of being dev dependencies. The
  first declares TypeScript 5 as a peer and the page is on 6.0; the second pulls in packages with open high-severity
  advisories, which `npm audit` would then report for this repository.
- The query client is passed to each `useQuery` call instead of being installed as a plugin, so the library is not
  part of the entry chunk.
- Unit and component tests replace `fetch` itself (`web/src/test/network.ts`) and do not use Mock Service Worker. It
  is the same layer, one dependency fewer; the journeys use Playwright's route interception for the two forced errors.

## Alternatives

- **Hand-written response types.** Less machinery, and exactly the drift described above. They would be enough for a
  client in another repository that cannot read the server's document.
- **A generated client (openapi-fetch) without runtime parsing.** Types for free on every call. It lost because a
  type is a promise about what the server sends and a parse is a check of it; with two calls the parsers cost thirty
  lines. It would win with dozens of endpoints.
- **Nuxt, or a small Node backend, to hold the key and render on the server.** A Node process to run and patch, for a
  page that needs neither server rendering nor a session. nginx was needed anyway to serve the files.
- **A store for the query and the results.** It would need code to keep it equal to the address and to throw away
  stale answers, both of which the router and the query cache already do.

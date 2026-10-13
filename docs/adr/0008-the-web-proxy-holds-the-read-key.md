# 8. The web proxy holds the read key, and its origin is an anonymous read endpoint

## Context

The console (ADR 10) is a page in a browser, and every API route needs a key (ADR 7). A key that reaches a browser is
public: it is in the network tab of anyone who opens the page. The stack also has to come up with
`docker compose up --build --wait` and nothing else, so nobody is there to create a key and paste it somewhere, and
nothing secret may be committed to make that work.

## Decision

nginx, in the web container, is the only thing that holds a key, and the key can do one thing.

- **The key.** The one-shot `seed` service runs `fathom keys create --collections demo --scopes read` when the stack
  starts and writes the key to a named volume. The web container mounts that volume read-only. Before nginx starts,
  `web/read-key.sh` checks that the file holds exactly one key and nothing else, and writes one line,
  `proxy_set_header Authorization "Bearer ..."`, into a file under `/tmp` that the proxied locations include. The
  file's content becomes configuration, so the check is on the whole file and not on its first line: a key followed
  by a second line that closes the quote and adds a directive is refused, and the container does not start
  (`tests/unit/test_read_key.py`, and a step in CI against the built image). The key is not in an image, in the
  repository, in the compose file or in an environment variable. A second `up` finds the key still accepted and
  keeps it.
- **The allowlist.** `web/nginx.conf` forwards two routes: `POST /api/v1/collections/demo/search` and
  `GET /api/v1/collections/demo/stats`. Each is a `location =`, which matches one exact path, and the upstream path is
  written out in the configuration instead of being built from the request. Everything else under `/api/` gets a 404
  from nginx and never reaches the API: other collections, documents, the OpenAPI document, the health routes, the same
  two paths with another method.
- **The rate limit.** `limit_req` allows one client address 10 searches a second with a burst of 30, and the same
  for requests for the counts, in a bucket of their own so that page loads do not use up searches. Over that, nginx
  answers 429 as `application/problem+json`. Request bodies are capped at 8 KB.
- **The header.** The proxy sets `Authorization` itself, so a header of that name sent by a browser is replaced, not
  forwarded.
- **The same response headers on every answer.** The content security policy, `nosniff` and `Referrer-Policy:
  no-referrer` are in one file that every location with a header of its own includes, because in nginx a location's
  `add_header` replaces the server's. The proxy's 404, 429 and 503 and a 404 for a missing file carry them too.
- **The log.** The query is in the page's address, so nginx's stock log line, which holds the request line and the
  Referer, would record every search. The access log here holds the method, the path up to the question mark, the
  status and the size. CI asks for a page with a marker in its query and looks for the marker in the log.

The journeys in `web/e2e/proxy.spec.ts` ask the proxy for what it should refuse and check each refusal, send more
searches than the limit and check for the 429, and `the page never sends or receives an API key` in
`web/e2e/journeys.spec.ts` records every request and response of a session and looks for one.

## Consequences

- The origin is an anonymous read endpoint for one collection. Anyone who can reach the port can search `demo` and
  read its counts. That is the point of a demo whose corpus is this repository's public documentation (ADR 9), and it
  is the wrong setup for anything private. Do not point the proxy at another collection without putting authentication
  in front of it.
- The rate limit counts the address nginx sees. Behind Docker Desktop's port forward, or any proxy that does not pass
  the real address on, every client arrives from the same address and shares one bucket, so one busy client can use up
  the allowance for all of them. A deployment behind a trusted proxy sets `set_real_ip_from` and `real_ip_header`. The
  limit protects the API from one caller; it is not a defence against many.
- A caller who talks to the proxy directly, without the page, can still set `k` up to 100, ask for any metadata filter
  and choose the mode. The proxy does not inspect the body. Each search costs at most one embedding (cached per query)
  and two indexed queries.
- The access log has no queries in it. nginx's error log is not reshaped: when nginx reports an error about a
  request it quotes that request's first line, query string included. The API never sees the page's address, only
  the search request, whose query is in the body and is not logged by either.
- The key is a file in a Docker volume. Anyone who can run `docker compose exec web cat /run/fathom/read.key` has it.
  What it buys them is what the page already gives away, minus the rate limit, and only if they can also reach the API
  port, which compose binds to 127.0.0.1.
- nginx reads the key once, at start. After the key is revoked the page gets 401s until the seed step has run again
  (it sees the refusal and creates a new key) and the web container has been restarted. `docs/operations.md` has the
  two commands.
- The seed step needs the database, because that is where keys are made. It also creates a write key for itself and
  revokes it when it finishes; a revoked key keeps working for up to `FATHOM_KEY_CACHE_SECONDS` (ADR 7).
- The image gained one directory the non-root user may write, `/var/lib/fathom`, so the seed step can leave the key in
  a volume without running as root.
- There is one origin, so there is no CORS configuration anywhere, and the page's content security policy is
  `default-src 'self'`.

## Alternatives

- **A key in the browser**, typed in by the person or built into the page. Any key the page holds is public, and one
  built in at build time also ends up in an image layer. It would be the right shape for a private tool where each
  person has their own key, and then the key belongs in an `HttpOnly` session cookie issued by a small backend, not in
  the page.
- **A route in the API that needs no key**, switched on per collection. It changes the API's rule that every route
  needs a key (ADR 7) for the sake of a demo, and it moves the rate limit into Python. It would win if anonymous read
  access were a feature of the product and not of one compose file.
- **A key in an environment variable or a `.env` file.** Either someone creates the key by hand before the first
  `up`, or a key is committed. Both were ruled out by the requirement that one command is enough.
- **The nginx image's own template step**, with the key exported from a sourced script. It works. The template step
  substitutes every `${NAME}` it finds an environment variable for and needs a filter to leave nginx's own variables
  alone; a script that checks the key and writes one line has less to go wrong and fails with a message that names the
  cause.

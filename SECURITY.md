# Security

## Reporting

Please report vulnerabilities privately through GitHub's "Report a vulnerability" on this repository, not in a public
issue. You should hear back within a week.

## What the code does about it

- **Every SQL statement is parameterised.** The f-strings in `search.py` interpolate module constants (the OR-query
  expression, a ranker name from a two-item whitelist), never request values, and each says so.
- **Keys are stored as SHA-256 digests** of 256-bit random secrets and compared with `hmac.compare_digest`, including
  when the key id does not exist (ADR 7).
- **Keys are scoped** to collections and to read or write. A key that cannot reach a collection gets 404, so it cannot
  probe for collection names.
- **Request bodies are capped** (`FATHOM_MAX_PAYLOAD_BYTES`) and counted as bytes arrive, so leaving out
  `Content-Length` does not get round the limit. Batches are capped at 100 documents.
- **Identifiers are validated** at the boundary (collection names and document ids against fixed patterns), and again by
  check constraints in the schema.
- **The dataset used by `fathom eval` is checked against a pinned SHA-256** before it is used.
- **The image runs as a non-root user**, without pip, with the model baked in and `HF_HUB_OFFLINE=1`, so it makes no
  outbound requests. CI scans the image and the locked dependencies for known vulnerabilities.

### The browser console

The console in `web/` puts a page in front of the API. ADR 8 has the reasoning; this is what is enforced.

- **The browser never holds an API key.** nginx in the web container adds one to the two requests it forwards. The key
  can only read the `demo` collection, is created when the stack starts, and lives in a Docker volume: not in an
  image, the repository or an environment variable. `the page never sends or receives an API key` records a whole
  session's requests and responses and looks for one.
- **The proxy is an allowlist.** Two exact routes of one collection are forwarded. Every other path under `/api/`,
  and the same paths with another method, get a 404 from nginx without reaching the API. An `Authorization` header
  sent by a client is replaced, not forwarded. `web/e2e/proxy.spec.ts` asks for what should be refused.
- **Searches are rate-limited per client address** (10 a second, burst 30; the same again for the counts) and request
  bodies are capped at 8 KB, because that origin answers anyone.
- **The key file is checked whole before nginx reads it.** Its content becomes a line of configuration, so anything
  other than exactly one key (a second line, a carriage return, a quote) stops the container at start.
  `tests/unit/test_read_key.py` feeds it a key followed by a line of nginx configuration.
- **Every answer carries the same security headers**, the proxy's own 404, 429 and 503 and a 404 for a missing file
  included; `web/e2e/proxy.spec.ts` checks each.
- **What people search for is not written to the access log.** The query is in the page's address, so the log line
  holds the path without the query string, and the page sends no Referer. nginx's error log still quotes the first
  line of a request it reports an error about.
- **Snippets are rendered as text.** The page splits a snippet into text nodes and `<mark>` elements and never
  parses it as markup; `v-html` is forbidden by a lint rule that fails the build. The content security policy is
  `default-src 'self'`, with no inline script or style, so markup that did get through would still not run.
- **The page talks to its own origin only**, so there is no CORS configuration to get wrong.

## What it does not do

- **Snippets are not HTML-escaped.** They are plain text with « and » marking matches, taken from documents your
  callers wrote. Escape them before putting them in a page.
- **Documents are stored in plain text.** Encrypt sensitive fields before they reach the service, or keep them out.
- **There is no per-key rate limit** in the API. Put it behind a gateway that has one; the console's proxy is an
  example for one collection.
- **The console's origin is public to whoever can reach its port.** It serves one collection of public documentation
  without asking who is there. Compose binds it to 127.0.0.1. Do not point the proxy at a collection that is not
  meant to be read by everyone.
- **The console's rate limit is per address as nginx sees it.** Behind a proxy that hides the client's address, or
  Docker Desktop's port forward, all clients share one allowance.

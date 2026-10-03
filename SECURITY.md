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

## What it does not do

- **Snippets are not HTML-escaped.** They are plain text with « and » marking matches, taken from documents your
  callers wrote. Escape them before putting them in a page.
- **Documents are stored in plain text.** Encrypt sensitive fields before they reach the service, or keep them out.
- **There is no per-key rate limit.** Put the API behind a gateway that has one.

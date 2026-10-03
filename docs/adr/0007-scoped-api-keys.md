# 7. Scoped API keys, stored as hashes

## Context

A search service is usually called by other services, and different callers should reach different collections:
the support bot reads the help articles, the ingestion job writes them, nobody else touches the HR collection.

## Decision

Keys look like `fth_<id>_<secret>`, where the secret is 32 random bytes. The table stores the id, a SHA-256 of the
secret, the collections the key may reach (or `*`) and its scopes (`read`, `write`). A request is checked by looking
the id up and comparing digests with `hmac.compare_digest`; when the id does not exist, the comparison still runs
against a dummy so the response time does not say which ids are real.

A key that may not reach a collection gets 404 for it, not 403, so keys cannot be used to discover collection names.

Verified keys are cached in the process for `FATHOM_KEY_CACHE_SECONDS` (10 by default).

## Consequences

- A leaked database dump does not contain usable keys. SHA-256 rather than a slow password hash is deliberate: the
  secret has 256 bits of entropy, so there is nothing for a slow hash to protect against, and a slow hash on every
  request would cost real latency.
- A revoked key keeps working for up to the cache lifetime in each API process. Set the cache to 0 to make revocation
  immediate at the cost of one indexed lookup per request.
- `fathom keys create` prints the key once. There is no way to show it again; lose it and create another.

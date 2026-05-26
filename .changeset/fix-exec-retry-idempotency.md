---
"sql-fs-api": patch
---

fix(exec): never silently retry write execs on 5xx; add opt-in `retryOn5xx`

The Python SDK previously retried `{429, 500, 502, 503, 504}` unconditionally
in `Transport.request()`, which silently re-ran write `exec` scripts whose
Postgres mutation had already committed but whose cache-invalidation publish
failed (`ECOHERENCE`). That double-applied side effects callers never asked
to retry.

Changes:

- `Transport.request()` now accepts `idempotent` and `read_only` flags. 5xx
  retry only fires when the request is declared idempotent. `503 ECOHERENCE`
  is never retried on non-`read_only` requests (the write committed; only
  the Redis publish failed — retry would double-apply).
- `Sandbox.exec()` and `Sandbox.exec_batch()` gain a `retry_on_5xx: bool = False`
  parameter. `read_only=True` execs remain retried automatically. Write execs
  retry only on explicit opt-in.
- Server `execBodySchema` / `batchExecBodySchema` accept (and ignore)
  `retryOn5xx` for forward compatibility with future server-side retry.
- OpenAPI spec documents `retryOn5xx`.

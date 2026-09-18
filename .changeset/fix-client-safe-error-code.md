---
"sql-fs-api": patch
---

Stop leaking raw driver and SQLSTATE error codes to clients, and surface a database connection/capacity failure as a retryable 503 instead of a 500.

The global `app.onError` handler redacted the error *message* through the `SAFE_FS_ERROR_CODES` allowlist and then passed the error `code` straight out unfiltered. Under load testing that produced bodies like `{"error":"Internal server error","code":"ECONNRESET"}` and `{"error":"Internal server error","code":"CONNECTION_CLOSED"}`, plus bare Postgres SQLSTATEs (`53300`, `57P01`, `23503`) — the message said nothing and the code said everything. The SSE error frame in `routes/exec.ts` had the identical asymmetry.

The allowlist is now applied to both halves by a single `clientSafeErrorCode` helper sitting next to `clientSafeErrorMessage`, so the pair can no longer drift apart: an allowlisted FS code (`ENOENT`, `ELOCKLOST`, ...) passes through, anything else becomes `INTERNAL_ERROR`. The raw code is still written to the server-side `exec_sse_error` log, so this costs nothing in diagnosability — it costs client-side diagnosability, which is the point.

Folded in because it is the same handler and the same mistake: a connection-class SQLSTATE — the whole `08xxx` connection-exception class, plus `53300` (too_many_connections), `53400` (configuration_limit_exceeded) and `57P03` (cannot_connect_now) — now maps to **503** rather than 500, and reports the synthetic code `EUNAVAILABLE`. Previously a pool exhaustion or a cannot-connect-now looked exactly like a server bug, so clients treated it as terminal and did not back off. `EUNAVAILABLE` is deliberately synthetic: it tells the caller the condition is retryable without naming which SQLSTATE produced it. Any SQLSTATE outside those classes (`23503`, for instance) still maps to 500 — a constraint violation is a bug, not a capacity signal.

Verified by unit tests against the real `app.onError` and the real SSE route (both fail against the previous code). Not verified against a live Postgres: the SQLSTATEs are asserted from synthetic errors carrying the documented `.code` values, not by exhausting a real connection pool.

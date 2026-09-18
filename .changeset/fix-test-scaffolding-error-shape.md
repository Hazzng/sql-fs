---
"sql-fs-api": patch
---

Give the test-app scaffolding production's error contract instead of a copy of the pre-#174 leaky one.

Test-only — no shipped behaviour changes. The point is that the scaffolding can now *catch* a shipped regression.

Four test files built their own Hono app whose `onError` hand-rolled `(err as Error & { code?: string }).code ?? "INTERNAL_ERROR"` — the exact line #174 deleted from production for handing clients raw driver codes (`ECONNRESET`) and bare Postgres SQLSTATEs (`53300`). Two of them also returned `err.message` unredacted. Those apps therefore no longer agreed with `server.ts`, so a future reintroduction of the leak would have passed every assertion built on them, and any assertion written against them encoded the pre-fix contract as if it were current.

All four now share one `testErrorHandler` (`src/api/tests/helpers/error-handler.ts`) that calls the same `clientSafeErrorMessage` / `clientSafeErrorCode` / `isRetryableError` trio as production, so the test apps and `server.ts` cannot drift. Sites: `exec-batch.test.ts`, `exec-batch.perscript.test.ts`, `multi-tenant.integration.test.ts`, `writefiles-atomicity.integration.test.ts`.

Guarded two ways in `test-app-error-shape.test.ts`: the handler is asserted to redact a driver code and a SQLSTATE and to pass an allowlisted FS code through, and a source scan fails if any file under `src/api/tests/` grows the hand-rolled fallback again. Both halves fail against the previous code — the scan names all four files by path.

No existing assertion depended on a raw code or message leaking through: the `INVALID_INPUT` and `AUTH_UNKNOWN_TENANT` codes those suites assert come from middleware returning `c.json` directly and never reach `onError`.

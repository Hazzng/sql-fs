---
"sql-fs-api": minor
---

Surface a retryable `ESESSIONCLOSING` (HTTP 503) instead of a generic 500 when a request
loses the reaper-vs-straggler race (F9c). A request that captured a session reference just
before the idle/overBudget reaper marked it `closing` could run the pre-lock
`ensureFreshCache` probe against a Postgres pool being disconnected, producing an unmapped
error (e.g. `PostgresDialect: not connected`, which carries no `code`) that defaulted to a
500. Both pre-lock probe sites (`withSessionEntry`, `withSessionReadEntry`) now re-check the
session state on probe failure and convert it into a clean, retryable `ESESSIONCLOSING`
(already mapped to 503) so clients retry instead of seeing a non-retryable 500. No
concurrency-model change.

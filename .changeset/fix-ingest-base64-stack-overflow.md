---
"sql-fs-api": patch
---

Fix `POST /v1/sandboxes/:id/ingest-files` returning 500 (Internal Server Error) for files larger than ~750 KB. `isValidBase64` ran a structural regex whose `(?:[A-Za-z0-9+/]{4})*` quantifier overflowed V8's call stack (`RangeError: Maximum call stack size exceeded`) on base64 strings beyond ~1 MB — failing during request validation, before any database work. The regex is now skipped for strings over 1 MB, relying solely on the canonical round-trip check (`Buffer.from(s, "base64").toString("base64") === s`), which is native and never overflows. Ingesting multi-MB files now succeeds.

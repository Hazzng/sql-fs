---
"sql-fs-api": patch
---

Make defense-in-depth compatible with Postgres on just-bash 3.x. just-bash 3.x freezes `Error.stackTraceLimit` during `bash.exec`, which the `postgres` driver assigns to (breaking every query). All SqlFs DB chokepoints now route through `runTrustedDbAsync`, which re-opens `Error.stackTraceLimit` writability before trusted DB I/O. No-op on just-bash 2.x (the property is never frozen there).

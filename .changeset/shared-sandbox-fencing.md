---
"sql-fs-api": patch
---

Centralize Postgres sandbox fencing while preserving transaction context, lock order, and statement counts. Add regression coverage for stale writes and concurrent transactions, and fix verification commands that could fail under shell pipefail.

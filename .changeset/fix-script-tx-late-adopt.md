---
"sql-fs-api": patch
---

Stop a late-arriving transaction open from adopting into a finished scope, and refuse cache-served reads once a script-tx is lost.

Two gaps in the fail-closed work. An abort can beat a queued `setSandboxContextWithLock`; when that statement resolved afterwards it still assigned its transaction, so the next scope inherited a rolled-back handle and skipped opening one of its own. Each open now carries a generation that the callback checks before adopting, and a new scope invalidates any open still in flight.

Separately, `stat`, `readFile`, `readdir`, `exists` and `getAllPaths` are served from the in-memory caches and never touch the transaction helpers, so after a lost connection they handed back mutations the rollback was about to erase. The liveness check now sits inside the assertion itself, applied at those read entry points too.

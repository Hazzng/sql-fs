---
"sql-fs-api": minor
---

Guard `publishVersionIfDirty` with a cache-poison flag (F1): when a correlated Postgres failure fails both the script-tx COMMIT and the recovery reload, the session no longer publishes a version/snapshot of uncommitted phantom state — it suppresses the INCR, forces a reload on next use, and surfaces ECOHERENCE.

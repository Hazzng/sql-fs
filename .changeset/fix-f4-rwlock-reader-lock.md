---
"sql-fs-api": patch
---

fix(lock): when `REDIS_RWLOCK_ENABLED=false`, readers now take the same legacy single-key lock as writers (closing the F4 reader/writer race during rolling deploys), and `SqlFs.reload()` is a no-op while a script scope is open so a concurrent reload can never clobber an open writer's in-memory cache.

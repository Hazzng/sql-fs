---
"sql-fs-api": minor
---

fix(lock): add bounded jitter + tunable retry to the distributed acquire loops (F9d, #141)

The distributed exec lock and RW lock polled Redis on a flat `acquireRetryMs`
(default 50 ms) interval, leaving competing replicas phase-aligned so a
cross-replica writer could be repeatedly passed over (bounded by
`acquireTimeoutMs`, then 503). Every acquire/drain poll now sleeps a jittered
`retryMs/2 + random()*retryMs/2` (range `[retryMs/2, retryMs]`) to
de-synchronize pollers. The retry interval is now configurable via
`REDIS_EXEC_LOCK_ACQUIRE_RETRY_MS` (previously hardcoded — `server.ts` omitted
it). Circuit-breaker / error-budget behavior is unchanged. The FIFO ZSET ticket
queue is deferred as a follow-up.

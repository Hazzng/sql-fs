---
"sql-fs-api": minor
---

fix(lock): circuit-break Redis acquire to stop the 300s outage fuse (F5)

The distributed lock acquire loops conflated "lock busy" (contention) with "Redis
unreachable" (a thrown connection error): both retried until `acquireTimeoutMs`
(default 300 s), so a Redis outage hung every exec/file op for ~5 minutes on an
otherwise-healthy Postgres.

- New process-wide Redis circuit breaker (`src/redis/circuit-breaker.ts`) wired
  into the lock ACQUIRE paths only (`distributed-rw-lock.ts` shared/exclusive +
  `waitReadersDrained`, legacy `distributed-lock.ts`). After K (=5) consecutive
  connection-class failures it opens and acquire fast-fails 503 immediately; a
  successful eval/PING closes it. Renew/release paths are untouched (they keep
  tolerating transient errors to avoid dropping leases / leaking keys).
- Separate short per-call error budget (`errorBudgetMs`, default 4 s) that
  advances only on thrown errors, so genuine contention still uses the full
  `acquireTimeoutMs` window.
- `commandTimeout: 2000` on the ioredis client so commands reject promptly during
  an outage instead of queueing on the offline queue.
- `/readyz` now PINGs Redis and returns 503 when Redis is configured but
  unreachable.
- Fixed the stale `ownership.ts` docstring (the readOnly path DOES take a shared
  distributed lock).

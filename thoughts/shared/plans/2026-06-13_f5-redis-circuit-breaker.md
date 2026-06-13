# F5 — Redis circuit breaker: stop the 300s availability fuse

## Overview

The distributed lock acquire loops conflate "lock busy" (contention) with "Redis
unreachable" (infrastructure outage). Both are retried until `acquireTimeoutMs`
(default **300 s**), then surfaced as `LockAcquireTimeoutError` → 503. So a Redis
outage hangs every exec/file op for ~5 minutes on an otherwise-healthy Postgres,
and (because ioredis has `enableOfflineQueue:true` and no `commandTimeout`)
pins sockets through reconnect backoff.

This plan adds a process-wide Redis **circuit breaker** wired into the **acquire
paths only**, a separate short **error budget** that advances only on thrown
(connection-class) errors, an ioredis `commandTimeout`, a real Redis PING in
`/readyz`, and fixes a stale docstring.

## Current State

- Default lock is `distributed-rw-lock.ts` (`REDIS_RWLOCK_ENABLED !== "false"`, `server.ts:50`).
- `acquireExclusive` (`distributed-rw-lock.ts:247-258`): `catch { flagAcquired = false }` — Redis throw treated as busy, retried to deadline.
- `acquireShared` (`:160-178`): `catch { acquired = false }` — same conflation.
- `waitReadersDrained` (`:272-278`): `catch { count = 1 }` — second conflation site; runs after the flag is set, on the same deadline.
- defaults `acquireTimeoutMs=300_000`, `acquireRetryMs=50` (`:101-102`).
- Legacy `distributed-lock.ts:110-121`: same `catch { acquired = false }` shape (flag-off path).
- Renew/release deliberately tolerate transient errors (`distributed-rw-lock.ts:191-233`, `:296-337`, `:389-396`, `:426-433`; `distributed-lock.ts:142-203`) — H4. Must NOT be touched.
- `redis/client.ts:32-37`: `maxRetriesPerRequest:3`, **no** `commandTimeout`, `enableOfflineQueue` default true.
- `server.ts:243`: `/readyz` returns `{status:"ok"}` unconditionally — does not reflect Redis health.
- `ownership.ts:60-66`: docstring says readOnly path has "no distributed exec lock" — stale; `withSessionRead` → `withExecLockShared` does take a shared distributed lock.

## Desired End State

- A Redis outage makes lock acquire **fast-fail 503 within a few seconds** (error budget), not 300 s.
- Genuine contention (lock busy, Redis healthy) still uses the full `acquireTimeoutMs` window.
- After K (=5) consecutive connection-class failures the breaker is **open**: acquire fast-fails immediately (no per-op error budget wait) until a probe (PING/successful eval) closes it.
- Renew/release behavior unchanged (still tolerate transient errors → no dropped leases / leaked keys).
- ioredis rejects commands after ~2 s (`commandTimeout`) so the breaker's error budget actually advances instead of blocking on the offline queue.
- `/readyz` PINGs Redis and returns 503 when Redis is configured but unreachable.
- `ownership.ts` docstring corrected.

## What We're NOT Doing

- NOT touching renew/release/heartbeat paths.
- NOT auto-enabling any degrade-to-L2+L3-only mode (write-race risk; operator-flag only, out of scope here).
- NOT adding jitter/ticketing (that's #141, lands on top of this).
- NOT changing `acquireTimeoutMs` default (contention window stays 300 s).

## Approach

New `src/redis/circuit-breaker.ts` exporting a `RedisCircuitBreaker` with:
- `recordSuccess()` / `recordFailure()` — track consecutive connection-class failures; open at threshold.
- `isOpen()` — open until a half-open probe succeeds.
- `assertClosed()` — throw a breaker-open error (mapped to 503) when open.
- A process-wide singleton accessor `getRedisCircuitBreaker()`.

Helpers in the lock modules wrap each acquire eval/set call so that:
1. Before each attempt, if breaker open → throw `LockAcquireTimeoutError` (503) immediately.
2. A thrown error (connection-class) → `breaker.recordFailure()` AND advances a per-call **error budget** (`errorBudgetMs`, default 4000). If budget exhausted → throw `LockAcquireTimeoutError`. Contention (eval returns 0 / set returns non-OK) does NOT advance the budget.
3. A successful eval/set → `breaker.recordSuccess()` (closes breaker).

We reuse `LockAcquireTimeoutError` (existing ELOCKTIMEOUT→503 mapping) so the caller contract and HTTP status are unchanged whether the cause is contention timeout or breaker fast-fail.

`commandTimeout: 2000` added to the ioredis options. `/readyz` gets a bounded PING.

## Phase 1 — Circuit breaker module + client commandTimeout

### Changes
- New `src/redis/circuit-breaker.ts`: `RedisCircuitBreaker` class (threshold, half-open probe via a provided ping fn), `getRedisCircuitBreaker()` singleton, `resetRedisCircuitBreakerForTest()`.
- `src/redis/client.ts`: add `commandTimeout: 2000`.

### Success Criteria
**Automated**
- [x] `pnpm typecheck` passes.
- [x] `pnpm lint:fix` clean.
- [x] New unit test for breaker open/close/half-open passes.

**Manual**
- [ ] n/a (covered by Phase 2 live test)

### Discoveries
- ioredis `commandTimeout` rejects an in-flight command after the timeout, which is exactly what makes the per-call error budget advance during an outage instead of hanging on the offline queue.

## Phase 2 — Wire breaker + error budget into acquire paths

### Changes
- `distributed-lock.ts`: add `errorBudgetMs` to options/defaults; in the acquire loop, separate thrown errors from contention; consult/record breaker; advance error budget only on throw.
- `distributed-rw-lock.ts`: same for `acquireShared`, `acquireExclusive`, and `waitReadersDrained` (the third conflation site shares the writer deadline but must also respect breaker + error budget).
- Renew/release paths untouched.

### Success Criteria
**Automated**
- [x] `pnpm typecheck` passes.
- [x] `pnpm lint:fix` clean.
- [x] `distributed-lock`, `distributed-rw-lock` unit tests pass (unchanged tests still green).
- [x] New regression test: breaker opens after K failures, acquire fast-fails within error budget, renew/release still tolerate transient errors, transient blip recovers.

**Manual**
- [x] Live: dead-Redis exec fast-fails 503 in 2111 ms (see Manual Verification B).

### Discoveries
- The writer exclusive acquire has TWO loops (set-flag + waitReadersDrained); they share one `AcquireErrorBudget` + the process-wide breaker, created in `runExclusive`, so a mid-acquire outage doesn't reset the budget at the second loop.
- Reused the existing `LockAcquireTimeoutError` (ELOCKTIMEOUT→503) for breaker fast-fail rather than a new error type — keeps the route/HTTP contract unchanged.
- The breaker singleton is shared across unit-test files; the F5 regression test calls `resetRedisCircuitBreakerForTest()` in beforeEach/afterEach to avoid cross-test bleed.

## Phase 3 — /readyz Redis PING + ownership docstring

### Changes
- `server.ts:243`: `/readyz` PINGs Redis (bounded) when configured; 503 on failure.
- `ownership.ts:60-66`: correct the stale docstring (readOnly DOES take a shared distributed lock).

### Success Criteria
**Automated**
- [x] `pnpm typecheck` passes.
- [x] `pnpm lint:fix` clean.

**Manual**
- [x] Live: `/readyz` → 200 with healthy Redis (A); dead-Redis server `/readyz` → 503 "Command timed out" (B).

### Discoveries
- (filled during implementation)

## Manual Verification (Live API — Neon + Redis) — DONE 2026-06-13

Auth: minted an HS256 JWT (`sub=f5-test-user`) from `AUTH_SECRET` in `.env` via `jose` SignJWT.

### A. Happy path (Redis up :6379, server :8080)
- `GET /readyz` → **HTTP 200** `{"status":"ok"}` (Redis PING succeeded).
- `POST /v1/sandboxes` → 200, id `5995a856-…`.
- `POST /v1/sandboxes/:id/exec` `echo hi > /a && cat /a` → **HTTP 200**, SSE `stdout: "hi\n"`, `exit 0` (durationMs 303). Breaker does not break the happy path.
- Server killed by PID; :8080 freed.

### B. Breaker fires (DEAD Redis :6390, server :8090)
- `GET /readyz` → **HTTP 503** `{"status":"degraded","redis":"Command timed out"}` (PING bounded by commandTimeout).
- `POST /v1/sandboxes/:id/exec-sync` `echo hi > /a && cat /a` → **HTTP 503** `ELOCKTIMEOUT`, **ELAPSED 2111 ms** (not ~300 s). ✅ core proof.
- Second exec → **HTTP 503** `ELOCKTIMEOUT`, **ELAPSED 2092 ms** (breaker open + error budget). 5 redis_error/timeout log events observed.
- Server killed by PID + orphan child; :8090 freed.

### C. Cleanup
- All servers I started killed; :8080 and :8090 free. Two pre-existing `tsx watch` dev servers (started 5Jun/28May) left untouched (not mine). Shared Redis on 6379 still `PONG`. `/tmp/f5-dead.env` removed.

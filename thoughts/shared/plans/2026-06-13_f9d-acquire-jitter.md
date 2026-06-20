# F9d — Distributed acquire fairness: jitter + tunable retry

## Context

GitHub issue #141 (F9d, severity:low). Distributed acquire loops poll Redis on a
flat `acquireRetryMs` (default 50 ms) `setTimeout`/`sleep`. Across replicas the
sleeps stay phase-aligned, so a cross-replica writer can be repeatedly passed
over by another replica that happens to poll a hair earlier each cycle — bounded
by `acquireTimeoutMs` (300 s) then a 503, never infinite.

This lands on top of the just-merged F5 circuit breaker (#134), which sits in the
same acquire loops. Jitter/retry must not regress breaker behavior.

### Current state (verified by symbol)
- `src/api/distributed-lock.ts` — legacy single-key acquire loop: `await new Promise((r) => setTimeout(r, acquireRetryMs))` at the bottom of the `while (true)` acquire loop. `acquireRetryMs` already on `DistributedLockOptions` (default 50, asserted `> 0`).
- `src/api/distributed-rw-lock.ts` — three poll loops use `await sleep(acquireRetryMs)`: `acquireShared`, `acquireExclusive` (Phase A flag), `waitReadersDrained` (drain). `acquireRetryMs` already on `DistributedRWLockOptions` (default 50, asserted `> 0`). A module-local `sleep()` helper exists.
- `src/api/server.ts:42-49` — builds `execLockOptions` (`Partial<DistributedRWLockOptions>`) from env but **omits `acquireRetryMs`**, so 50 ms is effectively hardcoded in prod. Threaded straight into `withDistributedLock`/`withDistributedRWLock` via `session-manager.ts`.
- `parseNonNegativeInt` (`src/redis/config.ts`) is the env parser used for the other lock knobs. Consistent to reuse (0 is caught lazily by the lock's `assert*Options`, same as `leaseMs`/`renewMs`).

## Desired end state

- Every acquire/drain poll sleeps a **bounded jittered** interval `retryMs/2 + random()*retryMs/2` (range `[retryMs/2, retryMs]`) instead of a flat `retryMs`, de-synchronizing competing replicas.
- `acquireRetryMs` is configurable via `REDIS_EXEC_LOCK_ACQUIRE_RETRY_MS` (wired through `server.ts`) and documented in CLAUDE.md.
- Circuit-breaker / error-budget behavior unchanged.
- ZSET ticket queue is explicitly **deferred** as a follow-up (only needed if multi-writer-per-sandbox becomes real).

## What we are NOT doing
- No ZSET/LIST FIFO ticket queue (deferred; would need TTL-reaping to stay crash-safe).
- No change to lease/renew/heartbeat logic, breaker, or error budget.
- No change to acquire success/timeout contract (`LockAcquireTimeoutError` → 503).

## Implementation

### Phase 1 — jitter helper + apply in both lock files
- Add `jitteredDelayMs(retryMs)` to `distributed-lock.ts`, exported, returning `retryMs / 2 + Math.random() * (retryMs / 2)`. Use it in the legacy acquire loop's sleep.
- Import it into `distributed-rw-lock.ts`; replace the flat `sleep(acquireRetryMs)` in `acquireShared`, `acquireExclusive`, `waitReadersDrained` with `sleep(jitteredDelayMs(acquireRetryMs))`. Leave the renew-retry timers (heartbeat) untouched — those are not the contention loops F9d targets.

**Automated criteria**
- [ ] `pnpm typecheck` passes.
- [ ] `pnpm lint:fix` clean.
- [ ] `pnpm test -- distributed-lock distributed-rw-lock` green.

**Manual criteria**
- [ ] Jitter only appears in acquire/drain loops, not heartbeat renewal.

### Phase 2 — wire `REDIS_EXEC_LOCK_ACQUIRE_RETRY_MS` through server.ts
- Add `acquireRetryMs: parseNonNegativeInt("REDIS_EXEC_LOCK_ACQUIRE_RETRY_MS", 50)` to `execLockOptions`.
- Document the env var in CLAUDE.md env table.

**Automated criteria**
- [ ] `pnpm typecheck` passes.

**Manual criteria**
- [ ] Env var documented; default 50 matches the lock default.

### Phase 3 — regression tests
- New `distributed-acquire-jitter.test.ts`: assert `jitteredDelayMs(retryMs)` stays in `[retryMs/2, retryMs]` across many samples; assert configured `acquireRetryMs` is honored (acquire still succeeds; timeout still fires at `acquireTimeoutMs`); breaker path unaffected.

**Automated criteria**
- [ ] `pnpm test:unit` green, existing tests unchanged.

## Discoveries
- `acquireRetryMs` was already a first-class option on both lock types and threaded end-to-end via `session-manager.ts`; only the `server.ts` env wiring was missing — matches the issue's "already threaded" note.
- Jitter narrows-or-equals the flat interval (max = `retryMs`), so existing tests with generous `acquireTimeoutMs` remain valid.

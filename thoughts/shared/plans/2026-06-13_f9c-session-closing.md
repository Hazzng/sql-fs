# F9c: Reaper vs straggler probe — surface ESESSIONCLOSING not 500

GitHub issue: Hazzng/sql-fs#140 · Branch: `fix/f9c-session-closing`

## Problem

The reaper (`runReaper`, `session-manager.ts:1192`) marks `session.state = "closing"`
synchronously **before** disconnecting the FS, then deletes the session and kicks off
`disconnectFs` (→ `PostgresDialect.disconnect` → `pool.end()`, `postgres.ts:76`).

A request that already captured the session ref and passed the `state === "closing"`
guard at the top of `withSessionEntry` (`:634`) / `withSessionReadEntry` (`:699`) can then
run the **pre-lock** `ensureFreshCache` probe (`:638`, `:703`). If the reaper's
`disconnect()` has already nulled the pool (`postgres.ts:273` → `throw new Error("PostgresDialect: not connected")`)
or `end()` has begun rejecting (`CONNECTION_DESTROYED`/`ENDED`), the reload throws an
**unmapped** error. The `PostgresDialect: not connected` error carries **no `code`**, so
`mapFsErrorToStatus` (`api/errors.ts:68`) hits `default → 500`. The client sees a
non-retryable 500 for what is really a transient "session is being recycled" condition.

Only the **overBudget** reap trigger is realistic — the IDLE trigger is closed because
`getOrCreate` bumps `lastUsed` (`:451`). A query already on the wire is not aborted
(`pool.end()` has no timeout); the surviving vector is the reload's `db()` issued *after*
disconnect begins.

## Fix to ship (per issue)

Wrap the two pre-lock `ensureFreshCache` calls in try/catch. On failure, if
`session.state === "closing"`, re-throw a clean `ESESSIONCLOSING`-coded error (maps to
503 retryable); otherwise re-throw the original. Zero concurrency-model change.

`ESESSIONCLOSING` is **already** mapped to 503 in `mapFsErrorToStatus` and already in
`SAFE_FS_ERROR_CODES` (`api/errors.ts:24,85`) — no error-layer change required.

---

## Phase 1 — Wrap the pre-lock probes

**Changes:** `src/api/session-manager.ts`
- `withSessionEntry` (`:638`): wrap `ensureFreshCache` in try/catch; on `state==='closing'`
  throw `ESESSIONCLOSING`, else rethrow.
- `withSessionReadEntry` (`:703`): same.

**Automated criteria:**
- [x] `pnpm typecheck` passes
- [x] `pnpm lint:fix` clean
- [x] existing `pnpm test:unit` still passes (no weakened tests)

**Manual criteria:**
- [x] Diff is minimal — only the two probe sites wrapped; no lock/state changes.

**Discoveries:**
- File in this worktree is 1368 lines (branched from `c6b29f4`), so the issue's `~593`/`~658`
  line refs map to actual call sites `:638` (`withSessionEntry`) and `:703`
  (`withSessionReadEntry`). Both confirmed as the only pre-lock `ensureFreshCache` calls.
- `ensureFreshCache` no-ops when `redis === undefined` (`:789`) — so the race only exists
  on Redis-backed multi-replica deployments, matching the issue's `area:distributed` label.

## Phase 2 — Regression test

**Changes:** new `src/api/tests/unit/session-manager.f9c-session-closing.test.ts`
- Drive a session into `state==='closing'`, make the cache probe (`reload`) throw, and
  assert the surfaced error is `ESESSIONCLOSING` (→503), NOT the raw error (→500).
- Negative control: when `state` is normal, the original probe error propagates unchanged.

**Automated criteria:**
- [x] New test passes
- [x] `pnpm test:unit` whole-suite green

**Manual criteria:**
- [x] Test asserts the `code` property and message, and the 503 mapping via `mapFsErrorToStatus`.

**Discoveries:**
- Reusing the `FakeFs`/`createFs` mock pattern from `session-manager.lifecycle.test.ts`.
- `ensureFreshCache` requires `redis !== undefined` and a coherent FS (`asCoherentFs`).
  Rather than stand up a real Redis + coherent FS, the test injects a fake `redis` and a
  coherent-FS stub whose `reload()` throws — the minimal surface that exercises the probe.

## Phase 3 — Live API verification

**Manual criteria (recorded below):**
- [x] Happy path: server on :8083, health OK, create sandbox + normal exec → 200, correct output.
- [x] Reaper-race attempt on a second instance with `SESSION_IDLE_MS=800`.
- [x] All started servers killed by PID; shared Redis 6379 untouched.

### Manual Verification — Live results (real Neon + Redis 6379)

**A. Happy path (server :8083, default config):**
- `GET /healthz` → `{"status":"ok"}`.
- `POST /v1/auth/bootstrap` (X-Auth-Secret) → JWT minted.
- `POST /v1/sandboxes` → 201, id `be0ef03b-…`.
- `POST /v1/sandboxes/{id}/exec-sync {"script":"echo hello-f9c"}` → **HTTP 200**,
  `stdout:"hello-f9c\n"`. No regression.

**B. Reaper-race attempt (second instance :8093, `SESSION_IDLE_MS=800`):**
- Warmed a sandbox, then fired 62 concurrent bursts (8 reqs each, 496 total) over ~72 s,
  crossing at least one 60 s reaper tick, sleeping 0.9 s between bursts to let the session
  go idle.
- Result: **496/496 → HTTP 200**, zero 500s, and no `closing`/`ESESSIONCLOSING` events in
  the server log.
- **Honest conclusion:** the live race did NOT reproduce. Two structural reasons (both
  called out in the issue): (1) the idle trigger is effectively closed because every
  request bumps `lastUsed`, so a continuously-probed session never goes idle at a tick;
  (2) the server's reaper interval is hardcoded to 60 s and the closing→disconnect window
  is microseconds, so landing a straggler in it from outside the process is impractical.
  The realistic trigger is **overBudget**, which needs a >budget pathCache — not feasible to
  force from the HTTP surface in a smoke test without code changes (out of F9c scope).
  **The unit test (`session-manager.f9c-session-closing.test.ts`) is the authoritative
  proof:** it deterministically simulates the reaper firing mid-probe and asserts
  ESESSIONCLOSING→503; it was verified to FAIL without the fix (raw error → 500) and PASS
  with it. The live server confirmed the happy-path smoke only (no regression).

**C. Cleanup:** both sandboxes deleted (204); both dev servers killed by PID
(35800, 42508). Shared Redis 6379 left running. (Two unrelated `tsx watch` procs from the
main `virtualFS` checkout were left untouched — not started by this task.)

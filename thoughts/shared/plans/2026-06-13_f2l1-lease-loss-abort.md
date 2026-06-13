# F2-L1: Enforce lease loss — abort the exec on definitive lock loss

## Overview

Both distributed lock wrappers run the critical section to completion and only
**then** check the loss flag (`distributed-rw-lock.ts:421-422`, legacy
`distributed-lock.ts:186-187`). A writer whose lease lapsed mid-script still
commits its script-tx, still `INCR`s the version, and only afterwards throws
`LockLostError` (`ELOCKLOST`). The client sees an error for a write that
**durably happened** → an agent that retries on `ELOCKLOST` double-applies.

This PR ships the issue's Layer 1 "Fix to ship" — it does NOT build the epoch
fence (that is the separate, complete fix in #131/F2-L2):

- Wire the lock's `onLost` callback (DEFINITIVE loss/expiry only — NOT transient
  renew blips; the heartbeat already distinguishes them) to an
  `AbortController.abort()`.
- Plumb that lost-signal into `bash.exec` (which already accepts `opts.signal`),
  composing it with the existing timeout/disconnect signal in the exec routes.
- On definitive loss → bash aborts → `execWithRuntimeThrottle`'s `catch` calls
  `session.scriptTx.abortScope()` → ROLLBACK; the client gets a clean RETRYABLE
  error BEFORE any COMMIT. No committed-then-`ELOCKLOST` lie.

## Current State Analysis

- `src/api/distributed-rw-lock.ts`:
  - `runShared` (`:369`) / `runExclusive` (`:399`) start a heartbeat whose
    `onLost` callback sets a local `lost = true` flag (`:379-381`, `:413-415`).
  - The heartbeat (`startSharedHeartbeat` `:181`, `startExclusiveHeartbeat`
    `:286`) already distinguishes `"ownership_lost"` (token mismatch / renew→0)
    and lease-expiry from a transient renew blip (`:217-224`, `:321-327`); it
    only calls `onLost()` on the former. So `onLost` IS the definitive-loss
    signal we need.
  - `fn` is invoked with NO argument (`:384`, `:421`); the loss flag is only
    consulted AFTER `fn()` resolves (`:385`, `:422`) — the run-then-check bug.
- `src/api/distributed-lock.ts` (legacy single-key path, used when
  `rwlockEnabled=false`): same shape — `lost` flag set by the heartbeat
  (`:170-175`), `fn()` runs to completion, `if (lost) throw` only after
  (`:186-187`).
- `src/api/session-manager.ts`:
  - `withExecLockExclusive` (`:602`) / `withExecLockShared` (`:611`) wrap `fn`
    with `withDistributedRWLock(...)` or legacy `withDistributedLock(...)`.
    When `redis === undefined` they call `fn()` bare (single-replica — no lock,
    no loss possible).
  - The wrapped `fn` ultimately reaches `withSessionEntry` (`:628`) →
    `session.lock.runExclusive` → the route's `fn(session)` →
    `execWithRuntimeThrottle` (`:1293`) → `session.bash.exec(script, opts)`
    (`:1317`, `:1325`). On a throw, `execWithRuntimeThrottle` calls
    `session.scriptTx.abortScope()` (`:1321`) → ROLLBACK.
  - `Session` (`:182`) currently has no field for a lock-lost signal.
- `src/api/routes/exec.ts`:
  - exec-sync (`:166-181`) and exec (SSE, `:262-274`) each build a per-call
    `AbortController` (`controller`) for the timeout; SSE also forwards client
    disconnect (`:267-269`). `controller.signal` is passed to
    `execWithRuntimeThrottle` as `opts.signal` (`:178`, `:285`).
  - The session is available inside the runner callback as `session`.
- `src/api/tests/unit/distributed-rw-lock.test.ts` — FakeRedis mock with
  `forceExclusiveRenewLost` / `forceSharedRenewLost` flags already exercises the
  loss path and asserts `LockLostError`.

## Key Design Decision

The lock wraps the OUTER layer; the timeout `AbortController` is created in the
INNER route handler. To bridge "lock lost" down to `bash.exec`:

1. Change the lock `fn` signature from `() => Promise<T>` to
   `(lostSignal: AbortSignal) => Promise<T>`. The wrappers create an
   `AbortController`, wire `onLost` to `controller.abort(LockLostError)`, and
   invoke `fn(controller.signal)`. (Adding a param is backward-compatible for
   existing `async () => ...` callers.)
2. `SessionManager.withExecLockExclusive/Shared` receive the `lostSignal` and
   stash it on the `Session` (`session.lockLostSignal`) for the duration of the
   locked region, clearing it in `finally`.
3. The exec routes compose `session.lockLostSignal` with their timeout
   controller via `AbortSignal.any([...])` so `bash.exec` aborts on EITHER.
4. Keep the post-`fn` `if (lost) throw LockLostError` as-is: it still converts a
   clean (already-rolled-back) abort into the retryable `ELOCKLOST` the client
   sees. Because the abort fires BEFORE commit, the throw now genuinely means
   "not committed".

## Desired End State

- On definitive lock loss mid-exec: `bash.exec` aborts → `abortScriptScope()`
  ROLLBACK → no COMMIT, no version `INCR` → `withDistributedRWLock` surfaces
  `LockLostError` (`ELOCKLOST`, retryable / 503). The client never sees a
  committed-then-failed write.
- A TRANSIENT renew blip does NOT abort the exec (heartbeat already gates this).
- `pnpm typecheck && pnpm lint:fix && pnpm test:unit` green; live smoke + (best
  effort) live lease-loss injection on real Neon+Redis documented below.

## What We're NOT Doing

- NOT building the epoch fence / version-fence on commit (#131/F2-L2). After L1,
  `ELOCKLOST` means "not committed"; the committed-but-uncertain nuance stays
  with `ECOHERENCE` until #131.
- NOT changing the heartbeat's transient-vs-definitive logic — it is already
  correct and is the signal we consume.

## Implementation Phases

### Phase 1 — Lock wrappers pass a lost-signal to `fn`

**Changes:**
- `distributed-rw-lock.ts`: `withDistributedRWLock` / `runShared` /
  `runExclusive` create an `AbortController`, set `onLost` to `controller.abort(...)`,
  and call `fn(controller.signal)`. Signature: `fn: (lostSignal: AbortSignal) => Promise<T>`.
- `distributed-lock.ts`: same for `withDistributedLock`.

**Automated criteria:**
- [x] `pnpm typecheck` passes.
- [x] Existing `distributed-rw-lock.test.ts` / `distributed-lock.test.ts` pass
  (callers ignore the new arg).

**Manual criteria:**
- [x] `onLost` is wired ONLY to the abort; transient blips still don't call it.

#### Discoveries
- `AbortController.abort(reason)` accepts a reason; passing a `LockLostError`
  makes `signal.reason` carry the retryable code. just-bash surfaces an
  AbortError on abort regardless; the wrapper's post-`fn` `if (lost) throw
  LockLostError` is what the client actually sees, so the reason is for
  diagnostics only.

### Phase 2 — Plumb the signal through SessionManager + exec routes

**Changes:**
- `session-manager.ts`: add `lockLostSignal?: AbortSignal` to `Session`.
  `withExecLockExclusive/Shared` set it before delegating to the inner `fn` and
  clear it in `finally`. (Bare/no-redis path leaves it undefined.)
- `exec.ts`: in exec-sync and exec(SSE), compose `session.lockLostSignal` (if
  present) with the timeout `controller.signal` using `AbortSignal.any` and pass
  the composed signal to `execWithRuntimeThrottle`.

**Automated criteria:**
- [x] `pnpm typecheck` + `pnpm lint:fix` clean.
- [x] `pnpm test:unit` green (session-manager + exec-lock suites).

**Manual criteria:**
- [x] Abort on lost-signal reaches `execWithRuntimeThrottle`'s catch →
  `abortScope()` (verified by reading the throw path + new regression test).

#### Discoveries
- The exec-sync handler treats a resolved exec as success even if the timeout
  timer fired (audit L7). The lost-signal abort fires BEFORE resolution, so the
  exec REJECTS (AbortError) and the catch rethrows → the lock wrapper converts
  it to `LockLostError`. No L7 conflict.
- `withExecLockExclusive/withExecLockShared` are the only two places that hold
  the distributed lock, so stashing the signal there covers every write/read
  exec path (`withSession*`, `withExistingSession`, batch, MCP).

### Phase 3 — Regression test

**Changes:**
- New `session-manager.f2-lease-loss-abort.test.ts`: drive a real
  `SessionManager` with a FakeRedis that fires definitive loss mid-exec, assert
  the script-tx rolled back (abortScope called, no commit, no version INCR) and
  the surfaced error is the retryable `LockLostError`. Assert a transient blip
  does NOT abort.

**Automated criteria:**
- [x] New test green; whole `pnpm test:unit` green.

#### Discoveries
- Re-used the FakeRedis pattern from `distributed-rw-lock.test.ts` and a
  recording mock scriptTx to assert rollback-not-commit without a real DB.

## Manual Verification (LIVE server, real Neon + local Redis :6379, PORT 8082)

Server booted with `tsx --env-file .env src/api/server.ts`; `/healthz` + `/readyz`
returned `{"status":"ok"}`. Token minted via `POST /v1/auth/bootstrap`
(`X-Auth-Secret`). Default lock options (lease 60s, renew 20s).

### A. Happy path — PASS
- [x] Created a sandbox; `exec-sync` of `echo hello-f2l1 > /x; cat /x` returned
  HTTP 200, `stdout="hello-f2l1\n"`, exitCode 0. The abort wiring does not break
  normal execs.

### B. Lease-loss injection — PASS (reproduced live)
- [x] Started a ~26s `exec-sync` (`for i in $(seq 1 52); do sleep 0.5; done; echo
  committed > /y; cat /y`) so the heartbeat's renew (at ~20s) would fire mid-exec.
  Confirmed the writer key `vfs:default:rwlock:{<sandbox>}:writer` was present
  (`redis-cli GET` → token), then `redis-cli DEL`'d ONLY that key at t~1s.
- [x] At the ~20s renew, the heartbeat detected the missing key (RENEW→0 =
  definitive loss), aborted the in-flight exec, and the script-tx ROLLED BACK.
  The HTTP response was **503 with `code: "ELOCKLOST"`** (retryable), NOT a
  committed-then-success lie.
- [x] A follow-up exec confirmed `/y` does NOT exist → the write never committed
  (clean rollback). A normal exec on the same sandbox then returned 200.
- Reproducibility note: with the DEFAULT 20s renew interval the loss is only
  detected at the next heartbeat, so the injection requires an exec that outlives
  one renew cycle (used ~26s). A short (<20s) exec finishes before any renew and
  cannot surface a live loss — the unit/integration regression test (which forces
  the renew to report loss immediately) is the authoritative proof of the
  fast-path behaviour; the live run confirms the end-to-end 503-ELOCKLOST +
  rollback under real Neon + Redis.

### C. Cleanup — PASS
- [x] Server killed by PID; port 8082 free; no orphan dev server from this
  worktree (the only remaining `tsx` processes belong to the separate `/virtualFS`
  checkout, not `/virtualFS-f9a`).

# F4: rwlockEnabled=false — readers take the legacy lock + reload guard

## Overview

With `REDIS_RWLOCK_ENABLED=false` (used during rolling deploys when some replicas
still run the old exclusive-only lock), `withExecLockShared` returns `fn()` **bare** —
readers acquire **no** distributed lock. A same-replica reader's `ensureFreshCache`
→ `reload()` (triggered by a Redis blip or a cross-replica version bump) can run
concurrently with a local writer that holds the in-process exclusive `RWLock`
mid-script. The reload clears `#pathCache` / `#dirty`, clobbering the writer's
uncommitted in-memory view and suppressing its version publish — a silent
data-corruption / divergent-cache window active today during any flag-off deploy.

This PR ships the issue's "Fix to ship":
- (a) When `!rwlockEnabled`, `withExecLockShared` acquires the **same legacy
  single-key lock** writers use, restoring cross-replica AND same-replica
  reader/writer exclusion.
- Flag-independent hardening: `SqlFs.reload()` becomes a no-op while a script
  scope is open, so a concurrent reload can never clobber an open writer's cache
  in **any** mode.
- Docs: the `REDIS_RWLOCK_ENABLED` row states flag-off **serializes reads against
  writers**.

## Current State Analysis

- `src/api/session-manager.ts:575-580` — `withExecLockShared`:
  - `:577` returns `fn()` when `this.redis === undefined` (single-replica, fine).
  - `:578` returns `fn()` **bare** when `!this.rwlockEnabled` — the bug. No
    distributed lock means a flag-off reader runs with no cross-replica or
    same-replica writer exclusion.
  - `:579` normal mode takes the distributed RW lock in shared mode.
- `src/api/session-manager.ts:566-573` — `withExecLockExclusive` (writer path):
  - `:570` flag-off writers take `withDistributedLock(this.redis, execLockKey(tenantId, sandboxId), fn, this.execLockOptions)` — the legacy single-key SET-NX lock. This is the call the reader path must mirror.
- `src/api/distributed-lock.ts:90` — `withDistributedLock(redis, key, fn, opts)`;
  `:206` — `execLockKey(tenantId, sandboxId)` = `vfs:${tenantId}:lock:${sandboxId}`.
- `src/api/session-manager.ts:25` — both `execLockKey` and `withDistributedLock`
  are already imported.
- `src/api/session-manager.ts:868-881` — `withSessionRead` wraps the read in
  `withExecLockShared`; inside, `withSessionReadEntry` (`:648`) calls
  `ensureFreshCache` (`:658`) BEFORE taking the in-process shared `RWLock`
  (`:660`). `ensureFreshCache` (`:743`) calls `coherent.reload()` on a Redis
  error (`:770`) or version mismatch (`:775`).
- `src/sql-fs/sql-fs.ts:549-567` — `reload()` clears `#pathCache`, `#contentCache`,
  and `#dirty`. It is single-flighted via `#pendingReload` but has **no** guard
  against an open script scope.
- `src/sql-fs/sql-fs.ts:171` — `#scriptScope` boolean field; `:571` exposed via
  `get scriptScopeActive()`. Set true in `beginScriptScope` (`:583`), set false
  in `endScriptScope` (`:620`) and `abortScriptScope` (`:655`) — both set it
  false **before** their own `reload()` call (`:637`, `:677`), so a `#scriptScope`
  guard at the top of `reload()` does NOT block those legitimate commit/abort
  reloads.

## Desired End State

- Flag-off: a reader's `withExecLockShared` holds `vfs:{tenant}:lock:{sbx}` — the
  exact key a flag-off writer holds — so reader and writer are mutually exclusive
  on the same key, cross-replica and same-replica. A reader can no longer run its
  `reload()` while a writer holds the lock.
- `reload()` is a no-op while `#scriptScope` is open, in every mode — a
  defense-in-depth backstop independent of the lock fix.
- Docs state flag-off serializes reads against writers.

## What We're NOT Doing

- Not changing normal-mode (`rwlockEnabled=true`) behavior — readers still take
  the distributed RW shared lock and run in parallel.
- Not changing `ensureFreshCache` ordering relative to the in-process `RWLock`
  (the issue explicitly corrects the original "hoist" wording — `ensureFreshCache`
  is already inside the shared-lock callback).
- Not touching the single-replica (`redis === undefined`) path.
- No refactor of the RW lock, version counter, or script-tx machinery.

## Implementation Approach

Two surgical edits + docs + a focused unit test. Mirror the writer's flag-off
call exactly in the reader path; add a one-line guard to `reload()`.

## Phase 1 — Fix (a): flag-off readers take the legacy single-key lock

### Changes Required
- `src/api/session-manager.ts` `withExecLockShared`: replace `:578`
  `if (!this.rwlockEnabled) return fn();` with
  `if (!this.rwlockEnabled) return withDistributedLock(this.redis, execLockKey(tenantId, sandboxId), fn, this.execLockOptions);`
  and update the method docstring to note the flag-off behavior.

### Success Criteria
**Automated:**
- [x] `pnpm typecheck` passes.
- [x] `pnpm lint:fix` clean.
- [x] New unit test: flag-off `withSessionRead` acquires `execLockKey(...)`
      (assert the string key exists in FakeRedis during fn) and a concurrent
      flag-off writer + reader serialize (mutual exclusion).
- [x] Existing `session-manager.exec-lock.test.ts` and
      `session-manager.read-only.test.ts` still pass unchanged.

**Manual:**
- [x] Confirm `execLockKey` / `withDistributedLock` / `this.execLockOptions`
      names match the writer path exactly (they do).

### Discoveries
- Writer flag-off key = `vfs:T:lock:sbx` (`execLockKey`); RW-lock writer key =
  `vfs:T:rwlock:{sbx}:writer`. They are distinct keyspaces — the reader MUST use
  `execLockKey` (not the RW key) to be mutually exclusive with the flag-off writer.

## Phase 2 — Flag-independent hardening: guard reload() during script scope

### Changes Required
- `src/sql-fs/sql-fs.ts` `reload()` (`:549`): add `if (this.#scriptScope) return;`
  as the first statement, with a comment explaining it prevents clobbering an
  open writer's uncommitted in-memory cache. Verified safe: `endScriptScope` /
  `abortScriptScope` clear `#scriptScope` before their own `reload()`.

### Success Criteria
**Automated:**
- [x] `pnpm typecheck` passes.
- [x] New unit test: `reload()` is a no-op while a script scope is open (pathCache
      untouched), and resumes reloading after `endScriptScope`.
- [x] `sql-fs.script-tx.test.ts` still passes (commit/abort reloads unaffected).

**Manual:**
- [x] Re-read `endScriptScope`/`abortScriptScope` to confirm `#scriptScope=false`
      precedes their `reload()` calls.

### Discoveries
- (none yet)

## Phase 3 — Docs + changeset

### Changes Required
- `CLAUDE.md` `REDIS_RWLOCK_ENABLED` row: state that when `false`, readers take
  the legacy single-key lock — flag-off **serializes reads against writers**.
- `DEVELOPER.md`: does not document `REDIS_RWLOCK_ENABLED` — no change.
- `.changeset/fix-f4-rwlock-reader-lock.md`: `"sql-fs-api": patch`.

### Success Criteria
**Automated:**
- [x] Final gate: `pnpm typecheck && pnpm lint:fix && pnpm test:unit` all pass.

**Manual:**
- [x] CLAUDE.md row reads correctly.

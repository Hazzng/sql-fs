# F1: Poisoned publish — guard `publishVersionIfDirty` with a `#cachePoisoned` flag

## Overview

A correlated Postgres failure can publish *uncommitted* ("phantom") filesystem
state under a fresh, authenticated version stamp. When the same PG outage fails
both the script-tx COMMIT **and** the recovery `reload()`/`loadAllPaths`, the
in-memory `#pathCache` (and possibly `#contentCache`) is left holding mutations
that never landed in Postgres, while `#dirty` stays `true`. The subsequent
`publishVersionIfDirty` (Redis is an independent, still-healthy failure domain)
then `INCR`s the version counter and optionally writes a path snapshot from the
poisoned cache — authenticating data that does not exist.

This plan adds an explicit `#cachePoisoned` flag to `SqlFs`, sets it in both
reload-failure swallow catches, clears it on every successful load, and makes
`publishVersionIfDirty` refuse to publish while poisoned (suppressing the INCR +
snapshot and forcing a self-heal reload on next use).

## Current State Analysis

- `src/sql-fs/sql-fs.ts:618-651` — `endScriptScope`: on COMMIT failure it runs
  `reload(); clearDirty()` inside a `try`, and **swallows** a reload failure at
  `:639-642` (empty catch, falls through to re-throw the original COMMIT error).
- `src/sql-fs/sql-fs.ts:653-689` — `abortScriptScope` (exec-error path): same
  `reload(); clearDirty()` recovery, swallows a reload failure at `:679-687`
  (logs only, must not mask the caller's original error).
- `src/sql-fs/sql-fs.ts:549-567` — `reload()`: on success clears caches and sets
  `#dirty = false` at `:559`.
- `src/sql-fs/sql-fs.ts:519-535` — `ready()`: loads the initial pathCache.
- `src/sql-fs/sql-fs.ts:101-114` — `ICoherentFs` interface (`reload`, `wasDirty`,
  `clearDirty`, `bulkIngest`).
- `src/sql-fs/sql-fs.ts:153` — `#dirty = false` field; `:204-210` — `wasDirty()` /
  `clearDirty()`.
- `src/api/session-manager.ts:787-833` — `publishVersionIfDirty`: gate at
  `:791-792` (`if (!dirty && !session.publishPending) return;`), INCR at `:797`,
  INCR-failure suppress machinery at `:805-810` (sets `lastSeenVersion = -1`,
  `publishPending = true`, throws `ECOHERENCE`), snapshot write at `:817-821`,
  success finalize at `:830-832`.
- `src/api/session-manager.ts:71-81` — `asCoherentFs()` structural guard.

## Desired End State

- `SqlFs` exposes a `poisoned(): boolean` getter backed by a `#cachePoisoned`
  field, declared on `ICoherentFs`.
- A swallowed reload failure in either `endScriptScope` or `abortScriptScope`
  sets `#cachePoisoned = true`.
- Any successful `reload()` and `ready()` clears `#cachePoisoned = false`.
- `publishVersionIfDirty` checks `poisoned()` first; while poisoned it skips the
  INCR + snapshot, sets `session.lastSeenVersion = -1`, `session.publishPending =
  false`, and throws `ECOHERENCE`. The poison self-heals because the next
  `ensureFreshCache` sees `lastSeenVersion === -1` and reloads from Postgres.

## What We're NOT Doing

- No change to the COMMIT/abort recovery flow other than setting the flag.
- No change to the INCR-failure branch (`publishPending = true` semantics there
  remain — that path is a transient Redis failure, not a poisoned cache).
- No content-cache redesign, no new metrics, no F3 (#132) work.
- No change to the `memory` (InMemoryFs) backend.

## Implementation Approach

Single localized change across two files plus one regression test. The
`poisoned()` getter mirrors `wasDirty()`; the publish guard mirrors the existing
INCR-failure suppress machinery but points it in the *refuse-to-publish*
direction.

---

## Phase 1 — Add `#cachePoisoned` flag, `poisoned()` getter, interface member

### Changes Required

- `src/sql-fs/sql-fs.ts`
  - Add `#cachePoisoned = false` field near `#dirty` (`:153`).
  - Add `poisoned(): boolean` getter near `wasDirty()`/`clearDirty()` (`:204-210`).
  - Add `poisoned(): boolean` to the `ICoherentFs` interface (`:101-114`) with a
    docstring.
- Set `#cachePoisoned = true` in the swallow catch of `endScriptScope` (`:639-642`).
- Set `#cachePoisoned = true` in the swallow catch of `abortScriptScope`
  (`:679-687`), alongside the existing `console.error`.
- Clear `#cachePoisoned = false` in `reload()` right after `#dirty = false`
  (`:559`).
- Clear `#cachePoisoned = false` in `ready()` after the successful load (~`:534`).

### Success Criteria

#### Automated Verification
- [x] `pnpm typecheck` passes.
- [x] `pnpm lint:fix` clean.
- [x] `pnpm test -- src/sql-fs/tests/sql-fs.script-tx.test.ts` passes (existing).

#### Manual Verification
- [x] `poisoned()` returns `false` after `ready()` and after a successful `reload()`.

### Discoveries and Notable Information

---

## Phase 2 — Guard `publishVersionIfDirty` with `poisoned()`

### Changes Required

- `src/api/session-manager.ts`
  - In `publishVersionIfDirty` (`:787-833`), after `coherent` is resolved and
    BEFORE the `wasDirty`/`publishPending` gate (`:791-792`), check
    `coherent.poisoned()`. If poisoned: skip INCR + snapshot, set
    `session.lastSeenVersion = -1`, `session.publishPending = false`, and throw
    `Object.assign(new Error("ECOHERENCE: ..."), { code: "ECOHERENCE" })`.

### Success Criteria

#### Automated Verification
- [x] `pnpm typecheck` passes.
- [x] `pnpm lint:fix` clean.
- [x] `pnpm test:unit` passes.

#### Manual Verification
- [x] A poisoned `SqlFs` causes `publishVersionIfDirty` to throw `ECOHERENCE`
      without calling `redis.incr`.

### Discoveries and Notable Information

---

## Phase 3 — Regression test

### Changes Required

- `src/sql-fs/tests/sql-fs.script-tx.test.ts`
  - Add a test modeled on the H7 COMMIT-failure test, but make the recovery
    `reload()` also fail (make `loadAllPaths` throw while `failNextCommit` is set
    so the post-COMMIT reload throws too). Assert:
    - `fs.poisoned() === true` after the failed `endScriptScope`.
    - `publishVersionIfDirty` (exercised via a minimal session stub, or by
      asserting the publish-guard preconditions directly) skips INCR and throws
      `ECOHERENCE`, and `session.lastSeenVersion === -1`.

### Success Criteria

#### Automated Verification
- [x] New test passes: `pnpm test -- src/sql-fs/tests/sql-fs.script-tx.test.ts`.
- [x] `pnpm typecheck && pnpm lint:fix && pnpm test:unit` all green.

#### Manual Verification
- [x] Existing H7 test still passes unchanged.

### Discoveries and Notable Information

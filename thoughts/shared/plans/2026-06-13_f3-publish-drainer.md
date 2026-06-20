# F3 — Durable background publish drainer

## Overview

A committed write whose Redis `INCR` fails (transient Redis blip) leaves other
replicas serving the pre-write tree indefinitely. Data is durable in Postgres;
only cross-replica *visibility* of the version bump is stranded. Today repair is
hostage to a later mutating write **on the same replica** — and if the reaper
idle-evicts the session first, the in-memory `publishPending` flag is discarded
and the bump is permanently lost (until any unrelated write anywhere bumps the
counter and forces laggards to reload).

This adds a durable, in-process background drainer that retries stranded
publishes, plus a best-effort publish when a `publishPending` session is reaped.

## Current State

- `src/api/session-manager.ts:915` `publishVersionIfDirty` — INCR-failure branch
  (`:939-952`) sets `lastSeenVersion=-1`, `publishPending=true`, throws ECOHERENCE
  **without** `clearDirty`. Nothing schedules a retry.
- `src/api/session-manager.ts:252` `Session.publishPending` doc-comment claims the
  next successful turn "guarantees other replicas eventually see the prior write"
  — false once the session is reaped before that turn.
- `src/api/session-manager.ts:1277` `runReaper` disconnects idle sessions with no
  attempt to flush a pending publish first.
- `src/api/session-manager.ts:1202` `startReaper` / `:1270` `stopReaper` /
  `:1217` `shutdown` manage the reaper timer lifecycle.
- `src/api/session-manager.ts:871` `ensureFreshCache` clears `#dirty` via
  `coherent.clearDirty()` on a `-1`→current reload — the drainer must re-check
  under the lock to avoid a double INCR (V+2) racing this.

## Desired End State

- A `pendingPublishes: Set<string>` (session keys) populated in the INCR-failure
  branch.
- An unref'd `setInterval` drainer (tied to the reaper lifecycle) that, per
  pending key, takes `session.lock.runExclusive` and re-runs
  `publishVersionIfDirty` keyed off `session.publishPending` (re-checked under the
  lock). Successful publish removes the key; persistent failure keeps it for the
  next tick (simple fixed-interval backoff).
- `runReaper` attempts one best-effort publish (under the lock, FS still
  connected) before disconnecting a `publishPending` session.
- DEL-key fallback rejected (shares the INCR failure domain).
- Interval `.unref()`-ed and cleared on `stopReaper`/`shutdown`.
- `Session.publishPending` doc-comment corrected.

## What We're NOT Doing

- No durable (Redis/PG) persistence of pending publishes across replica restarts
  — the write is already durable in PG; convergence on restart still happens via
  the next write anywhere. This is in-process healing only.
- No DEL-and-recreate of the version key.
- No change to the ECOHERENCE error surfaced to the live caller.

## Phase 1 — pendingPublishes Set + drainer + reap flush + doc-comment

### Changes

1. Add `private readonly pendingPublishes: Set<string>` and
   `private drainerTimer` field.
2. In the INCR-failure branch, `this.pendingPublishes.add(this.sessionKey(...))`.
   On a successful publish and in the poisoned-suppress branch, remove the key.
3. Add `private async drainPendingPublishes()` that iterates a snapshot of the
   set, looks up the live session, skips closing/missing ones, and runs
   `session.lock.runExclusive(() => this.publishVersionIfDirty(...))`. Re-check
   `session.publishPending` under the lock; clear from set on success or when the
   session no longer needs publishing.
4. Start the drainer interval inside `startReaper`; `.unref()` it; clear it in
   `stopReaper`.
5. In `runReaper`, when evicting a `publishPending` session, run one best-effort
   `publishVersionIfDirty` under the lock before `disconnectFs`.
6. Fix the `Session.publishPending` doc-comment.

### Success Criteria

#### Automated
- [ ] `pnpm typecheck` clean
- [ ] `pnpm lint:fix` clean
- [ ] New unit tests pass; existing `session-manager.version-counter.test.ts` unchanged and green
- [ ] `pnpm test:unit` green

#### Manual
- [ ] Live server boots on :8131, read-your-writes + version counter increments
- [ ] Server shuts down cleanly (no hang/leak) with the drainer interval present

### Discoveries

- `pendingPublishes` keys are `${tenantId}:${sandboxId}` (matches `sessionKey`); the
  drainer needs to recover tenant+sandbox to call `publishVersionIfDirty`, so the
  set stores keys and the drainer splits on the first `:` — but tenant ids may
  contain `:`? They don't in this codebase (default tenant), and the version key
  builder already assumes a flat tenant id. To be safe the drainer looks the
  session up by stored key directly and reads `session.tenantId` + reconstructs
  sandboxId from the key suffix. Simpler: store a `{tenantId, sandboxId}` tuple
  instead of a string. Chosen: store the session key string and resolve via a
  parallel map is overkill — instead the drainer reads the live `Session` (which
  carries `tenantId`) and derives sandboxId by stripping the `${tenantId}:` prefix.
- The INCR-failure → drainer recovery cannot be triggered cleanly against a live
  Redis; covered by unit tests (Step 3) and noted in the PR.

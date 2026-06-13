# F6: Hot CAS blob contention — decouple blob upsert into its own short tx

## Overview

Deduplicated "hot" blobs (the empty-file sha, `.gitkeep`, common lockfiles) are a
single `blobs` row whose `INSERT ... ON CONFLICT (sha256) DO UPDATE SET
last_referenced_at = now()` tuple lock is held for the **whole script** when the
touch runs inside the long-lived, advisory-locked script-tx. Postgres holds the
conflicting-tuple lock to end-of-tx even when a conditional `WHERE` filters out
the update, so conditional-WHERE alone does NOT fix it. The result: unrelated
sandboxes **within one tenant DB** serialize on that single hot row, and combined
with the `max=2` PG pool and no `lock_timeout`, this is a fleet-wide
pool-exhaustion → 503 path.

This PR ships the issue's "Fix to ship" — the **decoupled-tx** shape:

- Add `PostgresDialect.commitBlob(sha256, data)`: commits the CAS blob upsert in
  its **own short, self-committing transaction** on a separate pool connection,
  with **no advisory lock** (`blobs` is unscoped CAS — no `sandbox_id`, no RLS).
- `writeFileComposite` runs **without** its `blob_insert` CTE; the SqlFs layer
  calls `commitBlob` **before** the composite (and before the legacy
  `upsertBlob` fallback path).
- `bulkIngest` commits its unique blobs via `commitBlob` first, then runs the
  inode/dirent composite without the in-tx blob insert.
- The touch stays **unconditional** so the GC grace window
  (`BLOB_GC_MIN_AGE_MS`, default 3h) protects the freshly-committed-but-not-yet-
  referenced blob during the gap between blob-commit and inode-commit.
- Preserve the GC re-adoption handshake (`blob-gc.ts` REPEATABLE READ + 40001
  retry) and RLS / `set_config('app.sandbox_id')` / `runTrustedDbAsync`
  (defense-in-depth) wrapping.

## Current State Analysis

- `src/sql-fs/dialects/postgres.ts:170-218` — `writeFileComposite`: the
  `blob_insert` CTE at `:175-179` runs the `ON CONFLICT (sha256) DO UPDATE SET
  last_referenced_at = now()` inside the script-tx (advisory-locked via the `ctx`
  CTE). This holds the hot-blob tuple lock to COMMIT.
- `src/sql-fs/dialects/postgres.ts:598-614` — `upsertBlob`: same touch, in-tx
  (used only by the non-composite fallback path).
- `src/sql-fs/dialects/postgres.ts:1001` — `bulkIngest`: `INSERT INTO blobs ...
  ON CONFLICT (sha256) DO UPDATE SET last_referenced_at = now()` in the script-tx.
- `src/sql-fs/dialects/postgres.ts:58` — pool `max=2`.
- `src/sql-fs/dialects/postgres.ts:272` — `db()` returns the pool; a bare
  `this.db()` call auto-commits a single statement (own connection, own tx).
- `src/sql-fs/sql-fs.ts:797-825` / `:874-902` — `writeFile` / `appendFile` route
  the composite through `#withBareTx` (which routes to the open script-tx when a
  scope is active), with a non-composite fallback that calls `upsertBlob` inside
  `#withTx`.
- `src/sql-fs/sql-fs.ts:760` — `bulkIngest` routes through `#withTx`.
- `src/api/blob-gc.ts:39-61` — GC runs at REPEATABLE READ, retrying 40001. The
  handshake: a writer touches (`last_referenced_at = now()`) + locks an existing
  orphan blob, then inserts the referencing inode; under RR that conflicts with
  GC's snapshot and raises 40001, so GC retries and then sees the inode. The
  decoupled tx commits the touch FIRST (own tx) and the inode SECOND (composite
  tx); the grace window covers the gap so a GC sweep landing between the two
  commits keeps the blob (its `last_referenced_at` is now-fresh, younger than
  `minAgeMs`).
- `src/sql-fs/types.ts:300-306` — `SqlDialect.upsertBlob`; new optional
  `commitBlob` added alongside.

## Desired End State

- The CAS blob row is touched in a sub-second self-committing tx and released
  immediately. The script-tx no longer holds any lock on the `blobs` row.
- Two sandboxes writing the same hot bytes do not serialize on the blob row for
  the script duration.
- Dedup + content round-trip unchanged. GC re-adoption invariant preserved.

## What We're NOT Doing

- Not changing MySQL / Azure SQL dialects (Postgres is the only live backend; the
  optional `commitBlob` is absent there and SqlFs falls back to the existing
  in-tx `upsertBlob` path).
- Not adding `lock_timeout` (separate concern, out of scope for F6).
- Not removing the unconditional touch (the grace window depends on it).

## Implementation Phases

### Phase 1 — Add `commitBlob` to the dialect interface + Postgres impl; drop `blob_insert` CTE

- Add optional `commitBlob(sha256, data)` to `SqlDialect` in `types.ts`.
- Implement `PostgresDialect.commitBlob`: `runTrustedDbAsync(() => this.db()\`INSERT
  INTO blobs ... ON CONFLICT (sha256) DO UPDATE SET last_referenced_at = now()\`)`.
  Own connection, auto-committing single statement, no advisory lock. Fire the
  Redis blob cache set after (like `upsertBlob`).
- Remove the `blob_insert` CTE from `writeFileComposite` (keep the Redis set).
- Replace the in-tx blob INSERT in `bulkIngest` with a `commitBlob` loop over the
  unique blobs (committed before the inode/dirent work).

**Automated success criteria:**
- [x] `pnpm typecheck` passes.
- [x] `pnpm lint:fix` clean.

**Manual success criteria:**
- [x] `writeFileComposite` SQL no longer contains `blob_insert`.

### Phase 2 — Call `commitBlob` from SqlFs before the composite / upsertBlob

- In `writeFile` / `appendFile`: call `this.#dialect.commitBlob?.(...)` (await)
  BEFORE the composite when `commitBlob` is present; otherwise the existing
  fallback `upsertBlob` inside `#withTx` is unchanged.
- `bulkIngest`: blobs are committed inside `dialect.bulkIngest` via `commitBlob`,
  so SqlFs needs no change there — verify the composite no longer needs the blob.

**Automated success criteria:**
- [x] `pnpm typecheck` passes.
- [x] `pnpm test:unit` green.

**Manual success criteria:**
- [x] Composite-path write still dedups and round-trips (live A + integration).

### Phase 3 — Regression test

- Unit (mock dialect): assert `commitBlob` is invoked and that it runs on a tx/
  connection separate from the composite (the mock records call order: `commitBlob`
  before `writeFileComposite`, and `commitBlob` is NOT passed the script-tx handle).
- Integration (gated `skipIf(!DATABASE_URL)`): two writes of identical bytes both
  succeed, dedup holds (same sha, one blob row), and the second write does not
  block on a lock held by the first's still-open script-tx.

**Automated success criteria:**
- [x] New unit test passes; `pnpm test:unit` green (959 tests).

**Manual success criteria:**
- [x] Integration test passes locally against Neon.

### Phase 4 — LIVE API verification (see Manual Verification below)

## Manual Verification

Live server booted on :8081 (`tsx --env-file .env src/api/server.ts`) against
real Neon + Redis 6379. `/healthz` + `/readyz` → 200. Token via
`POST /v1/auth/bootstrap` (X-Auth-Secret). Server killed by PID afterward; Redis
6379 left running.

### A. Dedup + correctness — PASS
- Sandbox created; `printf "hot-dedup-content" > /a.txt; cp /a.txt /b.txt`.
- Both files round-trip the exact content; `sha256sum` identical for /a.txt and
  /b.txt (`14c3886b…29407`) → dedup holds, content correct. exec 200, exitCode 0.

### B. Concurrency (the F6 point) — PASS
- Two sandboxes, two CONCURRENT `exec-sync` each writing the SAME hot bytes
  (`> /k` universal empty blob, then `printf "shared-hot-bytes" > /hot.txt`).
- Both 200, exitCode 0. Wall clock: **single write = 498 ms**, **concurrent
  (both sandboxes) = 586 ms** — ≈ a single write, NOT ~2× (which is what
  serialization on the shared blob row would produce). No multi-second mutual
  block.
- Longer-script variant (50-line loop) also ran in parallel: wall ≈ 6.67 s ≈ the
  max of the two (~6.3 s / ~6.6 s), not the sum (~13 s).
- DB check: exactly **1** blob row for the `shared-hot-bytes` sha despite two
  sandboxes writing it → CAS dedup intact.

### GC re-adoption handshake — preserved
- `commitBlob`'s touch (`last_referenced_at = now()`) is unconditional; the
  blob commits FIRST (own tx), the referencing inode commits SECOND (composite
  tx). A GC sweep landing in the gap sees a now-fresh `last_referenced_at` (well
  inside `BLOB_GC_MIN_AGE_MS`, default 3h) and keeps the blob. `blob-gc.ts`
  REPEATABLE READ + 40001 retry is unchanged; integration GC tests in
  `postgres.test.ts` still pass.

### Note: pre-existing RLS test failures (NOT this change)
- `rls.integration.test.ts` has 3 failing assertions on this Neon DB; verified
  they fail identically on the base `main` worktree (environmental — the Neon
  role/policy state, unrelated to F6). Left untouched.

## Discoveries

- `#withBareTx` routes composite writes through the open script-tx when a scope is
  active (the long-lived advisory-locked tx) — that is exactly why the in-tx blob
  touch held the lock for the whole script. `commitBlob` deliberately bypasses
  `#withBareTx`/`#withTx` and goes straight to `this.db()` so it commits
  independently of the script scope.
- `blobs` has no RLS policy and no `sandbox_id` (migration 0000), so `commitBlob`
  correctly skips `set_config('app.sandbox_id')` and the advisory lock.

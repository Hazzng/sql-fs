# F9a: writeFile leaks displaced inode's contentCache entry

## Overview

`SqlFs.writeFile` creates a new inode on every write and updates `#pathCache`,
but never evicts the **old** (displaced) inode's bytes from the `#contentCache`
LRU. Because inode ids are BIGSERIAL and never reused, the old entry becomes
dead, unreachable LRU weight. `appendFile`, `bulkIngest`, and `rm` all already
evict. Memory-only, self-healing (reload clears the cache; the dead entry is
LRU-evicted first), but a warm session looping large-file overwrites without a
reload accumulates orphans up to the 50 MB cap, reducing effective live
capacity. Issue: Hazzng/sql-fs#138.

## Current State

- `src/sql-fs/sql-fs.ts:738-791` — `writeFile`: pathCache lookup at `:743`
  (kind check only), `#contentCache.set(inodeId, bytes)` at `:789` guarded by
  `byteLength > 0`. No eviction of the displaced inode.
- `src/sql-fs/sql-fs.ts:716-720` — `bulkIngest` evicts: `const old =
  this.#pathCache.get(path); if (old !== undefined && old.inodeId !==
  entry.inodeId) this.#contentCache.delete(old.inodeId);` — the pattern to mirror.
- `src/sql-fs/sql-fs.ts:849` — `appendFile` evicts via `existing.inodeId`.
- Critical sub-case: overwriting a non-empty cached file with an **empty** file
  takes no seeding `set` (guarded by `byteLength > 0`), so nothing displaces the
  old entry — it must be evicted explicitly.

## Desired End State

`writeFile` evicts the displaced inode's `#contentCache` entry before seeding the
new one, for both the non-empty and empty-overwrite cases, matching `bulkIngest`.

## What We're NOT Doing

- Not changing `appendFile`, `bulkIngest`, `rm` (already correct).
- Not refactoring the write transaction or the composite/sequential split.
- Not adding a shared helper (the inline guard mirrors `bulkIngest` and reads
  cleanly; a helper would not reduce the diff meaningfully).

## Phase 1 — Evict displaced inode in writeFile

### Changes

1. `src/sql-fs/sql-fs.ts` — in `writeFile`, before the `#contentCache.set` at
   `:789`, look up the current pathCache entry for `path` and, if its `inodeId`
   differs from the freshly created `inodeId`, `#contentCache.delete` it. Runs
   unconditionally (not behind `byteLength > 0`) so the empty-overwrite case is
   covered.
2. `src/sql-fs/sql-fs.ts` — add `@internal _getContentCache()` accessor
   mirroring `_getPathCache()`, so a unit test can assert eviction directly.
3. `src/sql-fs/tests/unit/sql-fs.writefile-cache-evict.test.ts` — new focused
   test: non-empty overwrite evicts old inode + caches new; empty overwrite
   evicts old inode and drops `calculatedSize` to 0; new-path write does not
   over-evict.

### Success Criteria

#### Automated
- [x] `pnpm typecheck` passes
- [x] `pnpm lint:fix` clean
- [x] `pnpm test:unit` passes, including the new test file
- [x] New test fails without the source fix (verified by reverting locally)

#### Manual
- [x] Diff is minimal and F9a-scoped (one guard block + test accessor + test).
- [x] Eviction guard mirrors `bulkIngest`'s at `:716-720`.

### Discoveries
- inode ids are BIGSERIAL and never reused — confirmed; the displaced entry can
  never be re-read by id, so deletion is always safe.
- `#contentCache` had no test accessor; added `_getContentCache()` (mirrors the
  existing `_getPathCache()` `@internal` pattern) rather than asserting eviction
  indirectly through the LRU cap (which self-heals for equal-size overwrites and
  would not be a clean discriminator).
- The empty-overwrite case is the only path with no overwriting `set`, so the
  eviction must be unconditional — confirmed by the dedicated test asserting
  `calculatedSize === 0` afterwards.

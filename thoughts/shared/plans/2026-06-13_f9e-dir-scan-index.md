# F9e: O(N) directory scans — incremental byte counter (+ children map)

## Problem / Goal

`readdir`/subtree ops walk the entire `#pathCache` per call, and
`SessionManager.estimatePathCacheBytes` re-walks the full path list
(`fs.getAllPaths()` → `Σ p.length + 100`) after every dirty exec
(`getOrCreate` and `withExecLock`'s finally). Invisible at 10³ paths,
a repeated O(N) cost per turn at 10⁵.

Issue #142 ("F9e", Real — Low). Ship in two parts:

- **(A)** Incremental `#pathCacheBytes` counter inside `SqlFs`, maintained
  O(1) at every `#pathCache` set/delete/clear, reset on `reload()`/`ready()`.
  Expose `getPathCacheBytes()`; `SessionManager` calls it instead of the
  full re-walk. Values MUST equal the old `estimatePathCacheBytes` exactly.
- **(B)** `#childrenByParent: Map<string, Set<string>>` to make `readdir`
  O(children) — ONLY if every mutation site (set/delete, cp/mv subtree,
  reload/ready clear+repopulate) is covered + tested. Otherwise DEFER.

## Discoveries

- `estimatePathCacheBytes` lives in `src/api/session-manager.ts:475`, NOT
  `sql-fs.ts` (issue line numbers predate batch-2 and refer to call-site
  intent). Formula: `for each path: total += p.length + 100`. Depends ONLY
  on the set of path-string keys, so the exact value is
  `Σ key.length + 100 * pathCache.size`.
- Call sites: `session-manager.ts:544` (getOrCreate) and `:725`
  (withExecLock finally, guarded by `shouldRefreshPathBudget`).
- 18 direct `#pathCache.{set,delete,clear}` sites in `sql-fs.ts`
  (incl. `#updateCacheByInode` which only patches an EXISTING key — must
  not change the byte count). Routing all through `#cacheSet/#cacheDelete/
  #cacheClear` helpers keeps the counter exact and central.
- `_getPathCache()` is exposed but used externally for READS only
  (snapshot writer + tests). No external mutation path to miss.
- `reload()`/`ready()` both `clear()` then repopulate via `set` — both
  already routed through the helpers, so the counter resets correctly.

## Decision on (B)

DEFER (B). `readdir`/`#childPaths` correctness is silently broken if any
mutation site desyncs the children map; (A) delivers the higher-value,
lower-risk win the issue calls for ("ship (A) first"). (B) is
benchmark-gated in the issue and not required for the acceptance criteria
of this PR. Noted in the PR body as a follow-up.

## Phase 1 — (A) incremental byte counter

### Changes
- `sql-fs.ts`: add `#pathCacheBytes = 0`; add private `#cacheSet`,
  `#cacheDelete`, `#cacheClear` helpers maintaining it O(1); route all 18
  mutation sites through them. Add public `getPathCacheBytes(): number`.
- `session-manager.ts`: `estimatePathCacheBytes` prefers
  `fs.getPathCacheBytes()` when present, else falls back to the full walk
  (memory backend / other IFileSystem impls have no counter).

### Automated criteria
- [x] `pnpm typecheck` passes
- [x] `pnpm lint:fix` clean
- [x] New unit test: counter equals old full-walk across write/delete/
      overwrite/mkdir/cp/mv/rm -r and after `reload()`/`ready()`
      (`sql-fs.path-cache-bytes.test.ts`, 11 tests)
- [x] `pnpm test:unit` green (985 passed) — no weakened tests

### Manual criteria
- [x] LIVE (Neon + Redis, port 8134): built a 35-file/10-dir tree, then
      cp -r / mv / rm -r; `ls`, `ls -R`, and `GET /tree` all returned
      complete, correct, consistent listings (`find` 46 vs tree-API 45,
      i.e. minus the root prefix). No server errors; no crash.

## Phase 2 — (B) children index

DEFERRED to a follow-up PR (see Decision above).

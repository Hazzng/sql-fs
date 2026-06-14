# F7 — Destroy must reach warm replicas: tombstone + sandbox-gone reload guard

## Problem

Destroying a sandbox on replica A does not reach warm sessions on other
replicas. Two failure modes:

1. **Written session.** `deleteVersionKey` uses `redis.del`. Replica B's next
   `ensureFreshCache` probe reads the (now absent) version counter as `0`,
   mismatches its `lastSeenVersion`, and calls `reload()`. `reload()` runs
   `loadAllPaths` against a deleted sandbox (0 rows), installs an EMPTY
   pathCache, and serves ghost state — observably a non-zero exit + garbage
   stderr inside an HTTP 200 exec (cwd resolution against an empty cache),
   which is worse than a clean 404.
2. **Never-written session.** If B observed zero writes, `lastSeenVersion = 0`.
   After destroy the absent counter also reads `0`, so `0 === 0` → **no reload
   fires at all** → B serves its populated cache against a deleted sandbox. A
   loadAllPaths-empty guard alone does NOT cover this; only a distinct sentinel
   does (`0 !== sentinel`).

## Fix to ship (layered)

### Primary (Redis-independent)
`#loadFreshPathCache` detects a zero-row `loadAllPaths` (the postgres CTE anchor
returns 0 rows only when the sandbox/root is absent) and throws a typed
`ESANDBOXGONE` error instead of installing an empty cache. `reload()` propagates
it. `ensureFreshCache` catches `ESANDBOXGONE`, tears the warm session down
(mark closing, remove from the map, disconnect the PG pool), and rethrows as a
clean `ENOENT` → 404.

### Secondary (tombstone)
`deleteVersionKey` writes a sentinel instead of deleting:
`redis.set(versionKey, 'DESTROYED', 'EX', VERSION_KEY_TTL_SECONDS)`. This covers
the never-written variant: `ensureFreshCache` recognizes the sentinel BEFORE the
numeric parse and tears down, even when `lastSeenVersion === 0`. The sentinel
string is `DESTROYED` — distinct from `-1` (the publish-failure marker).

### Audit every `Number(raw) || 0` clamp site
- `session-manager.ts` `ensureFreshCache` (raw GETEX) — recognize sentinel before parse.
- `session-manager.ts` session creation `initialVersion` — recognize sentinel; a session created against a tombstoned sandbox must not start at `0`.
- `sql-fs.ts` `#loadFreshPathCache` snapshot version check — sentinel must not coerce to `0` and falsely match a `version:0` snapshot.

## Discoveries

- Line numbers in the issue predate batch-2. Located by symbol:
  - `reload()` / `#loadFreshPathCache` → `src/sql-fs/sql-fs.ts`
  - `loadAllPaths` CTE anchor → `src/sql-fs/dialects/postgres.ts:770`
  - `deleteVersionKey` / `ensureFreshCache` / `initialVersion` → `src/api/session-manager.ts`
- `ENOENT` and `ESESSIONCLOSING` are already in `SAFE_FS_ERROR_CODES`; `ENOENT` → 404. We surface `ENOENT` (not a new code) so the route layer needs no change.
- Reaper teardown pattern (`session-manager.ts:1287`) is the template for `#tearDownGoneSession`: set `state="closing"`, `sessions.delete(key)`, `disconnectFs`.
- `mysql`/`azure-sql` dialects also implement `loadAllPaths`; the zero-row guard lives in `sql-fs.ts` (dialect-agnostic), so all dialects benefit.

## Phases

### Phase 1 — Primary: ESANDBOXGONE guard
- [ ] Add `createEsandboxgone(sandboxId)` to `src/sql-fs/errors.ts` (code `ESANDBOXGONE`).
- [ ] In `#loadFreshPathCache`, after the `loadAllPaths` query, if rows are empty throw `ESANDBOXGONE`.
- [ ] `reload()` lets the error propagate (no empty cache installed; old cache untouched by the load-before-clear ordering).
- [ ] `ensureFreshCache` catches `ESANDBOXGONE`, tears down the session, rethrows `ENOENT`.
- Automated: unit test (b)/(a) below.

### Phase 2 — Secondary: tombstone sentinel
- [ ] `deleteVersionKey` → `redis.set(key, 'DESTROYED', 'EX', VERSION_KEY_TTL_SECONDS)`.
- [ ] Export `VERSION_TOMBSTONE` constant.
- [ ] `ensureFreshCache` recognizes the sentinel before the numeric parse → tear down + ENOENT.
- [ ] `initialVersion` (session creation) recognizes the sentinel.
- [ ] `#loadFreshPathCache` snapshot version check recognizes the sentinel (treat as mismatch).
- Automated: unit tests (b)/(c) below.

### Phase 3 — Tests
- [ ] (a) reload with zero-row loadAllPaths throws ESANDBOXGONE (not empty cache); ensureFreshCache converts to teardown + ENOENT.
- [ ] (b) tombstone sentinel recognized → teardown.
- [ ] (c) never-written variant (initialVersion 0, post-destroy sentinel) still tears down.
- [ ] destroy writes the tombstone (not del); update the existing "destroy deletes the version key" test.

## Success criteria

### Automated
- `pnpm typecheck && pnpm lint:fix && pnpm test:unit` all pass.
- New unit tests above pass; existing tests not weakened.

### Manual (LIVE)
- Create `vf7-*` sandbox → exec to populate → DELETE → re-exec/read → CLEAN 404/ENOENT (not 200 + garbage stderr).
- `redis-cli get vfs:...:ver:...` returns `DESTROYED`, not nil.

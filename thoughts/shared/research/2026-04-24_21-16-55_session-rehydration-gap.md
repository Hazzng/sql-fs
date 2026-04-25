---
date: 2026-04-24T21:16:55+09:30
researcher: QuangNguyen2609
git_commit: 571a99d9897e858797bf80ed52969503f9c16378
branch: feat/multi-replica-redis
repository: virtualFS
topic: "GitHub Issue #10: Multi-replica session rehydration gap — cold replicas return ENOENT for existing sandboxes"
tags: [research, codebase, session-manager, multi-replica, redis, rehydration, withExistingSession]
status: complete
last_updated: 2026-04-24
last_updated_by: QuangNguyen2609
---

# Research: GitHub Issue #10 — Session Rehydration Gap

**Date**: 2026-04-24 21:16:55 ACST
**Researcher**: QuangNguyen2609
**Git Commit**: 571a99d9897e858797bf80ed52969503f9c16378
**Branch**: feat/multi-replica-redis
**Repository**: virtualFS

## Research Question

Fully comprehend the context, code patterns, and architecture surrounding GitHub Issue #10: "Multi-replica: session rehydration gap — cold replicas return ENOENT for existing sandboxes". Understand how the current SessionManager works, what the proposed fix entails, which files need changes, and how existing infrastructure (Redis phases A-E) supports the solution.

## Summary

Issue #10 identifies a **pre-existing architectural limitation** in the virtualFS API where non-create HTTP routes throw ENOENT for sandboxes that exist in Postgres but aren't in the local in-memory session pool. This manifests in multi-replica deployments (LB routes request to a replica that never saw the sandbox) and after server restarts (pool is empty). The fix requires a new `withSessionOrRehydrate` wrapper on `SessionManager` that checks Postgres before throwing ENOENT, plus a `sandboxExists` method on `SqlDialect`. Phase E's Redis path snapshot makes rehydration cheap (~5ms for 1k paths).

---

## Detailed Findings

### 1. The Problem: `withExistingSession` Pool-Only Lookup

**File**: `src/api/session-manager.ts:454-494`

The `SessionManager` maintains a process-local `Map<string, Session>` (line 137). Two entry wrappers exist:

- **`withSession`** (line 391): Create-if-missing via `getOrCreate`. Used only by `POST /v1/sandboxes`.
- **`withExistingSession`** (line 454): Strict pool lookup — throws ENOENT if `sessions.get(sandboxId) === undefined`. Used by all other routes.

The ENOENT throw happens at **lines 456-459**:
```typescript
const session = this.sessions.get(sandboxId);
if (session === undefined) {
    throw Object.assign(
        new Error(`ENOENT: sandbox ${sandboxId} not found`),
        { code: "ENOENT" },
    );
}
```

**Why it was designed this way** (commit `6311437`, US-061):
1. One chokepoint for creation (rate-limiting, quota, auth)
2. Deletion must be final (auto-create would resurrect deleted sandboxes)
3. REST idiomatics: POST creates, other verbs act

All three reasons were correct for single-replica. Multi-replica exposes the trade-off: a cold replica cannot distinguish "sandbox was deleted" from "sandbox exists on another replica" without a PG lookup.

---

### 2. SessionManager Architecture

**File**: `src/api/session-manager.ts`

#### Session Type (lines 75-97)
```typescript
interface Session {
    readonly fs: IFileSystem;           // SqlFs or InMemoryFs
    readonly bash: Bash;                // just-bash instance
    readonly runtimeOptions: RuntimeOptions;
    lastUsed: number;                   // For idle eviction
    inFlight: number;                   // Concurrent operation count
    readonly mutex: Mutex;              // Local async-mutex
    state: "active" | "closing";
    owner: string;
    createdAt: string;
    pathCacheBytes: number;
    overBudget: boolean;
    destroyPromise?: Promise<void>;
    lastSeenVersion: number;            // Phase D coherence
}
```

#### Key Private Fields (lines 137-148)
- `sessions: Map<string, Session>` — the process-local pool
- `pending: Map<string, Promise<Session>>` — single-flight deduplication for `getOrCreate`
- `redis: Redis | undefined` — Redis client (undefined = single-replica mode)
- `pathSnapshot: RedisPathSnapshot | undefined` — Phase E snapshot writer

#### Method Map

| Method | Lines | Purpose |
|--------|-------|---------|
| `getOrCreate` | 209-274 | Fetch/create session; single-flight dedup via `pending` map |
| `withExecLock` | 287-290 | Distributed Redis lock wrapper (no-op if no Redis) |
| `ensureFreshCache` | 302-333 | Phase D: reload if version counter mismatch |
| `publishVersionIfDirty` | 341-379 | Phase D/E: INCR version + write snapshot |
| `withSession` | 391-445 | Create-if-missing, exec with locks |
| `withExistingSession` | 454-494 | Pool-only lookup, throws ENOENT |
| `destroy` | 505-542 | Mark closing, cleanup PG + Redis keys |
| `runReaper` | 579-589 | Idle/over-budget eviction (no DB cleanup) |

#### Locking Hierarchy
1. **Distributed lock** (`withExecLock` → Redis `SET NX PX`): Cross-replica serialization
2. **Coherence check** (`ensureFreshCache`): Inside distributed lock, outside local mutex
3. **Local mutex** (`session.mutex.runExclusive`): Same-sandbox serialization on this replica

#### getOrCreate Single-Flight (lines 209-274)
- Check `sessions` map → return if warm
- Check `pending` map → return same promise if in-flight
- Create IIFE, store in `pending` before awaiting
- Inside: `createFs()` → `new Bash()` → read Redis version → build Session → store in `sessions`
- Finally: delete from `pending`

#### Idle Reaper (lines 579-589)
- Evicts sessions from pool when idle > `idleMs` or over memory budget
- Does NOT call `destroySandboxFn` — sandbox remains in Postgres
- This is key: evicted sandboxes need rehydration on next access

---

### 3. SqlDialect Interface and Postgres Dialect

**File**: `src/fs/sql-fs/types.ts`

The `SqlDialect<Tx>` interface has ~20 methods across categories:
- **Connection**: `connect()`, `disconnect()`
- **Transactions**: `transaction<T>(fn)`
- **Sandbox context**: `setSandboxContext(tx, sandboxId)`, `setSandboxContextWithLock(tx, sandboxId)`
- **Sandbox lifecycle**: `createSandbox(tx, sandboxId)`, `deleteSandbox(tx, sandboxId)`
- **Inode CRUD**: `createInode`, `getInode`, `updateInode`, `deleteInode`
- **Hardlinks**: `incrementNlink`, `decrementNlink`
- **Dirents**: `insertDirent`, `upsertDirent`, `deleteDirent`, `listDirents`, `moveDirent`
- **Blobs**: `upsertBlob`, `getBlob`, `gcOrphanBlobs`
- **Bulk/tree**: `loadAllPaths`, `loadSubtreeInodes`, `bulkIngest`
- **Path resolution**: `resolvePath`

**No existing `sandboxExists` method.** The issue proposes adding one.

**File**: `src/fs/sql-fs/dialects/postgres.ts`

Key patterns:
- **Tagged template SQL** via `postgres` library: `await tx\`SELECT ...\``
- **RLS context**: `SET LOCAL app.sandbox_id` via `set_config(..., true)` (transaction-scoped)
- **Advisory locks**: `pg_advisory_xact_lock(hashtextextended(sandboxId, 0))` (transaction-scoped, pgbouncer-safe)
- **loadAllPaths** (lines 338-393): Recursive CTE starting from root inode, building full path tree

---

### 4. All withExistingSession Call Sites (12 total)

#### HTTP Routes (9 call sites):

| File | Route | Line | HTTP Method |
|------|-------|------|-------------|
| `src/api/routes/exec.ts` | `/exec-sync` | 65 | POST |
| `src/api/routes/exec.ts` | `/exec` (SSE) | 148 | POST |
| `src/api/routes/files.ts` | `/files/*` (read) | 105 | GET |
| `src/api/routes/files.ts` | `/files/*` (write) | 165 | PUT |
| `src/api/routes/files.ts` | `/files/*` (delete) | 192 | DELETE |
| `src/api/routes/files.ts` | `/tree` | 332 | GET |
| `src/api/routes/ingest.ts` | `/ingest` | 71 | POST |
| `src/api/routes/ingest.ts` | `/ingest-files` | 162 | POST |
| `src/api/routes/ingest.ts` | `/export` | 209 | GET |

#### MCP Tools (3 call sites):

| File | Tool | Line |
|------|------|------|
| `src/api/mcp/tools.ts` | `bash_exec` | 134 |
| `src/api/mcp/tools.ts` | `fs_ingest` | 217 |
| `src/api/mcp/tools.ts` | `fs_export` | 263 |

#### Contrasting withSession usage (1 site):
- `src/api/routes/sandboxes.ts:48` — `POST /v1/sandboxes` — the only create endpoint

**No call site passes `runtimeOptions`** (withExistingSession doesn't accept them). The new `withSessionOrRehydrate` should accept optional `runtimeOptions` for the rehydration path.

---

### 5. SqlFs Initialization & Phase E Snapshot

**File**: `src/fs/sql-fs/sql-fs.ts`

#### ready() (lines 324-328)
Calls `#loadFreshPathCache()` to populate the in-memory pathCache.

#### #loadFreshPathCache() (lines 275-318)
Decision tree:
1. If Redis + pathSnapshot configured:
   - Read `vfs:ver:{sandboxId}` for current version
   - Read `vfs:snap:{sandboxId}` for snapshot
   - **Strict version equality**: snapshot.version === currentVersion → return snapshot entries (~5ms)
   - Miss/mismatch → fall through to CTE
2. Fallback: `dialect.loadAllPaths(tx)` recursive CTE (~10-11ms for 1k paths)

#### reload() (lines 342-359)
Single-flighted via `#pendingReload`. Drops pathCache + contentCache, repopulates from DB or snapshot. Used by Phase D coherence on version mismatch.

**File**: `src/fs/sql-fs/index.ts`

#### createSandboxFs() (lines 25-76)
1. Validate `DATABASE_URL`
2. Get Redis client (lazy singleton)
3. Create RedisBlobCache if Redis available
4. Create RedisPathSnapshot if `REDIS_PATH_SNAPSHOT_ENABLED=true`
5. Create PostgresDialect, connect
6. Execute `createSandbox()` (idempotent on unique violation 23505)
7. Instantiate SqlFs
8. Call `fs.ready()` (Phase E snapshot check happens here)

---

### 6. Multi-Replica Redis Plan: Three Independent Gap Discoveries

**File**: `tasks/IMPLEMENT-multi-replica-redis.md`

All three phases that involved testing independently discovered and documented this gap:

**Phase A Discovery (line 647):**
> "Session rehydration gap (surfaced during manual E2E verification): HTTP routes use `withExistingSession`, which requires the sandbox to be in the `SessionManager` in-memory pool. After a server restart the pool is empty..."

**Phase C Discovery (line 1093):**
> "HTTP `withExistingSession` routes still hit the 'session rehydration gap' (Phase A discovery): a cold replica cannot service routes for a sandbox that was created on another replica..."

**Phase E Discovery (line 1635):**
> "Session rehydration over HTTP... Would require a `withSessionOrRehydrate` wrapper that falls back to `getOrCreate` when the pool is cold. Not in Phase E's scope — filed as future work..."

| Phase | What It Does | Helps Rehydration? |
|-------|-------------|-------------------|
| A: Blob cache | Redis read-through for blobs | No (requires warm session) |
| B: PG advisory lock | DB-level write serialization | No (requires warm session) |
| C: Redis exec lock | Cross-replica exec serialization | No (requires warm session) |
| D: Version counter | Cache coherence on handoff | No (requires warm session) |
| E: Path snapshot | Fast cold-start pathCache | **Yes — but only inside `getOrCreate`/`ready()`, which `withExistingSession` never calls** |

Phase E is the key enabler: it makes `getOrCreate` cheap for rehydration (~5ms vs ~10-11ms for CTE).

---

### 7. Failing Tests: concurrency.pg.test.ts

**File**: `src/api/__tests__/integration/concurrency.pg.test.ts`

**17 test cases, all failing with ENOENT.** The root cause: tests generate fresh sandbox IDs and immediately hit HTTP routes that call `withExistingSession`, without ever warming the session pool.

**Contrast with passing tests** (`concurrency.test.ts`):
```typescript
// PASSING: explicit warmup
await sm.getOrCreate(sbId);
// then HTTP requests...

// FAILING: no warmup
const sbId = newId();
// immediately HTTP requests → ENOENT
```

Test structure (6 describe blocks):
1. N concurrent PUTs to same path (2 tests)
2. N concurrent PUTs to distinct paths (1 test)
3. Write-delete-read cache invalidation (2 tests)
4. ContentCache consistency (2 tests)
5. Cross-sandbox isolation (2 tests)
6. Ordering scenarios S1-S4 (8 tests)

**Once `withSessionOrRehydrate` replaces `withExistingSession` on routes**, these tests should pass because the wrapper will check Postgres and rehydrate on pool miss.

---

### 8. Proposed Fix Design

#### New method: `withSessionOrRehydrate` (SessionManager)

```typescript
async withSessionOrRehydrate<T>(
    sandboxId: string,
    fn: (session: Session) => Promise<T>,
    runtimeOptions?: RuntimeOptions,
): Promise<T> {
    // Fast path: warm hit
    const warm = this.sessions.get(sandboxId);
    if (warm !== undefined) {
        return this.withSessionEntry(sandboxId, warm, fn);
    }

    return this.withExecLock(sandboxId, async () => {
        // Double-check under lock
        let session = this.sessions.get(sandboxId);
        if (session === undefined) {
            const exists = await this.sandboxExistsInPG(sandboxId);
            if (!exists) {
                throw Object.assign(
                    new Error(`ENOENT: sandbox ${sandboxId} not found`),
                    { code: "ENOENT" },
                );
            }
            session = await this.getOrCreate(sandboxId, runtimeOptions);
        }
        return this.withSessionEntry(sandboxId, session, fn);
    });
}
```

Key design decisions:
- **Fast path**: `Map.get` only (identical to today's warm hit)
- **Double-checked lookup**: Under distributed lock to avoid races
- **PG existence gate**: Prevents auto-creation of non-existent sandboxes
- **Rehydration via `getOrCreate`**: Reuses Phase E snapshot path

#### `withSessionEntry` refactor

Extract the shared `ensureFreshCache → mutex.runExclusive → publishVersionIfDirty` block from `withSession` and `withExistingSession` into a shared helper, eliminating 60+ lines of duplication.

#### New SqlDialect method: `sandboxExists`

```typescript
// types.ts
sandboxExists(tx: Tx, sandboxId: string): Promise<boolean>;

// postgres.ts
async sandboxExists(tx: PgTx, sandboxId: string): Promise<boolean> {
    const rows = await tx<{ exists: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM sandboxes WHERE id = ${sandboxId}) AS exists
    `;
    return rows[0]?.exists ?? false;
}
```

#### Route rewiring

Replace `withExistingSession` with `withSessionOrRehydrate` in:
- `src/api/routes/exec.ts` (2 call sites)
- `src/api/routes/files.ts` (4 call sites)
- `src/api/routes/ingest.ts` (3 call sites)
- `src/api/mcp/tools.ts` (3 call sites)

`withExistingSession` stays for internal callers (idle reaper, strict tests).

---

### 9. Cost Analysis

| Scenario | Latency | I/O |
|----------|---------|-----|
| Warm hit (common) | ~0ms | 1 Map.get |
| Cold hit, sandbox exists (first LB handoff) | ~10ms | Lock acquire + SELECT EXISTS + getOrCreate (snapshot) |
| Cold hit, sandbox absent | ~2ms | Lock acquire + SELECT EXISTS |

The ~10ms cold-hit cost is paid once per replica per sandbox, amortized across all subsequent requests until idle eviction.

---

### 10. Security Preservation

- **Deleted sandboxes stay deleted**: PG existence check is the gate. `DELETE` removes the row; subsequent `withSessionOrRehydrate` sees `exists = false` → ENOENT.
- **No new attack surface**: Random UUID to `/exec-sync` still gets ENOENT (absent from `sandboxes` table).
- **Destroy race safe**: Concurrent DELETE and rehydrate serialize on `vfs:lock:{id}`.

---

## Code References

- `src/api/session-manager.ts:137` — `sessions: Map<string, Session>` (the process-local pool)
- `src/api/session-manager.ts:209-274` — `getOrCreate` (single-flight session creation)
- `src/api/session-manager.ts:287-290` — `withExecLock` (distributed Redis lock wrapper)
- `src/api/session-manager.ts:302-333` — `ensureFreshCache` (Phase D coherence)
- `src/api/session-manager.ts:341-379` — `publishVersionIfDirty` (Phase D/E version + snapshot)
- `src/api/session-manager.ts:391-445` — `withSession` (create-if-missing wrapper)
- `src/api/session-manager.ts:454-494` — `withExistingSession` (strict pool lookup — the ENOENT source)
- `src/api/session-manager.ts:505-542` — `destroy` (lifecycle teardown)
- `src/api/session-manager.ts:579-589` — `runReaper` (idle eviction — no DB cleanup)
- `src/fs/sql-fs/types.ts:93-281` — `SqlDialect<Tx>` interface (all ~20 methods)
- `src/fs/sql-fs/dialects/postgres.ts:54-66` — RLS/SET LOCAL pattern
- `src/fs/sql-fs/dialects/postgres.ts:338-393` — `loadAllPaths` recursive CTE
- `src/fs/sql-fs/sql-fs.ts:275-318` — `#loadFreshPathCache` (Phase E snapshot decision)
- `src/fs/sql-fs/sql-fs.ts:324-328` — `ready()` (initialization entry point)
- `src/fs/sql-fs/sql-fs.ts:342-359` — `reload()` (cache refresh for coherence)
- `src/fs/sql-fs/index.ts:25-76` — `createSandboxFs` factory
- `src/fs/sql-fs/redis-path-snapshot.ts:69-127` — Phase E snapshot read/write/delete
- `src/api/routes/exec.ts:65,148` — withExistingSession call sites (exec)
- `src/api/routes/files.ts:105,165,192,332` — withExistingSession call sites (files)
- `src/api/routes/ingest.ts:71,162,209` — withExistingSession call sites (ingest/export)
- `src/api/mcp/tools.ts:134,217,263` — withExistingSession call sites (MCP)
- `src/api/routes/sandboxes.ts:48` — withSession call site (create — the only auto-creator)
- `src/api/distributed-lock.ts:98-161` — Redis distributed lock implementation
- `src/api/__tests__/integration/concurrency.pg.test.ts` — 17 failing tests (ENOENT from pool miss)

## Architecture Insights

### Locking Hierarchy (3 layers)
1. **Lock 1**: `session.mutex` (in-replica, free microtask wait)
2. **Lock 2**: Redis exec lock `vfs:lock:{id}` (cross-replica, heartbeat renewal)
3. **Lock 3**: `pg_advisory_xact_lock` (transaction-tied, last-line backstop)

### Cache Coherence Protocol (Phase D)
- Each session tracks `lastSeenVersion`
- On exec entry: read `vfs:ver:{id}` → if mismatch, `reload()` pathCache
- On exec exit: if dirty, `INCR vfs:ver:{id}` + write Phase E snapshot

### Snapshot Optimization (Phase E)
- `vfs:snap:{id}` stores msgpack-encoded pathCache with embedded version
- Strict version-equality check prevents stale snapshot use
- Load test: 75% reduction in recursive-CTE calls for 3-replica setup

### Key Invariant: Eviction vs Destroy
- **Reaper eviction** drops the session from pool but leaves sandbox in Postgres (rehydratable)
- **Destroy** removes from both pool AND Postgres (permanent deletion)
- `withSessionOrRehydrate` bridges the gap: evicted sandboxes can be rehydrated, destroyed ones stay ENOENT

## Open Questions

1. **Should `withSessionOrRehydrate` acquire the distributed lock before or after the PG existence check?** The issue proposes: fast-path Map.get (no lock), then lock → double-check → PG check → getOrCreate. This avoids a Redis round-trip on warm hits.

2. **Runtime options on rehydrate**: When rehydrating, should the wrapper accept `runtimeOptions`? The issue says yes (passthrough to `getOrCreate`), but no current call site passes them. The "first caller wins" contract means rehydrated sessions start with defaults.

3. **Ownership verification on rehydrate**: The current design doesn't re-verify ownership (the `owner` field is set at creation time). Is this safe, or should rehydration also validate the bearer token against the sandbox owner?

4. **MySQL/Azure SQL dialects**: `sandboxExists` is trivial for both but deferred. V1 targets Postgres only.

5. **Metrics**: Should `vfs.session.rehydrate_total` and `vfs.session.rehydrate_duration_ms` be added in the main PR or as a follow-up?


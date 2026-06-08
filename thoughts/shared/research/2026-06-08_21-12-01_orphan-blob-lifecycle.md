---
date: 2026-06-08T21:12:01+09:30
researcher: Harry.Nguyen@insightfactory.ai
git_commit: 72a8857ed41978d7fd2de2b6e1e99a6e734a3932
branch: main
repository: virtualFS
topic: "Orphan Blob Lifecycle: How are orphan blobs treated across the codebase?"
tags: [research, codebase, blobs, gc, garbage-collection, orphan, blob-lifecycle, cas]
status: complete
last_updated: 2026-06-08
last_updated_by: Harry.Nguyen@insightfactory.ai
---

# Research: Orphan Blob Lifecycle

**Date**: 2026-06-08 21:12:01 ACST
**Researcher**: Harry.Nguyen@insightfactory.ai
**Git Commit**: 72a8857ed41978d7fd2de2b6e1e99a6e734a3932
**Branch**: main
**Repository**: virtualFS

## Research Question

How are orphan blobs treated across the codebase? (Deep dive into GC triggering, blob lifecycle, and production callsites.)

## Summary

**Orphan blobs are never reclaimed automatically.** The `blobs` table is a global content-addressable store with no FK constraints back to `inodes`. Every write, overwrite, delete, move, copy, or sandbox destruction can produce orphan blob rows — blobs with a valid `sha256` but no inode referencing them. The only mechanism to collect them is `gcOrphanBlobs()`, which runs a global `DELETE … NOT IN (SELECT content_sha256 FROM inodes)` — but this method has **zero production callers**. The CLI entry point (`src/api/cli/gc.ts`) referenced by `pnpm db:gc` does not exist. The admin HTTP endpoint (`routes/admin.ts`) referenced in `CLAUDE.md` does not exist. No scheduled timer fires it. Blobs accumulate indefinitely in production.

A secondary gap: when GC does eventually run, it discards the `RETURNING sha256` values, so Redis blob cache entries for deleted blobs are never explicitly invalidated (they expire only by TTL).

---

## Detailed Findings

### 1. Schema Design: Why Blobs Are Never Cascade-Deleted

**File**: `src/sql-fs/migrations/postgres/0000_create_tables.sql`

```sql
-- blobs: no sandbox_id, no FK from any other table
CREATE TABLE IF NOT EXISTS blobs (
    sha256  BYTEA   PRIMARY KEY,
    data    BYTEA   NOT NULL,
    size    BIGINT  NOT NULL DEFAULT 0
);

-- inodes reference blobs by sha256, but with NO FK constraint
CREATE TABLE IF NOT EXISTS inodes (
    id              BIGSERIAL   PRIMARY KEY,
    sandbox_id      TEXT        NOT NULL REFERENCES sandboxes(id) ON DELETE CASCADE,
    ...
    content_sha256  BYTEA,       -- no REFERENCES blobs(sha256)
    ...
);
```

The design is intentional: blobs are a global CAS store shared across all sandboxes for dedup. Adding an FK would prevent blob sharing between sandboxes, or require complex reference counting at the DB level. The tradeoff is that blob cleanup must be application-managed.

`blobs` is also explicitly excluded from Postgres RLS (`0005_enable_rls.sql:40-43`): no `sandbox_id` column means no row-level policy is possible. This is the reason `gcOrphanBlobs` can safely scan all inodes without setting a sandbox context.

**No triggers exist on `blobs` or `inodes` for blob cleanup.**

---

### 2. The Only GC Implementation: `gcOrphanBlobs`

**File**: `src/sql-fs/dialects/postgres.ts:702-711`

```typescript
// US-014
async gcOrphanBlobs(tx: PgTx): Promise<number> {
    const rows = await tx<{ sha256: Buffer }[]>`
        DELETE FROM blobs
        WHERE sha256 NOT IN (
            SELECT content_sha256 FROM inodes WHERE content_sha256 IS NOT NULL
        )
        RETURNING sha256
    `;
    return rows.length;
}
```

**Important details:**

- The `IS NOT NULL` guard is critical for correctness. Without it, `NOT IN` with any `NULL` in the subquery result evaluates to `UNKNOWN` for every row (three-valued logic), meaning no blobs would ever be deleted.
- The subquery has no `sandbox_id` filter — intentional. It must see all inodes across all sandboxes to avoid deleting a blob still referenced by another sandbox.
- `RETURNING sha256` values are fetched but immediately **discarded** — only `rows.length` (the count) is returned to the caller. This means any Redis blob cache entries for deleted blobs are never explicitly invalidated. They will continue to serve stale (but harmless) data until `REDIS_BLOB_CACHE_TTL_MS` expires.
- **MySQL and Azure SQL dialects do not exist on disk** — only `dialects/postgres.ts` is implemented. `gcOrphanBlobs` is declared in the `SqlDialect<Tx>` interface (`types.ts:335`) but only Postgres provides a real implementation.

---

### 3. Production Callers: Zero

A full search across all non-test `.ts` files in `src/` finds:

| Location | Role |
|---|---|
| `src/sql-fs/types.ts:335` | Interface declaration only |
| `src/sql-fs/dialects/postgres.ts:702` | Implementation only |

There are **no production call sites.** The method is exercised only in integration tests (`src/sql-fs/tests/integration/postgres.test.ts:811-941`) covering three behaviours:
1. Referenced blob survives GC (line 830)
2. Orphan blob after inode delete is removed (line 856)
3. Blob shared by two inodes survives after one inode is deleted (line 892)

---

### 4. The Missing Trigger Infrastructure

All three planned mechanisms for invoking GC are either absent or broken:

#### 4a. CLI Script — File Missing

```json
// package.json:26
"db:gc": "tsx src/api/cli/gc.ts"
```

`src/api/cli/gc.ts` **does not exist**. The only file in `src/api/cli/` is `token.ts`. Running `pnpm db:gc` fails immediately with a module-not-found error.

#### 4b. Admin HTTP Route — File Missing

`src/api/routes/admin.ts` referenced in `CLAUDE.md`'s File Layout **does not exist**. The routes directory contains only `exec.ts`, `files.ts`, `ingest.ts`, `sandboxes.ts`, `auth.ts`. No GC endpoint is registered anywhere in `server.ts`.

#### 4c. Scheduled Timer — Not Wired

`src/api/server.ts` starts exactly two background tasks on boot (lines 281-282):
- `sessionManager.startReaper()` — idle session eviction
- `startMcpSessionSweeper()` — idle MCP transport eviction

No `setInterval` or cron for `gcOrphanBlobs` exists anywhere in the server.

---

### 5. Blob Lifecycle: When Orphans Are Created

Every operation that removes an inode (or creates a new one for an existing path) leaves the old blob in place:

| Operation | What happens to old blob |
|---|---|
| `writeFile` overwriting existing file | Old inode `nlink` decremented → deleted when 0; **old blob row survives** |
| `appendFile` overwriting existing file | Same as above |
| `rm` (file or recursive dir) | All inodes deleted; **all blob rows survive** |
| `mv` displacing a destination file | Destination inode deleted when nlink=0; **blob survives** |
| `cp` overwriting a destination file | Destination inode deleted when nlink=0; **blob survives** |
| `destroySandbox` | All inodes cascade-deleted; **ALL blob rows for that sandbox survive** |

The `nlink` decrement + conditional `deleteInode` pattern appears at 6 call sites in `sql-fs.ts` (lines 774-775, 843-844, 978-979, 1003-1004, 1223-1224, 1295-1296). In all cases, `deleteInode` issues `DELETE FROM inodes WHERE id = ?` — no blob row is touched.

The composite wCTE path (`rmComposite`, `writeFileComposite`, `mvComposite`) handles nlink decrement and inode delete inline in SQL, but equally leaves blob rows untouched.

---

### 6. Sandbox Deletion: Full Cascade Map

**File**: `src/sql-fs/dialects/postgres.ts:298-303`

```typescript
async deleteSandbox(tx: PgTx, sandboxId: string): Promise<void> {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${sandboxId}, 0))`;
    await tx`DELETE FROM sandboxes WHERE id = ${sandboxId}`;
}
```

The single `DELETE FROM sandboxes` cascades via FK:

```
DELETE FROM sandboxes WHERE id = $1
  → ON DELETE CASCADE → DELETE FROM inodes WHERE sandbox_id = $1
    → ON DELETE CASCADE → DELETE FROM dirents WHERE parent_inode_id IN (deleted inodes)
    → ON DELETE CASCADE → DELETE FROM dirents WHERE inode_id IN (deleted inodes)
  → ON DELETE CASCADE → DELETE FROM dirents WHERE sandbox_id = $1  (belt-and-suspenders)
```

**Blobs are not in this cascade chain.** After deletion, the session manager (`session-manager.ts:984-1047`) also cleans up the Redis version key and path snapshot, but not the Redis blob cache.

Full cleanup status after `DELETE /v1/sandboxes/:id`:

| Data | Cleaned? | How |
|---|---|---|
| `sandboxes` row | Yes | Explicit `DELETE` in `deleteSandbox` |
| `inodes` rows | Yes | `ON DELETE CASCADE` |
| `dirents` rows | Yes | `ON DELETE CASCADE` |
| `blobs` rows | **No** | No FK, no cascade; GC never called |
| Redis version key | Yes | `deleteVersionKey()` in session-manager.ts:1027 |
| Redis path snapshot | Yes (if enabled) | `pathSnapshot.delete()` in session-manager.ts:1033 |
| Redis blob cache entries | **No** | Expire by `REDIS_BLOB_CACHE_TTL_MS` only |

---

## Code References

- `src/sql-fs/dialects/postgres.ts:702-711` — `gcOrphanBlobs` implementation (the only GC logic)
- `src/sql-fs/types.ts:335` — `gcOrphanBlobs` interface declaration
- `src/sql-fs/migrations/postgres/0000_create_tables.sql:38-44` — `blobs` DDL (no FK, no cascade)
- `src/sql-fs/migrations/postgres/0000_create_tables.sql:14-26` — `inodes` DDL (`content_sha256` has no FK to `blobs`)
- `src/sql-fs/migrations/postgres/0005_enable_rls.sql:40-43` — explicit exclusion of `blobs` from RLS
- `src/sql-fs/sql-fs.ts:764` — `upsertBlob` call in `writeFile` (non-composite path)
- `src/sql-fs/sql-fs.ts:774-775` — `decrementNlink` + conditional `deleteInode` in `writeFile`
- `src/sql-fs/sql-fs.ts:978-979` — same pattern in `rm` recursive path
- `src/sql-fs/dialects/postgres.ts:298-303` — `deleteSandbox` (single DELETE, cascade handles the rest)
- `src/sql-fs/index.ts:105-115` — `destroyPostgresSandbox` (no GC call)
- `src/api/session-manager.ts:984-1047` — `destroy()` (no GC call)
- `src/sql-fs/tests/integration/postgres.test.ts:811-941` — the only tests that exercise `gcOrphanBlobs`
- `package.json:26` — `"db:gc": "tsx src/api/cli/gc.ts"` (broken: file missing)

---

## Architecture Insights

1. **The dedup vs. cleanup tension**: The CAS design correctly enables cross-sandbox blob dedup (two sandboxes with identical files share one blob row). The cost is that cleanup cannot be lazy/cascade — it must be a global scan. The current `NOT IN (SELECT ...)` approach works but will be slow on a large `inodes` table; a `NOT EXISTS` or `LEFT JOIN … WHERE NULL` rewrite would give the planner more options.

2. **The Redis cache gap on GC**: `gcOrphanBlobs` discards the deleted sha256 values. If a Redis blob cache is configured, those entries linger until TTL. This is harmless in practice (an orphan blob in Redis can't be surfaced to any read because no inode references it), but wastes cache memory proportional to churn.

3. **No design history**: The `thoughts/` directory contains no document covering blob GC design. The `db:gc` CLI and `routes/admin.ts` appear to have been specced in `CLAUDE.md` and `package.json` without being implemented, and no design decision record was written.

4. **MySQL/Azure SQL**: These backends are not implemented. When they are, `gcOrphanBlobs` will need dialect-specific equivalents. MySQL lacks `NOT IN` efficiency on large tables (no hash anti-join optimizer); a `LEFT JOIN … WHERE inode.sha256 IS NULL` pattern is recommended.

---

## Open Questions

1. **Why was `gc.ts` never written?** Was it intentionally deferred? There is no ADR or ticket reference.
2. **Should GC run on sandbox destroy?** Running a global `NOT IN` scan on every sandbox delete is expensive (scans all inodes). A cheaper alternative: track a `refcount` column on `blobs`, decrement on inode delete, GC only blobs with `refcount = 0`. Adds write complexity but eliminates the global scan.
3. **Should the Redis blob cache be explicitly purged on GC?** The deleted sha256 values from `RETURNING sha256` are available but discarded. Passing them to `RedisBlobCache.mdel()` would keep cache and DB in sync.
4. **Is `pnpm db:gc` meant to be run externally (cron job, k8s CronJob)?** If so, the missing `gc.ts` is the only blocker. If it's meant to be an admin HTTP endpoint, `routes/admin.ts` needs to be created and wired into `server.ts`.

---

## Historical Context (from thoughts/)

No dedicated design document for blob GC exists in `thoughts/`. The topic appears only incidentally:

- `thoughts/shared/research/2026-04-24_21-16-55_session-rehydration-gap.md:136` — lists `gcOrphanBlobs` as one of the `SqlDialect` methods during an inventory, no design discussion.
- `thoughts/shared/plans/2026-04-24_22-44-38_multi-tenant-postgres-routing.md:34,634` — discusses whether cross-tenant blob dedup should survive in a multi-tenant world, as a side concern.

## Related Research

- `thoughts/shared/research/2026-04-24_21-16-55_session-rehydration-gap.md` — full SqlDialect interface inventory
- `thoughts/shared/plans/2026-04-24_22-44-38_multi-tenant-postgres-routing.md` — multi-tenant routing and blob cache key design

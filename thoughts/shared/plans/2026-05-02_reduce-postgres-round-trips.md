---
date: 2026-05-02T11:34:41+09:30
researcher: quangnguyentechno@gmail.com
git_commit: 7a7395bb9158cd6c39dbd498af9604769e7350cd
branch: perf/reduce-postgres-round-trips
repository: virtualFS
task: "Reduce per-transaction Postgres round-trips in SqlFs write operations"
tags: [implementation-plan, sql-fs, postgres, performance, latency]
status: draft
last_updated: 2026-05-02
last_updated_by: quangnguyentechno@gmail.com
---

# Reduce Postgres Round-Trips Implementation Plan

## Overview

Implement two Tier 1 optimizations from the remote-bash-latency-scaling research to reduce per-transaction Postgres round-trips in SqlFs write operations. Currently each write op pays ~4 RTTs of fixed overhead (BEGIN, set_config, pg_advisory_xact_lock, COMMIT) plus 2-5 RTTs for the op's own queries. This plan collapses everything — context setup AND operation — into a **single CTE per transaction**, so the only RTTs are the driver-managed BEGIN/COMMIT envelope:

```
Before:  BEGIN → set_config → pg_advisory_xact_lock → op1 → op2 → ... → opN → COMMIT
After:   BEGIN → [one CTE: set_config + lock + all op queries] → COMMIT
```

The `postgres` driver pipelines BEGIN with the first query, so each write op becomes **~1 application-level RTT** inside the transaction.

## Current State Analysis

### Per-write-op overhead (postgres.ts:63-68, sql-fs.ts)

| Method | Current statements in tx | Total app RTTs | After (1 CTE) |
|---|---|---|---|
| `writeFile` (446-461) | `set_config` + `lock` + `upsertBlob` + `createInode` + `upsertDirent` + `decrementNlink` + `deleteInode` | 5-7 | **1** |
| `mkdir` non-recursive (582-591) | `set_config` + `lock` + `createInode` + `insertDirent` | 4 | **1** |
| `rm` single file (661-665) | `set_config` + `lock` + `deleteDirent` + `decrementNlink` + `deleteInode` | 4-5 | **1** |
| `mv` (917-925) | `set_config` + `lock` + `decrementNlink` + `deleteInode` + `moveDirent` | 3-5 | **1** |
| `appendFile` (500-516) | same as `writeFile` (after blob read) | 5-7 | **1** |

### Key Discoveries
- `SqlDialect` interface (`types.ts`) is generic over `Tx` — Postgres, MySQL, Azure SQL all implement it. New methods must be **optional** on the interface so other dialects aren't forced to implement them.
- Unit tests mock `SqlDialect` methods individually (`sql-fs.write.test.ts:55-87`). New composite methods must be added to test mocks.
- `appendFile` has a separate read transaction (`#withTx` at line 486) for fetching the existing blob before the write transaction. This read tx is on the **write path** (uses `#withTx` not `#withReadTx`), which is suboptimal but out of scope for this plan.
- The `bulkIngest` method (`sql-fs.ts:401-428`) already demonstrates the single-CTE-per-operation pattern via `dialect.bulkIngest`.
- `postgres.ts` uses `postgres` driver tagged template literals — CTEs work naturally with this driver.
- `pg_advisory_xact_lock` does not read `app.sandbox_id` — it takes the sandbox ID hash as a direct parameter. So evaluation order between `set_config` and `pg_advisory_xact_lock` in a single SELECT does not matter; both can safely appear in the same CTE step.

## Desired End State

After implementation:
- `writeFile`, `mkdir` (non-recursive), `rm` (single), `mv`, and `appendFile` each execute **1 SQL statement** per transaction (the mega-CTE includes context setup + advisory lock + all operation queries)
- `setSandboxContextWithLock` is also fused to **1 statement** (for non-composite paths: `chmod`, `utimes`, `link`, `symlink`, `cp`, `rm -rf`, `mkdir -p`)
- All existing unit tests pass unchanged (they use mocked dialects without composites → fall through to sequential path)
- All existing integration tests pass unchanged
- The `SqlDialect` interface remains backward-compatible (new methods are optional)
- MySQL and Azure SQL dialects are unaffected

### Verification

- `pnpm typecheck` passes
- `pnpm lint:fix` passes
- `pnpm test:unit` passes
- `pnpm test:integration` passes (if DB is available)
- Benchmark shows reduced wall-clock times for multi-op scripts (manual)

## What We're NOT Doing

- **Not modifying just-bash** — consumed as npm dependency
- **Not implementing script-scoped transactions** (Tier 2, option A from research)
- **Not implementing write-back queue** (Tier 2, option B from research)
- **Not collapsing `rm -rf` recursive** — already uses a single `#withTx` with a loop; the loop is over subtree paths which requires pathCache iteration, not easily CTE-able
- **Not collapsing `mkdir -p` recursive** — each segment needs pathCache check; loop is inherent
- **Not adding stored procedures** — CTEs in the dialect are simpler, require no migration, and are easier to maintain
- **Not optimizing `appendFile`'s read transaction** — the extra `#withTx` for `getBlob` is a separate concern
- **Not modifying `cp`** — similar pattern to `writeFile` but lower-priority in benchmarks

## Implementation Approach

Each composite method includes `set_config('app.sandbox_id', ..., true)` and `pg_advisory_xact_lock(...)` as the **first CTE step**, followed by the operation CTEs. This means `SqlFs` can call `dialect.transaction(fn)` directly (no separate `setSandboxContextWithLock`) when using a composite — the entire write is 1 SQL statement.

For dialects without composites (MySQL, Azure SQL, or mocked), the existing `#withTx` path still calls `setSandboxContextWithLock` + sequential dialect methods, unchanged.

---

## Phase 1: Fuse sandbox context setup (for non-composite paths)

### Phase 1: Overview
Combine the two sequential SQL statements in `setSandboxContextWithLock` into a single `SELECT`. This benefits all write paths that **don't** use composites: `chmod`, `utimes`, `link`, `symlink`, `cp`, `rm -rf`, `mkdir -p`, and the fallback path for MySQL/Azure SQL.

### Phase 1: Changes Required

#### 1. Fuse statements in PostgresDialect
**File**: `src/fs/sql-fs/dialects/postgres.ts:63-68`

Current:
```ts
async setSandboxContextWithLock(tx: PgTx, sandboxId: string): Promise<void> {
    await tx`SELECT set_config('app.sandbox_id', ${sandboxId}, true)`;
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${sandboxId}, 0))`;
}
```

New:
```ts
async setSandboxContextWithLock(tx: PgTx, sandboxId: string): Promise<void> {
    await tx`SELECT set_config('app.sandbox_id', ${sandboxId}, true), pg_advisory_xact_lock(hashtextextended(${sandboxId}, 0))`;
}
```

This is safe because `pg_advisory_xact_lock` takes the hash as a direct parameter — it doesn't read `app.sandbox_id`. The RLS policies and stored procs that read `current_setting('app.sandbox_id')` run in subsequent queries within the same transaction, by which time `set_config` has committed its transaction-local value.

### Phase 1: Success Criteria

#### Phase 1: Automated Verification
- [x] `pnpm typecheck` passes
- [x] `pnpm lint:fix` passes
- [x] `pnpm test:unit` passes
- [x] `pnpm test:integration` passes (advisory lock integration tests still pass)

#### Phase 1: Manual Verification
- [x] Inspect the generated SQL to confirm a single statement is sent

### Phase 1: Discoveries and Notable Information

**Implementation Adaptations:**
- Updated `postgres.advisory-lock.test.ts` to match the fused single-statement behavior: the `setSandboxContextWithLock` test now asserts 1 call (not 2) containing both `set_config` and `pg_advisory_xact_lock`, and the parity test extracts lock SQL from `calls[0]` instead of `calls[1]`.

---

## Phase 2: Add optional composite methods to SqlDialect interface

### Phase 2: Overview
Extend the `SqlDialect` interface with optional composite methods. Each composite is a single-CTE operation that includes context setup + advisory lock + all operation queries. Optional (`?`) so MySQL/Azure SQL dialects don't need to implement them.

### Phase 2: Changes Required

#### 1. Add composite method signatures to SqlDialect
**File**: `src/fs/sql-fs/types.ts`
**Changes**: Add the following after the `moveDirent` method block (around line 254):

```ts
// ── Composite write operations (optional) ────────────────────────────────
//
// Single-CTE methods that fuse sandbox context setup (set_config +
// advisory lock) with the operation queries. When present, SqlFs calls
// these inside a bare `dialect.transaction()` — no separate
// setSandboxContextWithLock call. Dialects that don't implement them
// fall through to the sequential path unchanged.

/**
 * Single-CTE mkdir: sets sandbox context + lock, creates inode, links dirent.
 * Returns the new inode ID.
 */
mkdirComposite?(tx: Tx, sandboxId: string, parentId: bigint, name: string, mode: number): Promise<bigint>;

/**
 * Single-CTE rm for a single entry: sets sandbox context + lock, deletes
 * dirent, decrements nlink, deletes inode if nlink reaches 0.
 * Returns the removed inode ID.
 */
rmComposite?(tx: Tx, sandboxId: string, parentId: bigint, name: string): Promise<bigint>;

/**
 * Single-CTE writeFile: sets sandbox context + lock, upserts blob, creates
 * file inode, upserts dirent, cleans up displaced inode.
 * Returns the new inode ID.
 */
writeFileComposite?(
    tx: Tx,
    sandboxId: string,
    parentId: bigint,
    name: string,
    mode: number,
    size: number,
    sha256: Uint8Array,
    data: Uint8Array,
): Promise<bigint>;

/**
 * Single-CTE mv: sets sandbox context + lock, moves dirent, cleans up
 * any displaced destination inode.
 */
mvComposite?(
    tx: Tx,
    sandboxId: string,
    oldParentId: bigint,
    oldName: string,
    newParentId: bigint,
    newName: string,
): Promise<void>;
```

Note: every composite takes `sandboxId` because it handles `set_config` internally.

### Phase 2: Success Criteria

#### Phase 2: Automated Verification
- [x] `pnpm typecheck` passes (optional methods don't break existing implementations)
- [x] `pnpm lint:fix` passes
- [x] `pnpm test:unit` passes (no behavior change yet)

#### Phase 2: Manual Verification
- [x] Verify MySQL/Azure SQL dialects still compile without implementing the new methods

### Phase 2: Discoveries and Notable Information

**Implementation Adaptations:**
- Omitted JSDoc comments from the composite method signatures per project coding standards (no comments unless the WHY is non-obvious). The method names and parameter lists are self-documenting.
- The `?` optional modifier on each method is sufficient to preserve backward compatibility — `pnpm typecheck` confirms MySQL and Azure SQL dialects compile without changes (they don't implement the new methods, and TypeScript doesn't require optional interface members to be present).

---

## Phase 3: Implement CTE-based composites in PostgresDialect

### Phase 3: Overview
Implement the four composite methods in `PostgresDialect`. Each method is a single SQL statement with a CTE chain that starts with context setup (`set_config` + `pg_advisory_xact_lock`) and continues with all operation queries.

### Phase 3: Changes Required

#### 1. `mkdirComposite` — 4 RTTs → 1

**File**: `src/fs/sql-fs/dialects/postgres.ts`

```ts
async mkdirComposite(tx: PgTx, sandboxId: string, parentId: bigint, name: string, mode: number): Promise<bigint> {
    const rows = await tx<{ id: string }[]>`
        WITH ctx AS (
            SELECT set_config('app.sandbox_id', ${sandboxId}, true),
                   pg_advisory_xact_lock(hashtextextended(${sandboxId}, 0))
        ),
        new_inode AS (
            INSERT INTO inodes (sandbox_id, kind, mode, size)
            SELECT ${sandboxId}, 2, ${mode}, 0 FROM ctx
            RETURNING id
        )
        INSERT INTO dirents (parent_inode_id, name, inode_id, sandbox_id)
        SELECT ${String(parentId)}, ${name}, new_inode.id, ${sandboxId}
        FROM new_inode
        RETURNING inode_id AS id
    `;
    const row = rows[0];
    if (!row) throw new Error("mkdirComposite: INSERT returned no rows");
    return BigInt(row.id);
}
```

The `FROM ctx` on the first INSERT ensures the `ctx` CTE (and therefore `set_config` + lock) executes before any data-modifying CTEs. Without referencing `ctx`, PostgreSQL may optimize it away.

#### 2. `rmComposite` — 4-5 RTTs → 1

**File**: `src/fs/sql-fs/dialects/postgres.ts`

```ts
async rmComposite(tx: PgTx, sandboxId: string, parentId: bigint, name: string): Promise<bigint> {
    const rows = await tx<{ removed_inode_id: string }[]>`
        WITH ctx AS (
            SELECT set_config('app.sandbox_id', ${sandboxId}, true),
                   pg_advisory_xact_lock(hashtextextended(${sandboxId}, 0))
        ),
        removed_dirent AS (
            DELETE FROM dirents
            WHERE parent_inode_id = ${String(parentId)} AND name = ${name}
                AND (SELECT 1 FROM ctx) IS NOT NULL
            RETURNING inode_id
        ),
        decremented AS (
            UPDATE inodes
            SET nlink = nlink - 1
            FROM removed_dirent
            WHERE inodes.id = removed_dirent.inode_id
            RETURNING inodes.id, inodes.nlink
        ),
        cleaned AS (
            DELETE FROM inodes
            WHERE id IN (SELECT id FROM decremented WHERE nlink <= 0)
        )
        SELECT inode_id AS removed_inode_id FROM removed_dirent
    `;
    const row = rows[0];
    if (!row) throw createEnoent(name);
    return BigInt(row.removed_inode_id);
}
```

The `AND (SELECT 1 FROM ctx) IS NOT NULL` clause forces `ctx` to execute before the DELETE without changing the WHERE semantics (always true).

#### 3. `writeFileComposite` — 5-7 RTTs → 1

**File**: `src/fs/sql-fs/dialects/postgres.ts`

```ts
async writeFileComposite(
    tx: PgTx,
    sandboxId: string,
    parentId: bigint,
    name: string,
    mode: number,
    size: number,
    sha256: Uint8Array,
    data: Uint8Array,
): Promise<bigint> {
    const rows = await tx<{ new_inode_id: string }[]>`
        WITH ctx AS (
            SELECT set_config('app.sandbox_id', ${sandboxId}, true),
                   pg_advisory_xact_lock(hashtextextended(${sandboxId}, 0))
        ),
        blob_insert AS (
            INSERT INTO blobs (sha256, data, size)
            SELECT ${sha256}, ${data}, ${size} FROM ctx
            ON CONFLICT (sha256) DO NOTHING
        ),
        new_inode AS (
            INSERT INTO inodes (sandbox_id, kind, mode, size, content_sha256)
            VALUES (${sandboxId}, 1, ${mode}, ${size}, ${sha256})
            RETURNING id
        ),
        old_dirent AS (
            SELECT inode_id FROM dirents
            WHERE parent_inode_id = ${String(parentId)} AND name = ${name}
        ),
        upserted AS (
            INSERT INTO dirents (parent_inode_id, name, inode_id, sandbox_id)
            SELECT ${String(parentId)}, ${name}, new_inode.id, ${sandboxId}
            FROM new_inode
            ON CONFLICT (parent_inode_id, name) DO UPDATE SET inode_id = EXCLUDED.inode_id
            RETURNING inode_id
        ),
        decremented AS (
            UPDATE inodes
            SET nlink = nlink - 1
            FROM old_dirent
            WHERE inodes.id = old_dirent.inode_id
            RETURNING inodes.id, inodes.nlink
        ),
        cleaned AS (
            DELETE FROM inodes
            WHERE id IN (SELECT id FROM decremented WHERE nlink <= 0)
        )
        SELECT id AS new_inode_id FROM new_inode
    `;
    const row = rows[0];
    if (!row) throw new Error("writeFileComposite: INSERT returned no rows");
    if (this.#blobCache !== undefined) {
        void this.#blobCache.set(sha256, data);
    }
    return BigInt(row.new_inode_id);
}
```

**CTE snapshot semantics**: All CTEs see the same snapshot. `old_dirent` captures the old `inode_id` before `upserted` modifies it. `decremented` then acts on the old inode. This matches the sequential logic.

#### 4. `mvComposite` — 3-5 RTTs → 1

**File**: `src/fs/sql-fs/dialects/postgres.ts`

```ts
async mvComposite(
    tx: PgTx,
    sandboxId: string,
    oldParentId: bigint,
    oldName: string,
    newParentId: bigint,
    newName: string,
): Promise<void> {
    const rows = await tx<{ inode_id: string }[]>`
        WITH ctx AS (
            SELECT set_config('app.sandbox_id', ${sandboxId}, true),
                   pg_advisory_xact_lock(hashtextextended(${sandboxId}, 0))
        ),
        old_dest AS (
            DELETE FROM dirents
            WHERE parent_inode_id = ${String(newParentId)} AND name = ${newName}
                AND (SELECT 1 FROM ctx) IS NOT NULL
            RETURNING inode_id
        ),
        decremented AS (
            UPDATE inodes
            SET nlink = nlink - 1
            FROM old_dest
            WHERE inodes.id = old_dest.inode_id
            RETURNING inodes.id, inodes.nlink
        ),
        cleaned AS (
            DELETE FROM inodes
            WHERE id IN (SELECT id FROM decremented WHERE nlink <= 0)
        ),
        moved AS (
            UPDATE dirents
            SET parent_inode_id = ${String(newParentId)}, name = ${newName}
            WHERE parent_inode_id = ${String(oldParentId)} AND name = ${oldName}
            RETURNING inode_id
        )
        SELECT inode_id FROM moved
    `;
    if (rows.length === 0) throw createEnoent(oldName);
}
```

### Phase 3: Success Criteria

#### Phase 3: Automated Verification
- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint:fix` passes
- [ ] `pnpm test:unit` passes
- [ ] `pnpm test:integration` passes

#### Phase 3: Manual Verification
- [ ] Each CTE produces correct results for: new file write, overwrite, mkdir, rm file, rm empty dir, mv with displacement, mv without displacement

### Phase 3: Discoveries and Notable Information
[Filled during implementation]

---

## Phase 4: Wire SqlFs methods to use composites with bare transactions

### Phase 4: Overview
Update the write methods in `sql-fs.ts` to check for composite methods on the dialect. When available, call `dialect.transaction(fn)` directly (no `setSandboxContextWithLock`) since the composite handles context setup internally. When absent, fall back to the existing `#withTx` path unchanged.

### Phase 4: Changes Required

#### 1. Add `#withBareTx` helper
**File**: `src/fs/sql-fs/sql-fs.ts` (after `#withReadTx`, around line 183)

```ts
async #withBareTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.#dialect.transaction(fn);
}
```

This is a transaction with no context setup — the composite CTE handles it.

#### 2. Update `writeFile` (sql-fs.ts:446-461)
**File**: `src/fs/sql-fs/sql-fs.ts`

```ts
const inodeId = this.#dialect.writeFileComposite
    ? await this.#withBareTx((tx) =>
        this.#dialect.writeFileComposite!(
            tx, this.#sandboxId, parentEntry.inodeId, name,
            0o644, bytes.length, sha256, bytes,
        ))
    : await this.#withTx(async (tx) => {
        await this.#dialect.upsertBlob(tx, sha256, bytes);
        const id = await this.#dialect.createInode(tx, {
            sandboxId: this.#sandboxId,
            kind: INODE_KIND.FILE,
            mode: 0o644,
            size: bytes.length,
            contentSha256: sha256,
        });
        const oldInodeId = await this.#dialect.upsertDirent(tx, parentEntry.inodeId, name, id);
        if (oldInodeId !== null) {
            const newNlink = await this.#dialect.decrementNlink(tx, oldInodeId);
            if (newNlink === 0) await this.#dialect.deleteInode(tx, oldInodeId);
        }
        return id;
    });
```

#### 3. Update `appendFile` (sql-fs.ts:500-516)
Same pattern as `writeFile` — the write transaction body is identical. Use `writeFileComposite` when available.

Note: `appendFile` needs the replaced inode ID for cache eviction. The old inodeId is available from the `existing` pathCache entry (line 482) before the write, so no change needed to the return value.

#### 4. Update `mkdir` non-recursive (sql-fs.ts:582-591)
```ts
const inodeId = this.#dialect.mkdirComposite
    ? await this.#withBareTx((tx) =>
        this.#dialect.mkdirComposite!(tx, this.#sandboxId, parentEntry.inodeId, name, 0o755))
    : await this.#withTx(async (tx) => {
        const id = await this.#dialect.createInode(tx, { ... });
        await this.#dialect.insertDirent(tx, parentEntry.inodeId, name, id);
        return id;
    });
```

#### 5. Update `rm` single file/empty dir (sql-fs.ts:661-665)
```ts
if (this.#dialect.rmComposite) {
    await this.#withBareTx((tx) =>
        this.#dialect.rmComposite!(tx, this.#sandboxId, parentEntry!.inodeId, name));
} else {
    await this.#withTx(async (tx) => {
        const removedInodeId = await this.#dialect.deleteDirent(tx, parentEntry!.inodeId, name);
        const newNlink = await this.#dialect.decrementNlink(tx, removedInodeId);
        if (newNlink === 0) await this.#dialect.deleteInode(tx, removedInodeId);
    });
}
```

#### 6. Update `mv` (sql-fs.ts:917-925)
```ts
if (this.#dialect.mvComposite) {
    await this.#withBareTx((tx) =>
        this.#dialect.mvComposite!(
            tx, this.#sandboxId, srcParentEntry.inodeId, srcName,
            destParentEntry.inodeId, destName));
} else {
    await this.#withTx(async (tx) => {
        if (destEntry) {
            const newNlink = await this.#dialect.decrementNlink(tx, destEntry.inodeId);
            if (newNlink === 0) await this.#dialect.deleteInode(tx, destEntry.inodeId);
        }
        await this.#dialect.moveDirent(tx, srcParentEntry.inodeId, srcName, destParentEntry.inodeId, destName);
    });
}
```

### Phase 4: Success Criteria

#### Phase 4: Automated Verification
- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint:fix` passes
- [ ] `pnpm test:unit` passes — existing tests use mocked dialect without composite methods, so all fall through to sequential path via `#withTx`. Verifies backward compatibility.
- [ ] `pnpm test:integration` passes — integration tests use real PostgresDialect which now has composites, exercising the `#withBareTx` + composite path.

#### Phase 4: Manual Verification
- [ ] Read through each updated method to confirm the composite path and fallback path produce identical side effects (pathCache, contentCache, dirty flag)

### Phase 4: Discoveries and Notable Information
[Filled during implementation]

---

## Phase 5: Unit tests for composite methods

### Phase 5: Overview
Add unit tests that exercise the composite code paths in SqlFs by providing mock dialects with composite methods implemented.

### Phase 5: Changes Required

#### 1. New test file for composite dialect paths
**File**: `src/fs/sql-fs/tests/sql-fs.composite.test.ts`

Create a test file that extends the existing mock dialect pattern with composite methods and verifies:
- `writeFile` calls `writeFileComposite` when available (and does NOT call `createInode`/`upsertBlob`/`upsertDirent`)
- `mkdir` calls `mkdirComposite` when available (and does NOT call `createInode`/`insertDirent`)
- `rm` calls `rmComposite` when available (and does NOT call `deleteDirent`/`decrementNlink`/`deleteInode`)
- `mv` calls `mvComposite` when available (and does NOT call `moveDirent`/`decrementNlink`/`deleteInode`)
- `appendFile` calls `writeFileComposite` when available
- Composites skip `setSandboxContextWithLock` (verify it is NOT called when composite is used)
- Fallback: when composite methods are absent, `setSandboxContextWithLock` IS called and sequential path is used (already covered by existing tests)

### Phase 5: Success Criteria

#### Phase 5: Automated Verification
- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint:fix` passes
- [ ] `pnpm test:unit` passes (all new + existing tests)
- [ ] `pnpm test:integration` passes

#### Phase 5: Manual Verification
- [ ] New test file covers all four composite methods + fallback behavior
- [ ] Tests verify that composite methods are called INSTEAD of sequential methods (not in addition to)
- [ ] Tests verify that `setSandboxContextWithLock` is NOT called when composite is used

### Phase 5: Discoveries and Notable Information
[Filled during implementation]

---

## Testing Strategy

### Unit Tests
- Existing tests (`sql-fs.write.test.ts`, `sql-fs.mv.test.ts`, etc.) use a mock dialect **without** composite methods → they exercise the fallback sequential path with `#withTx` + `setSandboxContextWithLock` and must continue to pass unchanged
- New `sql-fs.composite.test.ts` uses a mock dialect **with** composite methods → exercises `#withBareTx` + composite path
- Verify mutual exclusion: when composite is called, sequential methods and `setSandboxContextWithLock` are NOT called

### Integration Tests
- Existing `src/fs/sql-fs/integration/postgres.test.ts` runs against real Postgres and will automatically exercise the composite methods (since PostgresDialect now implements them)
- Advisory lock integration test (`advisory-lock.integration.test.ts`) verifies locking still works with both the fused `setSandboxContextWithLock` and the composite CTEs

### Manual Testing
- Run `scripts/benchmark_remote_bash.py` before and after to compare wall-clock latency for multi-op scripts

## Performance Considerations

### Expected improvements per operation

| Method | Before (RTTs in tx) | After (RTTs in tx) | Savings |
|---|---|---|---|
| `writeFile` | 5-7 | **1** | 4-6 RTTs |
| `mkdir` | 4 | **1** | 3 RTTs |
| `rm` single | 4-5 | **1** | 3-4 RTTs |
| `mv` | 3-5 | **1** | 2-4 RTTs |
| `appendFile` (write tx only) | 5-7 | **1** | 4-6 RTTs |
| Non-composite paths (`chmod`, etc.) | N+2 | N+1 | 1 RTT (Phase 1 only) |

For the `mv 3 files` benchmark case: 3 files × (1 `writeFile` setup + 1 `mkdir` + 3 `mv` + 1 `rm -rf`) = ~8 transactions. Each drops from ~5 avg to ~1 app RTT. That's **~32 fewer RTTs** per script execution.

### No new risks
- CTEs execute in the same transaction as before — no change to isolation or durability
- Advisory lock semantics are preserved (transaction-scoped, acquired in `ctx` CTE)
- RLS context is set in the same CTE before any data-touching CTEs reference tables with RLS policies
- `FROM ctx` / `(SELECT 1 FROM ctx) IS NOT NULL` pattern ensures context CTE is materialized before data CTEs

## References

- Research: `thoughts/shared/research/2026-05-02_11-24-37_remote-bash-latency-scaling.md`
- Benchmark: `scripts/benchmark_remote_bash.py`
- SqlFs: `src/fs/sql-fs/sql-fs.ts`
- PostgresDialect: `src/fs/sql-fs/dialects/postgres.ts`
- SqlDialect interface: `src/fs/sql-fs/types.ts`
- Existing tests: `src/fs/sql-fs/tests/sql-fs.write.test.ts`, `sql-fs.mv.test.ts`, `sql-fs.rm-recursive.test.ts`
- Integration tests: `src/fs/sql-fs/integration/postgres.test.ts`

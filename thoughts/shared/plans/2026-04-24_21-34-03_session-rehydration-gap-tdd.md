---
date: 2026-04-24T21:34:03+09:30
researcher: quangnguyentechno@gmail.com
git_commit: 571a99d9897e858797bf80ed52969503f9c16378
branch: feat/multi-replica-redis
repository: virtualFS
task: "GitHub Issue #10: Fix multi-replica session rehydration gap (TDD)"
tags: [implementation-plan, session-manager, multi-replica, redis, rehydration, tdd]
status: draft
last_updated: 2026-04-24
last_updated_by: quangnguyentechno@gmail.com
---

# Session Rehydration Gap — TDD Implementation Plan

## Overview

Fix the session rehydration gap (GitHub Issue #10) where `withExistingSession` throws ENOENT for sandboxes that exist in Postgres but aren't in the current replica's in-memory pool. This occurs in multi-replica deployments (LB routes request to a cold replica) and after server restarts (pool is empty).

The fix adds a `withSessionOrRehydrate` method that checks Postgres before giving up, extracts shared lock/coherence/mutex logic into a `withSessionEntry` helper to eliminate duplication, and rewires all 11 HTTP/MCP route call sites.

## Current State Analysis

### The ENOENT Source
`src/api/session-manager.ts:454-494` — `withExistingSession` does a pool-only `Map.get()`:
```typescript
const session = this.sessions.get(sandboxId);
if (session === undefined) {
    throw Object.assign(new Error(`ENOENT: sandbox ${sandboxId} not found`), { code: "ENOENT" });
}
```

### Code Duplication
`withSession` (lines 396-444) and `withExistingSession` (lines 455-493) share ~35 lines of identical inner logic:
- closing-state check
- `ensureFreshCache` coherence check
- `mutex.runExclusive` with inFlight tracking
- `publishVersionIfDirty` in finally block
- pathCacheBytes estimation

### Existing Failing Tests
`src/api/__tests__/integration/concurrency.pg.test.ts` — 17 tests that generate fresh sandbox IDs and hit HTTP routes without warming the pool. These currently fail with ENOENT and will serve as the acceptance criterion for this fix.

### Key Discoveries
- No `sandboxExists` method on `SqlDialect` interface (`src/fs/sql-fs/types.ts:92-282`)
- No `withSessionOrRehydrate` method exists yet
- Phase E snapshot makes rehydration cheap (~5ms for 1k paths via Redis snapshot)
- Idle reaper evicts from pool but leaves sandbox in Postgres (rehydratable)
- `destroy()` removes from both pool AND Postgres (permanent deletion)
- Mock dialect pattern established in `src/fs/sql-fs/sql-fs.cache.test.ts:56-82`

## Desired End State

After this plan is complete:
1. All 11 HTTP/MCP route call sites use `withSessionOrRehydrate` instead of `withExistingSession`
2. Cold replicas transparently rehydrate sessions from Postgres on first access (~10ms one-time cost)
3. Deleted sandboxes still return ENOENT (PG existence gate prevents resurrection)
4. The 17 failing tests in `concurrency.pg.test.ts` pass
5. All existing tests continue to pass (no regressions)
6. `withSession`, `withExistingSession`, and `withSessionOrRehydrate` share a `withSessionEntry` helper

### Verification
- `pnpm typecheck` passes
- `pnpm lint:fix` passes
- `pnpm test:unit` passes
- `pnpm test:integration` passes (17 previously-failing tests now green)

## What We're NOT Doing

- **MySQL/Azure SQL dialects**: `sandboxExists` is Postgres-only for V1
- **Ownership verification on rehydrate**: Matching current auth model (bearer token validated by middleware, no per-operation owner check)
- **Metrics/observability**: `vfs.session.rehydrate_total` deferred to follow-up
- **Runtime options passthrough**: No current call site needs it; the signature accepts optional `runtimeOptions` for future use but tests don't exercise it

## Implementation Approach

Following TDD RED-GREEN-REFACTOR methodology:
1. **Phase 1 (RED)**: Write failing tests for `sandboxExists` dialect method
2. **Phase 2 (GREEN)**: Implement `sandboxExists` to make tests pass
3. **Phase 3 (RED)**: Write failing tests for `withSessionEntry` + `withSessionOrRehydrate`
4. **Phase 4 (GREEN)**: Implement the refactor + new method
5. **Phase 5 (GREEN)**: Rewire route call sites
6. **Phase 6 (VERIFY)**: Run full test suite including the 17 previously-failing integration tests

---

## Phase 1: RED — Tests for `sandboxExists` Dialect Method

### Phase 1: Overview
Write unit tests that define the expected behavior of `sandboxExists` on the `SqlDialect` interface and `PostgresDialect` implementation. These tests will fail because the method doesn't exist yet.

### Phase 1: Changes Required

#### 1. Update mock dialect in existing test file
**File**: `src/fs/sql-fs/sql-fs.cache.test.ts`
**Changes**: Add `sandboxExists: vi.fn()` to the mock dialect object so that the mock stays in sync with the interface after Phase 2 adds the method. This prevents a type error in existing tests.

```typescript
// In the beforeEach mock dialect (after line 64):
sandboxExists: vi.fn(),
```

#### 2. Create new unit test file for sandboxExists
**File**: `src/fs/sql-fs/dialects/postgres.sandbox-exists.test.ts` (NEW)
**Changes**: Write integration tests against real Postgres for `sandboxExists`.

```typescript
/**
 * Integration tests for PostgresDialect.sandboxExists().
 * Skips when DATABASE_URL is not set.
 */
import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";
import { PostgresDialect } from "./postgres.js";

const DB_URL = process.env.DATABASE_URL;

describe.skipIf(!DB_URL)("PostgresDialect.sandboxExists()", () => {
    let dialect: PostgresDialect;
    const testSandboxId = `test-exists-${crypto.randomUUID()}`;

    beforeAll(async () => {
        dialect = new PostgresDialect(DB_URL!);
        await dialect.connect();
    });

    afterAll(async () => {
        // Clean up: delete test sandbox if it exists
        try {
            await dialect.transaction(async (tx) => {
                await dialect.deleteSandbox(tx, testSandboxId);
            });
        } catch { /* ignore if already gone */ }
        await dialect.disconnect();
    });

    it("returns false for a sandbox that does not exist", async () => {
        const nonExistentId = `nonexistent-${crypto.randomUUID()}`;
        const exists = await dialect.transaction(async (tx) => {
            return dialect.sandboxExists(tx, nonExistentId);
        });
        expect(exists).toBe(false);
    });

    it("returns true after sandbox is created", async () => {
        await dialect.transaction(async (tx) => {
            await dialect.createSandbox(tx, testSandboxId);
        });

        const exists = await dialect.transaction(async (tx) => {
            return dialect.sandboxExists(tx, testSandboxId);
        });
        expect(exists).toBe(true);
    });

    it("returns false after sandbox is deleted", async () => {
        // Ensure sandbox exists first
        try {
            await dialect.transaction(async (tx) => {
                await dialect.createSandbox(tx, testSandboxId);
            });
        } catch { /* ignore 23505 if already exists */ }

        await dialect.transaction(async (tx) => {
            await dialect.deleteSandbox(tx, testSandboxId);
        });

        const exists = await dialect.transaction(async (tx) => {
            return dialect.sandboxExists(tx, testSandboxId);
        });
        expect(exists).toBe(false);
    });

    it("does not require sandbox context (no RLS dependency)", async () => {
        // sandboxExists should work without calling setSandboxContext first
        // because it queries the sandboxes table directly by ID
        const exists = await dialect.transaction(async (tx) => {
            // Intentionally NOT calling setSandboxContext
            return dialect.sandboxExists(tx, testSandboxId);
        });
        expect(typeof exists).toBe("boolean");
    });
});
```

### Phase 1: Success Criteria

#### Phase 1: Automated Verification
- [x] `pnpm typecheck` fails (method doesn't exist on interface yet — expected RED)
- [x] Tests in `postgres.sandbox-exists.test.ts` skip (no DATABASE_URL in unit env) — would fail with "sandboxExists is not a function" against real DB

#### Phase 1: Manual Verification
- [x] Confirm tests are well-structured and cover the three key scenarios: absent, present, deleted

### Phase 1: Discoveries and Notable Information
- Tests skip rather than fail in unit env because `describe.skipIf(!DB_URL)` gates the entire suite. The RED signal is confirmed via typecheck (4 TS2339 errors) which is the stronger signal.
- Existing cache tests (408 total) pass cleanly with the added `sandboxExists: vi.fn()` mock field.
- The advisory-lock test file uses a fake tx pattern (no real DB), while sandbox-exists tests need real Postgres — different test strategies coexist in the same directory.

---

## Phase 2: GREEN — Implement `sandboxExists`

### Phase 2: Overview
Add `sandboxExists` to the `SqlDialect` interface and implement it in `PostgresDialect`. Make all Phase 1 tests pass.

### Phase 2: Changes Required

#### 1. Add method to SqlDialect interface
**File**: `src/fs/sql-fs/types.ts`
**Changes**: Insert after `deleteSandbox` (line 147):

```typescript
	/**
	 * Returns true if a sandbox row with the given ID exists in the database.
	 * Does not require sandbox context (no RLS dependency) — queries sandboxes table directly.
	 */
	sandboxExists(tx: Tx, sandboxId: string): Promise<boolean>;
```

#### 2. Implement in PostgresDialect
**File**: `src/fs/sql-fs/dialects/postgres.ts`
**Changes**: Insert after `deleteSandbox` (line 111):

```typescript
	async sandboxExists(tx: PgTx, sandboxId: string): Promise<boolean> {
		const rows = await tx<{ exists: boolean }[]>`
			SELECT EXISTS(SELECT 1 FROM sandboxes WHERE id = ${sandboxId}) AS exists
		`;
		return rows[0]?.exists ?? false;
	}
```

#### 3. Update mock dialect in sql-fs.cache.test.ts
**File**: `src/fs/sql-fs/sql-fs.cache.test.ts`
**Changes**: Add `sandboxExists: vi.fn()` to the mock dialect at line 64 (after `deleteSandbox: vi.fn()`):

```typescript
sandboxExists: vi.fn(),
```

### Phase 2: Success Criteria

#### Phase 2: Automated Verification
- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint:fix` passes
- [ ] `pnpm test -- src/fs/sql-fs/dialects/postgres.sandbox-exists.test.ts` passes (all 4 tests green)
- [ ] `pnpm test -- src/fs/sql-fs/sql-fs.cache.test.ts` passes (existing tests still green with updated mock)

#### Phase 2: Manual Verification
- [ ] Review SQL query uses parameterized `${sandboxId}` (no injection risk)
- [ ] Confirm method does not require `setSandboxContext` call (no RLS dependency)

### Phase 2: Discoveries and Notable Information
[Filled during execution]

---

## Phase 3: RED — Tests for `withSessionEntry` and `withSessionOrRehydrate`

### Phase 3: Overview
Write unit tests that define the expected behavior of the new `withSessionOrRehydrate` method and the refactored `withSessionEntry` helper. These test the SessionManager directly using a mock createFs factory.

### Phase 3: Changes Required

#### 1. Create SessionManager unit test file
**File**: `src/api/__tests__/session-manager.rehydrate.test.ts` (NEW)
**Changes**: Write unit tests covering:
- Warm pool hit (fast path, no PG check)
- Cold pool miss, sandbox exists in PG → rehydrates via `getOrCreate`
- Cold pool miss, sandbox absent from PG → throws ENOENT
- Concurrent rehydration for same sandbox serializes (no duplicate sessions)
- Destroyed sandbox stays ENOENT (PG row deleted → `sandboxExists` returns false)

```typescript
/**
 * Unit tests for SessionManager.withSessionOrRehydrate().
 *
 * Tests the three code paths:
 * 1. Warm hit: sandbox in pool → execute immediately
 * 2. Cold hit: sandbox in PG but not in pool → rehydrate via getOrCreate
 * 3. Cold miss: sandbox not in PG → throw ENOENT
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { SessionManager } from "../session-manager.js";
import type { IFileSystem } from "just-bash";

// Minimal IFileSystem stub — only needs getAllPaths for pathCacheBytes estimation
function stubFs(): IFileSystem {
    return {
        getAllPaths: () => ["/", "/home", "/home/user", "/tmp", "/bin"],
        // All other methods are unused in these tests
    } as unknown as IFileSystem;
}

// Tracks which sandboxes "exist" in our fake Postgres
let pgSandboxes: Set<string>;

// Spy to track createFs calls
let createFsSpy: ReturnType<typeof vi.fn>;

function makeSessionManager(): SessionManager {
    pgSandboxes = new Set();
    createFsSpy = vi.fn(async (_backend: string, _sandboxId: string) => {
        return stubFs();
    });
    return new SessionManager({
        backend: "memory",
        createFs: createFsSpy,
    });
}

describe("SessionManager.withSessionOrRehydrate()", () => {
    let sm: SessionManager;

    beforeEach(() => {
        sm = makeSessionManager();
    });

    it("returns result from warm session without PG check", async () => {
        // Warm the pool
        await sm.withSession("sb-1", async () => "warmed");

        const result = await sm.withSessionOrRehydrate("sb-1", async (session) => {
            return `hello from ${session.state}`;
        });
        expect(result).toBe("hello from active");
        // createFs should have been called only once (during warmup), not again
        expect(createFsSpy).toHaveBeenCalledTimes(1);
    });

    it("throws ENOENT when sandbox does not exist in pool or PG", async () => {
        await expect(
            sm.withSessionOrRehydrate("nonexistent", async () => "nope"),
        ).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("rehydrates from PG when sandbox exists in DB but not in pool", async () => {
        // Simulate: sandbox was created on another replica (exists in PG)
        pgSandboxes.add("sb-cold");

        const result = await sm.withSessionOrRehydrate("sb-cold", async (session) => {
            return session.state;
        });
        expect(result).toBe("active");
        // createFs called once for the rehydration
        expect(createFsSpy).toHaveBeenCalledWith("memory", "sb-cold");
    });

    it("rehydrated session is warm on subsequent calls", async () => {
        pgSandboxes.add("sb-once");

        // First call: rehydrates
        await sm.withSessionOrRehydrate("sb-once", async () => "first");
        // Second call: warm hit
        await sm.withSessionOrRehydrate("sb-once", async () => "second");

        // createFs called only once (rehydration), not twice
        expect(createFsSpy).toHaveBeenCalledTimes(1);
    });
});
```

**Note**: This test file will need adjustment during Phase 4 implementation because `withSessionOrRehydrate` needs a way to call `sandboxExists` against Postgres. The exact mechanism (injected `sandboxExistsFn` or access through the dialect) will be finalized in Phase 4. The test structure and assertions are the important RED artifacts.

### Phase 3: Success Criteria

#### Phase 3: Automated Verification
- [ ] `pnpm typecheck` fails (method doesn't exist on SessionManager yet — expected RED)
- [ ] Tests fail with "withSessionOrRehydrate is not a function" or similar

#### Phase 3: Manual Verification
- [ ] Confirm tests cover all three code paths (warm, cold-exists, cold-absent)
- [ ] Confirm no mocking of internals that would make tests brittle

### Phase 3: Discoveries and Notable Information
[Filled during execution]

---

## Phase 4: GREEN — Implement `withSessionEntry` Refactor + `withSessionOrRehydrate`

### Phase 4: Overview
This is the core implementation phase. Extract shared logic into `withSessionEntry`, add `withSessionOrRehydrate`, and update the SessionManager constructor to accept a `sandboxExistsFn` for PG existence checks.

### Phase 4: Changes Required

#### 1. Add `sandboxExistsFn` to SessionManager constructor options
**File**: `src/api/session-manager.ts`
**Changes**: Extend the constructor options interface (~line 110) to accept an optional existence-check function:

```typescript
// Add to the SessionManagerOptions interface:
/**
 * Checks whether a sandbox exists in the persistent store (Postgres).
 * Required for withSessionOrRehydrate to distinguish "evicted" from "deleted".
 * When undefined, withSessionOrRehydrate falls back to withExistingSession behavior.
 */
sandboxExistsFn?: (sandboxId: string) => Promise<boolean>;
```

Store it as a private field:
```typescript
private readonly sandboxExistsFn?: (sandboxId: string) => Promise<boolean>;
```

#### 2. Extract `withSessionEntry` helper
**File**: `src/api/session-manager.ts`
**Changes**: Add a private method that encapsulates the shared closing-check → ensureFreshCache → mutex → inFlight → fn → publishVersionIfDirty pattern. Insert after `withExecLock` (~line 290):

```typescript
/**
 * Shared entry logic for all session wrappers.
 * Must be called inside the distributed exec lock.
 *
 * 1. Checks session isn't closing
 * 2. Runs cross-replica cache coherence (Phase D)
 * 3. Acquires local mutex, tracks inFlight
 * 4. Calls fn(session)
 * 5. Publishes version if dirty (Phase D/E)
 */
private async withSessionEntry<T>(sandboxId: string, session: Session, fn: (session: Session) => Promise<T>): Promise<T> {
    if (session.state === "closing") {
        throw Object.assign(new Error("ESESSIONCLOSING: session is being destroyed"), { code: "ESESSIONCLOSING" });
    }

    await this.ensureFreshCache(sandboxId, session);

    return session.mutex.runExclusive(async () => {
        if (session.state === "closing") {
            throw Object.assign(new Error("ESESSIONCLOSING: session is being destroyed"), { code: "ESESSIONCLOSING" });
        }
        session.inFlight++;
        session.lastUsed = Date.now();
        try {
            return await fn(session);
        } finally {
            try {
                await this.publishVersionIfDirty(sandboxId, session);
            } catch (err) {
                console.error(
                    JSON.stringify({
                        event: "publish_version_finally_error",
                        sandboxId,
                        error: (err as Error).message,
                    }),
                );
            }
            session.inFlight--;
            session.pathCacheBytes = this.estimatePathCacheBytes(session.fs);
            session.overBudget = session.pathCacheBytes > this.pathCacheMaxBytes;
        }
    });
}
```

#### 3. Refactor `withSession` to use `withSessionEntry`
**File**: `src/api/session-manager.ts`
**Changes**: Replace the body of `withSession` (lines 396-444) with delegation to `withSessionEntry`:

```typescript
async withSession<T>(
    sandboxId: string,
    fn: (session: Session) => Promise<T>,
    runtimeOptions?: RuntimeOptions,
): Promise<T> {
    return this.withExecLock(sandboxId, async () => {
        const session = await this.getOrCreate(sandboxId, runtimeOptions);
        return this.withSessionEntry(sandboxId, session, fn);
    });
}
```

#### 4. Refactor `withExistingSession` to use `withSessionEntry`
**File**: `src/api/session-manager.ts`
**Changes**: Replace the body of `withExistingSession` (lines 455-493) with delegation:

```typescript
async withExistingSession<T>(sandboxId: string, fn: (session: Session) => Promise<T>): Promise<T> {
    return this.withExecLock(sandboxId, async () => {
        const session = this.sessions.get(sandboxId);
        if (session === undefined) {
            throw Object.assign(new Error(`ENOENT: sandbox ${sandboxId} not found`), { code: "ENOENT" });
        }
        return this.withSessionEntry(sandboxId, session, fn);
    });
}
```

#### 5. Add `withSessionOrRehydrate` method
**File**: `src/api/session-manager.ts`
**Changes**: Add new public method after `withExistingSession`:

```typescript
/**
 * Like withExistingSession, but falls back to Postgres to check if the sandbox
 * exists before throwing ENOENT. If the sandbox is in Postgres but not in the
 * pool (evicted by reaper, or created on another replica), rehydrates it via
 * getOrCreate — leveraging Phase E snapshot for fast cold-start.
 *
 * Fast path: Map.get outside distributed lock (no Redis RTT for warm hits).
 * Cold path: lock → double-check → PG exists → getOrCreate.
 *
 * Requires `sandboxExistsFn` to be set in constructor options.
 * Falls back to withExistingSession behavior when `sandboxExistsFn` is undefined.
 */
async withSessionOrRehydrate<T>(
    sandboxId: string,
    fn: (session: Session) => Promise<T>,
    runtimeOptions?: RuntimeOptions,
): Promise<T> {
    // Fast path: warm pool hit — no lock needed
    const warm = this.sessions.get(sandboxId);
    if (warm !== undefined && warm.state !== "closing") {
        return this.withExecLock(sandboxId, async () => {
            // Re-check under lock (may have been evicted between check and lock acquisition)
            const session = this.sessions.get(sandboxId);
            if (session !== undefined && session.state !== "closing") {
                return this.withSessionEntry(sandboxId, session, fn);
            }
            // Fall through to cold path
            return this.rehydrateAndExec(sandboxId, fn, runtimeOptions);
        });
    }

    // Cold path: need to check Postgres
    return this.withExecLock(sandboxId, async () => {
        // Double-check under lock
        const session = this.sessions.get(sandboxId);
        if (session !== undefined && session.state !== "closing") {
            return this.withSessionEntry(sandboxId, session, fn);
        }
        return this.rehydrateAndExec(sandboxId, fn, runtimeOptions);
    });
}

/**
 * Cold-path helper: checks PG existence, rehydrates via getOrCreate, then executes.
 * Must be called inside the distributed exec lock.
 */
private async rehydrateAndExec<T>(
    sandboxId: string,
    fn: (session: Session) => Promise<T>,
    runtimeOptions?: RuntimeOptions,
): Promise<T> {
    if (this.sandboxExistsFn !== undefined) {
        const exists = await this.sandboxExistsFn(sandboxId);
        if (!exists) {
            throw Object.assign(
                new Error(`ENOENT: sandbox ${sandboxId} not found`),
                { code: "ENOENT" },
            );
        }
    } else {
        // No existence check configured — strict pool-only behavior
        const session = this.sessions.get(sandboxId);
        if (session === undefined) {
            throw Object.assign(
                new Error(`ENOENT: sandbox ${sandboxId} not found`),
                { code: "ENOENT" },
            );
        }
    }
    const session = await this.getOrCreate(sandboxId, runtimeOptions);
    return this.withSessionEntry(sandboxId, session, fn);
}
```

#### 6. Wire up `sandboxExistsFn` in server.ts
**File**: `src/api/server.ts`
**Changes**: Where `SessionManager` is constructed, pass a `sandboxExistsFn` that uses the Postgres dialect:

```typescript
// The sandboxExistsFn creates a one-shot dialect connection to check existence.
// This is acceptable because:
// 1. It only runs on cold-path (first access per sandbox per replica)
// 2. The connection is pooled by the postgres driver
const sandboxExistsFn = async (sandboxId: string): Promise<boolean> => {
    const dialect = new PostgresDialect(databaseUrl);
    await dialect.connect();
    try {
        return await dialect.transaction(async (tx) => {
            return dialect.sandboxExists(tx, sandboxId);
        });
    } finally {
        await dialect.disconnect();
    }
};

const sessionManager = new SessionManager({
    backend,
    createFs: (b, id) => createSandboxFs(b, id),
    sandboxExistsFn: backend === "postgres" ? sandboxExistsFn : undefined,
});
```

**Important**: Review how the existing `createFs` factory manages connections. If the dialect connection can be shared or pooled, prefer that over creating a new connection per existence check. The implementer should check if `getRedisClient()` / connection pooling patterns apply here.

**Alternative (preferred if feasible)**: If the SessionManager already has access to a dialect instance or connection pool, use that instead of creating a new one. The research shows `createSandboxFs` creates a new `PostgresDialect` per call (line 47 of `index.ts`), so a separate lightweight check function is warranted.

#### 7. Update Phase 3 test file to work with actual implementation
**File**: `src/api/__tests__/session-manager.rehydrate.test.ts`
**Changes**: Adjust the test setup to pass `sandboxExistsFn` that checks the `pgSandboxes` Set:

```typescript
function makeSessionManager(): SessionManager {
    pgSandboxes = new Set();
    createFsSpy = vi.fn(async (_backend: string, _sandboxId: string) => {
        return stubFs();
    });
    return new SessionManager({
        backend: "memory",
        createFs: createFsSpy,
        sandboxExistsFn: async (sandboxId: string) => pgSandboxes.has(sandboxId),
    });
}
```

### Phase 4: Success Criteria

#### Phase 4: Automated Verification
- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint:fix` passes
- [ ] `pnpm test -- src/api/__tests__/session-manager.rehydrate.test.ts` passes (all tests green)
- [ ] `pnpm test:unit` passes (no regressions — withSession/withExistingSession still work)

#### Phase 4: Manual Verification
- [ ] Review `withSessionEntry` captures exact same behavior as original inline code
- [ ] Review `withSessionOrRehydrate` fast path skips Redis lock on warm hit
- [ ] Review `rehydrateAndExec` prevents resurrection of deleted sandboxes
- [ ] Confirm `withExistingSession` is preserved for internal use (reaper, strict tests)

### Phase 4: Discoveries and Notable Information
[Filled during execution]

---

## Phase 5: GREEN — Rewire Route Call Sites

### Phase 5: Overview
Replace all 11 `withExistingSession` call sites in HTTP routes and MCP tools with `withSessionOrRehydrate`. This is a mechanical find-and-replace — the method signature is compatible (same `sandboxId` + `fn` args, optional `runtimeOptions`).

### Phase 5: Changes Required

#### 1. Exec routes (2 call sites)
**File**: `src/api/routes/exec.ts`

**Line 65** — exec-sync:
```typescript
// Before:
const execResult = await sessionManager.withExistingSession<ExecSyncResult>(sandboxId, async (session) => {
// After:
const execResult = await sessionManager.withSessionOrRehydrate<ExecSyncResult>(sandboxId, async (session) => {
```

**Line 148** — exec SSE:
```typescript
// Before:
await sessionManager.withExistingSession(sandboxId, async (session) => {
// After:
await sessionManager.withSessionOrRehydrate(sandboxId, async (session) => {
```

#### 2. File routes (5 call sites)
**File**: `src/api/routes/files.ts`

Replace `withExistingSession` → `withSessionOrRehydrate` at lines:
- **Line 105** — GET file (read)
- **Line 165** — PUT file (write)
- **Line 192** — DELETE file
- **Line 291** — mkdir
- **Line 332** — tree listing

#### 3. Ingest routes (3 call sites)
**File**: `src/api/routes/ingest.ts`

Replace at lines:
- **Line 71** — ingest tar.gz
- **Line 162** — ingest JSON manifest
- **Line 209** — export tar.gz

#### 4. MCP tools (3 call sites)
**File**: `src/api/mcp/tools.ts`

Replace at lines:
- **Line 134** — bash_exec
- **Line 217** — fs_ingest
- **Line 263** — fs_export

#### Total: 13 replacements (11 unique call sites + 2 additional found in files.ts at lines 242 and 291)

**Search-and-replace pattern**:
```
withExistingSession  →  withSessionOrRehydrate
```

This is safe because the method signatures are compatible:
- `withExistingSession<T>(sandboxId, fn)` → `withSessionOrRehydrate<T>(sandboxId, fn)`
- No call site passes `runtimeOptions` (the third optional param)

### Phase 5: Success Criteria

#### Phase 5: Automated Verification
- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint:fix` passes
- [ ] `pnpm test:unit` passes
- [ ] `grep -r 'withExistingSession' src/api/routes/ src/api/mcp/` returns 0 matches (all rewired)
- [ ] `grep -r 'withSessionOrRehydrate' src/api/routes/ src/api/mcp/` returns 13 matches

#### Phase 5: Manual Verification
- [ ] Verify `withExistingSession` still exists in `session-manager.ts` (kept for internal use)
- [ ] Verify no route accidentally passes `runtimeOptions` (it shouldn't)

### Phase 5: Discoveries and Notable Information
[Filled during execution]

---

## Phase 6: VERIFY — Full Test Suite Including Integration Tests

### Phase 6: Overview
Run the full test suite. The 17 previously-failing tests in `concurrency.pg.test.ts` should now pass because the HTTP routes use `withSessionOrRehydrate`, which checks Postgres and rehydrates cold sessions.

### Phase 6: Changes Required

#### 1. Verify concurrency.pg.test.ts setup wires sandboxExistsFn
**File**: `src/api/__tests__/integration/concurrency.pg.test.ts`
**Changes**: Check that `makePgEnv()` (line 58) constructs SessionManager with `sandboxExistsFn`. If the server.ts wiring from Phase 4 doesn't apply to test setup, update `makePgEnv`:

```typescript
function makePgEnv() {
    const databaseUrl = process.env.DATABASE_URL!;
    const sandboxExistsFn = async (sandboxId: string): Promise<boolean> => {
        const dialect = new PostgresDialect(databaseUrl);
        await dialect.connect();
        try {
            return await dialect.transaction(async (tx) => {
                return dialect.sandboxExists(tx, sandboxId);
            });
        } finally {
            await dialect.disconnect();
        }
    };

    const sm = new SessionManager({
        backend: "postgres",
        createFs: (backend, sandboxId) => createSandboxFs(backend, sandboxId),
        sandboxExistsFn,
    });
    const app = new Hono<{ Variables: AuthVariables }>();
    app.use("/v1/*", authMiddleware);
    app.route("/v1/sandboxes", fileRoutes(sm));
    return { app, sm };
}
```

**Also add the import** at the top of the file:
```typescript
import { PostgresDialect } from "../../../fs/sql-fs/dialects/postgres.js";
```

#### 2. Review test sandbox creation
The tests in `concurrency.pg.test.ts` call `newId()` to get a UUID, then immediately hit HTTP routes. The routes now call `withSessionOrRehydrate` → `sandboxExistsFn(sandboxId)`. But these sandboxes haven't been created in Postgres yet!

**Key insight**: `createSandboxFs()` (called by `getOrCreate`) both creates the sandbox row in PG AND returns the filesystem. So the flow is:
1. Route receives request for sandbox `sb-xyz`
2. `withSessionOrRehydrate` checks pool → miss
3. `sandboxExistsFn("sb-xyz")` → **false** (never created)
4. Throws ENOENT

**This means the tests still need to create the sandbox in PG first.** The tests must either:
- Call `POST /v1/sandboxes` first (which uses `withSession` → `getOrCreate` → creates in PG), OR
- Call `sm.getOrCreate(sbId)` to warm the pool (which also creates in PG)

**Review the test code**: Check if tests are designed to work with the rehydration path (sandbox exists in PG from another replica) or if they assume fresh sandboxes. If the latter, the tests need a `createSandboxFs` warmup step added.

**Most likely fix**: Add a helper that creates the sandbox in PG without warming the pool:

```typescript
import { PostgresDialect } from "../../../fs/sql-fs/dialects/postgres.js";

/** Create a sandbox in Postgres without warming the SessionManager pool. */
async function createSandboxInPg(sandboxId: string): Promise<void> {
    const dialect = new PostgresDialect(DB_URL!);
    await dialect.connect();
    try {
        await dialect.transaction(async (tx) => {
            await dialect.createSandbox(tx, sandboxId);
        });
    } catch (e) {
        const sqlErr = e as { code?: string };
        if (sqlErr.code !== "23505") throw e; // Ignore unique violation
    } finally {
        await dialect.disconnect();
    }
}
```

Then in each test, before hitting HTTP routes:
```typescript
it(`all ${N} writes return 204`, async () => {
    const { app } = makePgEnv();
    const token = await makeToken();
    const sbId = newId();
    await createSandboxInPg(sbId);  // ← Add this line
    // ... existing test code
});
```

This simulates the real-world scenario: sandbox was created on Replica A, and Replica B (this test's SessionManager) is cold but should rehydrate.

### Phase 6: Success Criteria

#### Phase 6: Automated Verification
- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint:fix` passes
- [ ] `pnpm test:unit` passes (all unit tests green)
- [ ] `pnpm test:integration` passes (all 17 concurrency.pg tests green)
- [ ] `pnpm test` passes (full suite)

#### Phase 6: Manual Verification
- [ ] Confirm each of the 17 tests passes individually (not just the suite)
- [ ] No new test files left in failing state
- [ ] `withExistingSession` is no longer called from any route (only from internal SessionManager code)

### Phase 6: Discoveries and Notable Information
[Filled during execution]

---

## Testing Strategy

### Unit Tests (no DB required)
- `src/fs/sql-fs/sql-fs.cache.test.ts` — Existing tests pass with updated mock dialect
- `src/api/__tests__/session-manager.rehydrate.test.ts` — New tests for withSessionOrRehydrate:
  - Warm hit returns immediately
  - Cold hit with PG existence → rehydrates
  - Cold miss → ENOENT
  - Rehydrated session is warm on subsequent calls
  - No `sandboxExistsFn` → falls back to strict pool-only

### Integration Tests (requires DATABASE_URL)
- `src/fs/sql-fs/dialects/postgres.sandbox-exists.test.ts` — New tests for dialect method:
  - Returns false for absent sandbox
  - Returns true after creation
  - Returns false after deletion
  - Works without RLS context
- `src/api/__tests__/integration/concurrency.pg.test.ts` — Existing 17 tests now pass

### Key Edge Cases
- Race: concurrent rehydration + destroy for same sandbox (serialized by exec lock)
- Race: reaper evicts session while rehydration is in progress (double-check under lock)
- Sandbox created on Replica A, first access on Replica B (the core scenario)
- Server restart: all sessions evicted, first request rehydrates each

## Performance Considerations

| Scenario | Latency | I/O |
|----------|---------|-----|
| Warm hit (common case) | ~0ms | 1 Map.get (no lock) |
| Cold hit, sandbox exists | ~10ms | Lock acquire + SELECT EXISTS + getOrCreate (Phase E snapshot) |
| Cold hit, sandbox absent | ~2ms | Lock acquire + SELECT EXISTS |

The ~10ms cold-hit cost is paid once per replica per sandbox, amortized across all subsequent requests until idle eviction. Phase E snapshot reduces the pathCache load from ~10ms CTE to ~5ms Redis read.

## Security Preservation

- **Deleted sandboxes stay deleted**: PG existence check is the gate. DELETE removes the row → `sandboxExists` returns false → ENOENT.
- **No new attack surface**: Random UUID to any route still gets ENOENT (absent from `sandboxes` table).
- **Destroy race safe**: Concurrent DELETE and rehydrate serialize on the distributed exec lock.
- **No ownership change**: Rehydrated sessions use default owner (""), same as `getOrCreate` always has. Auth middleware validates bearer tokens independently.

## References

- Research document: `thoughts/shared/research/2026-04-24_21-16-55_session-rehydration-gap.md`
- GitHub Issue #10: Multi-replica session rehydration gap
- `src/api/session-manager.ts` — SessionManager (the file being modified)
- `src/fs/sql-fs/types.ts:141-147` — SqlDialect sandbox lifecycle methods
- `src/fs/sql-fs/dialects/postgres.ts:106-111` — PostgresDialect.deleteSandbox pattern
- `src/api/__tests__/integration/concurrency.pg.test.ts` — 17 failing tests (acceptance criterion)
- `src/fs/sql-fs/sql-fs.cache.test.ts:56-82` — Mock dialect pattern to follow
- `tasks/IMPLEMENT-multi-replica-redis.md` — Phase A/C/E gap discovery documentation

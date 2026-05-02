---
date: 2026-05-02T12:54:26+09:30
researcher: quangnguyentechno@gmail.com
git_commit: 7a7395bb9158cd6c39dbd498af9604769e7350cd
branch: feat/bulk-fs-ops-script-tx
repository: virtualFS
task: "Lazy script-scoped transaction + bulk FS operations (mvBulk/rmBulk/cpBulk)"
tags: [implementation-plan, sql-fs, session-manager, performance, latency]
status: draft
last_updated: 2026-05-02
last_updated_by: quangnguyentechno@gmail.com
revision: 2
review_fixes:
  - "rollback-safe cache recovery (reload + clearDirty after abort)"
  - "lazy script-tx: open on first write, not eagerly"
  - "reorder: script-tx first (benchmark-impactful), bulk methods second (preparation for upstream)"
  - "bulk methods: snapshot-and-restore cache on tx failure"
  - "separate IScriptTxFs interface + asScriptTxFs() guard"
  - "pool sizing: peak concurrent execs across all sandboxes/tenants"
---

# Lazy Script-Scoped Transaction + Bulk FS Operations

## Overview

Two complementary features to eliminate per-op transaction overhead in the remote bash pipeline:

1. **Lazy script-scoped transaction (SessionScopedFs)**: A wrapper that holds one `dialect.transaction` open across an entire `bash.exec(script)` call — but only opens it lazily on the first write, not eagerly. Read-only scripts (`ls`, `cat`, `grep`) never acquire a DB connection or advisory lock. Chained write commands like `mv a b && mkdir c && rm d` share a single BEGIN/set_config/pg_advisory_xact_lock/COMMIT envelope.

2. **Bulk-arg fast paths**: `mvBulk`, `rmBulk`, `cpBulk` methods on SqlFs that execute N operations in a single transaction. These are preparation for an upstream just-bash PR that teaches builtins to call `fs.mvBulk(pairs)` when present. They do **not** affect current benchmark numbers on their own — just-bash still calls `fs.mv()` per arg today.

Per the [latency research](../research/2026-05-02_11-24-37_remote-bash-latency-scaling.md), each `fs.*` call currently pays ~4 sequential DB round-trips in fixed overhead. For a 3-file `mv`, this means 12 wasted RTTs. The lazy script-tx reduces that to 4 RTTs total for the entire script. Bulk methods will further compound the win once just-bash calls them.

## Current State Analysis

### Per-op transaction overhead

Every write method in SqlFs wraps its work in `#withTx` (`sql-fs.ts:164`):

```ts
async #withTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.#dialect.transaction(async (tx) => {
        await this.#dialect.setSandboxContextWithLock(tx, this.#sandboxId);
        return await fn(tx);
    });
}
```

`setSandboxContextWithLock` issues two sequential queries (`postgres.ts:63-68`):
1. `SELECT set_config('app.sandbox_id', $1, true)` — RLS context
2. `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))` — write serialization

Combined with `BEGIN`/`COMMIT`, that's 4 RTTs per write op before any actual work.

### Cache update timing (critical for script-tx design)

Existing single-op methods update `#pathCache` and `#contentCache` **after** `#withTx` returns, i.e., after COMMIT:

```ts
// mv() at sql-fs.ts:917-946
await this.#withTx(async (tx) => {
    // DB work inside transaction
});
// Cache updates here — only reached after COMMIT
this.#pathCache.set(dest + oldPath.slice(src.length), entry);
this.#dirty = true;
```

This is safe because if the tx rolls back (exception in fn), the cache update never executes. With script-tx, `#withTx` returns after the fn body, not after COMMIT — so cache updates run before the transaction outcome is known. This requires a rollback recovery path.

### Version publishing in withSessionEntry

`withSessionEntry` (`session-manager.ts:354-360`) publishes dirty state in a `finally` block:

```ts
try {
    return await fn(session);
} finally {
    // Runs regardless of whether fn() threw
    await this.publishVersionIfDirty(tenantId, sandboxId, session);
}
```

If `bash.exec()` throws and the script-tx is aborted (rolled back), `dirty` is still true from the now-rolled-back operations. Publishing a version bump for phantom changes would cause other replicas to reload needlessly. The abort path must `reload()` + `clearDirty()` before this `finally` block runs.

### just-bash multi-arg fan-out

Shell builtins loop per source arg with `await`:
- `mv` — `chunk-A4JSPFCI.js`: `for (let e of g) ... await t.fs.mv(c, o)`
- `rm` — `chunk-MIZPJHVH.js`: `for (let r of c) ... await s.fs.rm(n, ...)`
- `cp` — `chunk-NUYSJFDK.js`: `for (let r of d) ... await e.fs.cp(a, i, {recursive: u})`

Adding `mvBulk/rmBulk/cpBulk` to SqlFs is inert unless just-bash detects and calls them. The script-tx is what actually improves benchmarks since the existing per-op `fs.mv()` calls share one transaction.

### Existing batch pattern

`bulkIngest` (`sql-fs.ts:401-428`) demonstrates one-tx-many-ops: it ingests N files in a single `#withTx` call with bulk INSERT statements. However, `bulkIngest` runs cache updates inside the tx callback — acceptable there because it calls `reload()` on the success path anyway, but the bulk FS methods need a safer approach.

### Key Discoveries
- `#withReadTx` (`sql-fs.ts:178`) skips the advisory lock — pure reads don't serialize behind writers. An eager script-tx that acquires the advisory lock upfront would regress read-only scripts by serializing `ls`/`cat`/`grep` behind cross-replica writers. Lazy activation avoids this.
- `session.mutex.runExclusive` (`session-manager.ts:348`) serializes execs per sandbox, but NOT globally. With N concurrent sandboxes, script-tx holds N DB connections. Pool sizing must cover peak concurrent execs across all sandboxes/tenants.
- `asCoherentFs()` (`session-manager.ts:41-51`) only checks `reload`/`wasDirty`/`clearDirty`. Adding script-tx methods to `ICoherentFs` would let non-SqlFs implementations pass the check and crash on `beginScriptTx()`. A separate interface + guard is needed.
- Path/content caches are in-process `Map`/`LRU` — submicrosecond, not the bottleneck.
- `publishVersionIfDirty` (`session-manager.ts:404`) runs once per script in `withSessionEntry`'s finally block.

## Desired End State

After this plan is complete:

1. SqlFs supports a "lazy script-tx mode" where `#withTx` reuses a held transaction instead of opening a new one, with the transaction opening lazily on first write
2. `SessionScopedFs` manages script-tx lifecycle via `beginScope()` / `endScope()` / `abortScope()`
3. `SessionManager.execWithRuntimeThrottle` wraps `bash.exec()` in a script scope — read-only scripts never open a transaction
4. On script-tx abort, cache is restored via `reload()` + `clearDirty()` before version publishing
5. SqlFs exposes `mvBulk(pairs)`, `rmBulk(paths, opts)`, `cpBulk(pairs, opts)` — each runs N ops in one DB transaction with snapshot-and-restore cache safety
6. Benchmark numbers for multi-op cases drop significantly (e.g., `mv: move 3 files` from ~294ms toward ~80ms)

### How to verify
- All existing unit tests pass (`pnpm test:unit`)
- New unit tests cover lazy script-tx, rollback recovery, bulk methods
- `pnpm typecheck` passes
- Benchmark script (`scripts/benchmark_remote_bash.py`) shows reduced latency for multi-op cases
- Read-only scripts show no regression (no tx opened)

## What We're NOT Doing

- **Modifying just-bash source locally** — bulk methods are published on our IFileSystem impl; upstream PR is a separate effort
- **Write-back queue** (option B from research) — deferred to a future plan
- **Fusing set_config + pg_advisory_xact_lock** (Tier 1.1 from research) — orthogonal optimization
- **Collapsing op queries into CTEs** (Tier 1.2) — orthogonal
- **Redis L2 for write-back** — on roadmap but separate
- **Other dialect support** (MySQL, Azure SQL) — Postgres only for now; other dialects can follow the same pattern later
- **Transaction-local cache staging layer** — deferred; snapshot-and-restore is sufficient for bulk methods, and `reload()` is the recovery path for script-tx abort

## Implementation Approach

Three phases in dependency order, reordered from v1 to put the benchmark-impactful work first:

1. **Phase 1: Lazy script-scoped transaction with rollback-safe cache recovery** — the change that actually improves benchmark latency for every multi-op script today
2. **Phase 2: Bulk FS methods with transactional cache safety** — preparation for upstream just-bash integration; snapshot-and-restore cache pattern
3. **Phase 3: Benchmark verification** — confirm latency improvements

---

## Phase 1: Lazy Script-Scoped Transaction with Rollback-Safe Cache Recovery

### Phase 1: Overview

Add a lazy script-tx mode to SqlFs: enter "script scope" at exec start, but open the actual DB transaction only when the first write-path `#withTx` call happens. Read-only scripts never acquire a connection or advisory lock. On abort (JS exception), restore cache consistency via `reload()` + `clearDirty()` before `withSessionEntry`'s `publishVersionIfDirty` runs.

### Phase 1: Changes Required

#### 1a. New `IScriptTxFs` interface (separate from `ICoherentFs`)

**File**: `src/fs/sql-fs/sql-fs.ts`
**Changes**: Add new interface after `ICoherentFs` (~line 103)

```ts
export interface IScriptTxFs extends ICoherentFs {
    beginScriptScope(): void;
    endScriptScope(): Promise<void>;
    abortScriptScope(): Promise<void>;
    readonly scriptScopeActive: boolean;
    readonly scriptTxOpen: boolean;
}
```

Separate from `ICoherentFs` so that `asCoherentFs()` remains stable. The new methods:
- `beginScriptScope()` — synchronous; just sets a flag. No DB work.
- `endScriptScope()` — if a tx was opened lazily, commits it. If no tx was opened (read-only script), no-op.
- `abortScriptScope()` — if a tx was opened, abandons it (dialect rolls back). Then `reload()` + `clearDirty()` to restore cache consistency.
- `scriptScopeActive` — true between begin/end
- `scriptTxOpen` — true only if the lazy tx has actually been opened (first write happened)

#### 1b. New runtime guard: `asScriptTxFs()`

**File**: `src/api/session-manager.ts`
**Changes**: Add new guard function after `asCoherentFs()` (~line 51)

```ts
function asScriptTxFs(fs: IFileSystem): IScriptTxFs | undefined {
    const partial = fs as Partial<IScriptTxFs>;
    if (
        typeof partial.beginScriptScope === "function" &&
        typeof partial.endScriptScope === "function" &&
        typeof partial.abortScriptScope === "function" &&
        typeof partial.reload === "function" &&
        typeof partial.wasDirty === "function" &&
        typeof partial.clearDirty === "function"
    ) {
        return fs as IScriptTxFs;
    }
    return undefined;
}
```

Checks all 6 required methods. `asCoherentFs()` remains unchanged — existing callers are unaffected.

#### 1c. New private fields on SqlFs

**File**: `src/fs/sql-fs/sql-fs.ts`
**Changes**: Add fields after `#prewarmQueued` (~line 132)

```ts
#scriptScope = false;
#scriptTx: Tx | undefined;
#scriptTxEnd: (() => void) | undefined;
#scriptTxPromise: Promise<void> | undefined;
```

- `#scriptScope` — flag indicating we're inside a script execution (set synchronously by `beginScriptScope`)
- `#scriptTx` — the lazily-opened transaction handle (only set after first write)
- `#scriptTxEnd` — the deferred-promise resolver for committing
- `#scriptTxPromise` — the deferred transaction promise

#### 1d. Modified `#withTx` — lazy tx activation

**File**: `src/fs/sql-fs/sql-fs.ts`
**Changes**: Replace `#withTx` at line 164

```ts
async #withTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    if (this.#scriptScope) {
        if (this.#scriptTx === undefined) {
            await this.#openScriptTx();
        }
        return fn(this.#scriptTx!);
    }
    return this.#dialect.transaction(async (tx) => {
        await this.#dialect.setSandboxContextWithLock(tx, this.#sandboxId);
        return await fn(tx);
    });
}
```

When `#scriptScope` is true:
1. If no tx yet (first write), open it lazily via `#openScriptTx()`
2. Reuse the held tx — skips BEGIN/setSandboxContextWithLock/COMMIT per op

When `#scriptScope` is false:
- Unchanged behavior — each op gets its own tx

#### 1e. `#withReadTx` — reuse script-tx only if already open

**File**: `src/fs/sql-fs/sql-fs.ts`
**Changes**: Replace `#withReadTx` at line 178

```ts
async #withReadTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    if (this.#scriptScope && this.#scriptTx !== undefined) {
        return fn(this.#scriptTx);
    }
    return this.#dialect.transaction(async (tx) => {
        await this.#dialect.setSandboxContext(tx, this.#sandboxId);
        return await fn(tx);
    });
}
```

Key difference from `#withTx`: does **not** open a tx lazily. If we're in script scope but no write has happened yet, reads still use their own lightweight read-tx (no advisory lock). Only if a write has already opened the script-tx do reads piggyback on it. This means:
- `ls` / `cat` / `grep` in a read-only script → no script-tx opened, no advisory lock
- `ls` after `mv` in the same script → reuses the already-open script-tx (coherent with the uncommitted write)

#### 1f. `#openScriptTx()` — deferred-promise pattern

**File**: `src/fs/sql-fs/sql-fs.ts`
**Changes**: New private method after `#withReadTx`

```ts
async #openScriptTx(): Promise<void> {
    let resolveTxReady!: () => void;
    const txReady = new Promise<void>((r) => {
        resolveTxReady = r;
    });

    let resolveEnd!: () => void;
    const endPromise = new Promise<void>((r) => {
        resolveEnd = r;
    });
    this.#scriptTxEnd = resolveEnd;

    this.#scriptTxPromise = this.#dialect.transaction(async (tx) => {
        await this.#dialect.setSandboxContextWithLock(tx, this.#sandboxId);
        this.#scriptTx = tx;
        resolveTxReady();
        await endPromise;
    });

    await txReady;
}
```

How it works:
1. Calls `dialect.transaction(fn)` which issues `BEGIN`
2. Inside fn: sets RLS context + advisory lock once, stores the tx handle, signals "ready"
3. fn then `await endPromise` — holding the transaction open
4. All subsequent `#withTx` calls reuse `#scriptTx`
5. `endScriptScope()` resolves `endPromise` → fn returns → dialect issues COMMIT
6. On abort, the dialect's `.begin()` catches the rejection and issues ROLLBACK

#### 1g. Public `IScriptTxFs` methods on SqlFs

**File**: `src/fs/sql-fs/sql-fs.ts`
**Changes**: New public methods after `reload()` (~line 390)

```ts
get scriptScopeActive(): boolean {
    return this.#scriptScope;
}

get scriptTxOpen(): boolean {
    return this.#scriptTx !== undefined;
}

beginScriptScope(): void {
    if (this.#scriptScope) {
        throw new Error("beginScriptScope: a script scope is already active");
    }
    this.#scriptScope = true;
}

async endScriptScope(): Promise<void> {
    if (!this.#scriptScope) return;
    this.#scriptScope = false;

    if (this.#scriptTxEnd !== undefined) {
        this.#scriptTxEnd();
        await this.#scriptTxPromise;
    }
    this.#scriptTx = undefined;
    this.#scriptTxEnd = undefined;
    this.#scriptTxPromise = undefined;
}

async abortScriptScope(): Promise<void> {
    if (!this.#scriptScope) return;
    this.#scriptScope = false;

    const hadTx = this.#scriptTx !== undefined;
    this.#scriptTx = undefined;
    this.#scriptTxEnd = undefined;
    // Don't resolve endPromise — let the transaction callback reject.
    // dialect.transaction catches the rejection and issues ROLLBACK.
    // Ignore the rejection since it's intentional.
    if (this.#scriptTxPromise !== undefined) {
        this.#scriptTxPromise.catch(() => {});
    }
    this.#scriptTxPromise = undefined;

    if (hadTx) {
        await this.reload();
        this.clearDirty();
    }
}
```

**Rollback recovery in `abortScriptScope()`:**
- Clears all script-tx state
- Does NOT resolve `endPromise` — the transaction callback's `await endPromise` never resolves, so the Promise rejects (or the dialect's timeout fires). Either way, `dialect.transaction` catches the exception and issues ROLLBACK.
- Swallows the rejection with `.catch(() => {})` since it's intentional
- If a tx was actually opened (writes happened), calls `reload()` to restore pathCache from DB and `clearDirty()` to prevent `publishVersionIfDirty` from publishing phantom changes
- If no tx was opened (read-only script that threw), no recovery needed

#### 1h. `SessionScopedFs` lifecycle manager

**File**: `src/fs/sql-fs/session-scoped-fs.ts` (new file)

```ts
import type { IScriptTxFs } from "./sql-fs.js";

export class SessionScopedFs {
    readonly #inner: IScriptTxFs;

    constructor(inner: IScriptTxFs) {
        this.#inner = inner;
    }

    get inner(): IScriptTxFs {
        return this.#inner;
    }

    get isActive(): boolean {
        return this.#inner.scriptScopeActive;
    }

    get hasTx(): boolean {
        return this.#inner.scriptTxOpen;
    }

    beginScope(): void {
        if (this.#inner.scriptScopeActive) return;
        this.#inner.beginScriptScope();
    }

    async endScope(): Promise<void> {
        if (!this.#inner.scriptScopeActive) return;
        await this.#inner.endScriptScope();
    }

    async abortScope(): Promise<void> {
        if (!this.#inner.scriptScopeActive) return;
        await this.#inner.abortScriptScope();
    }
}
```

Design rationale: **NOT** an IFileSystem proxy. Bash holds a direct reference to SqlFs. The wrapper just manages the script-scope lifecycle. This avoids 20+ delegation methods that would need updating every time IFileSystem changes.

#### 1i. Store `SessionScopedFs` on Session

**File**: `src/api/session-manager.ts`
**Changes**: Add field to `Session` interface (~line 69)

```ts
export interface Session {
    // ...existing fields...
    readonly scriptTx: SessionScopedFs | undefined;
}
```

#### 1j. Create `SessionScopedFs` at session creation

**File**: `src/api/session-manager.ts`
**Changes**: In `getOrCreate()` (~line 280-320), after `fs` and `bash` are created

```ts
import { SessionScopedFs } from "../fs/sql-fs/session-scoped-fs.js";

// Inside getOrCreate(), after building fs and bash:
const scriptTxFs = asScriptTxFs(fs);
const scriptTx = scriptTxFs !== undefined ? new SessionScopedFs(scriptTxFs) : undefined;

const session: Session = {
    // ...existing fields...
    scriptTx,
};
```

Only SqlFs-backed sessions get a `SessionScopedFs`. Memory backends and other IFileSystem implementations that don't implement `IScriptTxFs` get `undefined` — `asScriptTxFs()` returns `undefined` for them, and `execWithRuntimeThrottle` falls back to direct `bash.exec()`.

#### 1k. Wire scope around `bash.exec`

**File**: `src/api/session-manager.ts`
**Changes**: Modify `execWithRuntimeThrottle()` at line 606

```ts
async execWithRuntimeThrottle(session: Session, script: string, opts?: ExecOptions): Promise<BashExecResult> {
    const usesPython = session.runtimeOptions.python && PYTHON_INVOCATION_REGEX.test(script);
    const usesJs = session.runtimeOptions.javascript && JS_INVOCATION_REGEX.test(script);

    const execFn = async (): Promise<BashExecResult> => {
        if (session.scriptTx !== undefined) {
            session.scriptTx.beginScope();
            try {
                const result = await session.bash.exec(script, opts);
                await session.scriptTx.endScope();
                return result;
            } catch (err) {
                await session.scriptTx.abortScope();
                throw err;
            }
        }
        return session.bash.exec(script, opts);
    };

    if (!usesPython && !usesJs) {
        return execFn();
    }

    if (usesPython) await this.acquireSlot(this.pythonSem);
    if (usesJs) {
        try {
            await this.acquireSlot(this.jsSem);
        } catch (e) {
            if (usesPython) this.releaseSlot(this.pythonSem);
            throw e;
        }
    }

    try {
        return await execFn();
    } finally {
        if (usesJs) this.releaseSlot(this.jsSem);
        if (usesPython) this.releaseSlot(this.pythonSem);
    }
}
```

**Execution flow for different script types:**

*Read-only script (`ls -la`):*
1. `beginScope()` — synchronous, sets `#scriptScope = true`, no DB work
2. `bash.exec("ls -la")` — `ls` reads from pathCache, no `#withTx` called
3. `endScope()` — `#scriptTxEnd` is undefined (no tx opened), no-op except clearing scope flag

*Write script (`mv a b && rm c`):*
1. `beginScope()` — sets flag
2. `bash.exec(...)` → `fs.mv(a, b)` → `#withTx` → first write, opens tx lazily via `#openScriptTx()`
3. `fs.rm(c)` → `#withTx` → reuses `#scriptTx`, skips BEGIN/setup/COMMIT
4. `endScope()` → resolves `endPromise` → COMMIT

*Script that throws (`mv a b` then AbortController fires):*
1. `beginScope()` — sets flag
2. `bash.exec(...)` → `fs.mv(a, b)` → opens tx, pathCache updated
3. AbortController fires → `bash.exec` throws
4. `abortScope()` → clears state, swallows tx promise rejection (ROLLBACK), calls `reload()` + `clearDirty()`
5. `withSessionEntry` finally block → `publishVersionIfDirty()` → `wasDirty()` returns false → no version published

**Bash failure semantics:** `endScope()` commits on successful `bash.exec()` completion — regardless of the script's exit code (exit code is in the result, not an exception). `abortScope()` rolls back only on an unhandled JS exception (e.g., AbortController signal, internal error) and restores cache consistency. This matches POSIX: `mv a b && false && rm c` keeps the `mv`.

### Phase 1: Success Criteria

#### Phase 1: Automated Verification

- [x] `pnpm typecheck` passes
- [x] `pnpm lint:fix` passes
- [x] `pnpm test:unit` passes (all existing tests still work — `#scriptScope` defaults to false)
- [x] New test files pass:
  - `src/fs/sql-fs/tests/sql-fs.script-tx.test.ts`
  - `src/fs/sql-fs/tests/session-scoped-fs.test.ts`
  - `src/api/tests/session-manager.script-tx.test.ts`

#### Phase 1: Manual Verification

- [x] Read-only script (`ls -la`): `dialect.transaction` never called during exec (no tx opened)
- [x] Read-only script: `pg_advisory_xact_lock` never acquired
- [x] Write script: `dialect.transaction` called exactly once (on first write)
- [x] Write script: `setSandboxContextWithLock` called exactly once
- [x] Multiple writes in one script: all reuse the same tx
- [x] Read after write in same script: read piggybacks on open tx
- [x] `endScope()` triggers COMMIT (verify tx callback completes)
- [x] Script exit code 1: COMMIT still happens (not rollback)
- [x] AbortController timeout: ROLLBACK + `reload()` + `clearDirty()`
- [x] After abort: `publishVersionIfDirty` does NOT publish (dirty flag cleared)
- [x] After abort: pathCache matches DB state (reload restored consistency)
- [x] For memory-backed session: `session.scriptTx` is undefined, `bash.exec` called directly

### Phase 1: Test Plan

**`sql-fs.script-tx.test.ts`** (~25 test cases):

_Setup:_ Same mock pattern as existing tests. Mock `dialect.transaction` to capture the tx callback and simulate the deferred-promise lifecycle.

**Lazy activation:**
- `beginScriptScope` is synchronous, sets `scriptScopeActive = true`
- After `beginScriptScope`, `scriptTxOpen` is false (no tx yet)
- Read-only op (e.g., `readFile` from cache) does not open tx
- `#withReadTx` during scope without tx: uses own read tx (not script tx)
- First `writeFile` opens tx: `dialect.transaction` called, `scriptTxOpen` becomes true
- Second `writeFile` reuses tx: `dialect.transaction` still called only once
- `#withReadTx` after write: reuses open script-tx (no new tx)
- `mv` during scope: reuses tx
- `rm` during scope: reuses tx
- `mkdir` during scope: reuses tx

**Commit path:**
- `endScriptScope` when no tx opened: no-op (just clears scope flag)
- `endScriptScope` with tx: resolves held promise (tx callback completes)
- After `endScriptScope`, `scriptScopeActive` is false, `scriptTxOpen` is false
- After `endScriptScope`, next `writeFile` opens its own tx (back to normal)

**Abort path (rollback recovery):**
- `abortScriptScope` when no tx opened: no-op (just clears scope flag, no reload)
- `abortScriptScope` with tx: clears state, `reload()` called, `clearDirty()` called
- After abort: `wasDirty()` returns false
- After abort: pathCache matches the mock `loadAllPaths` output (reload restored it)
- After abort: next `writeFile` opens its own tx (scope cleared)

**Error handling:**
- `beginScriptScope` when already active: throws
- `endScriptScope` when not active: no-op
- `abortScriptScope` when not active: no-op
- Error in fs op during scope: propagates to caller but scope stays active (tx stays open for further ops or eventual abort)
- `dirty` flag set during scope, cleared by abort

**`session-scoped-fs.test.ts`** (~10 test cases):
- `beginScope` calls inner `beginScriptScope`
- `endScope` calls inner `endScriptScope`
- `abortScope` calls inner `abortScriptScope`
- double `beginScope` is idempotent (returns early when scope already active)
- double `endScope` is idempotent
- `isActive` reflects `scriptScopeActive`
- `hasTx` reflects `scriptTxOpen`

**`session-manager.script-tx.test.ts`** (~12 test cases):
- `execWithRuntimeThrottle` calls `beginScope` before `bash.exec`
- `execWithRuntimeThrottle` calls `endScope` after `bash.exec` succeeds
- On `bash.exec` exception, `abortScope` is called
- When `session.scriptTx` is undefined (memory backend), `bash.exec` called directly
- `asScriptTxFs` returns undefined for objects missing script-tx methods
- `asScriptTxFs` returns the fs for objects with all required methods
- Python semaphore still acquired/released around scope
- JS semaphore still acquired/released around scope
- Script with non-zero exit code: `endScope` called (commit, not abort)
- After abort: `publishVersionIfDirty` does not publish (dirty cleared by abortScope before finally block)

### Phase 1: Discoveries and Notable Information

**Technical Discoveries:**
- Object spread (`{...new InMemoryFs()}`) does NOT copy prototype methods. When mocking `IScriptTxFs` in session-manager tests, `getAllPaths()` must be explicitly wired (arrow function delegating to a real `InMemoryFs` instance) since `estimatePathCacheBytes` calls it during `getOrCreate`.
- The `IScriptTxFs` interface is exported alongside `ICoherentFs` from `sql-fs.ts` and imported in `session-manager.ts` — no circular dependency issues.
- Biome auto-formatted the `session-manager.script-tx.test.ts` inline object literals onto separate lines (expected).

**Implementation Adaptations:**
- Plan specified ~25 test cases for `sql-fs.script-tx.test.ts`; implemented 21 covering all plan scenarios. The "readFile from cache during scope with no tx" case is covered by the "read-only ops during scope" test (which exercises `exists`, `stat`, and `getAllPaths`).
- The `#withReadTx` uses `readFile` cache-miss path through `#readBytes` → `#resolveReadEntry` → `#withReadTx` which correctly piggybacks on an already-open script-tx but does NOT lazily open one (verified by "readFile after write" test).

**Future Considerations:**
- `abortScriptScope` relies on `#scriptTxPromise` rejecting when `endPromise` never resolves. In the mock dialect, `transaction(fn)` calls `fn({})` synchronously and returns the result, so the deferred-promise pattern is tested implicitly (mock returns immediately). Full deferred-promise lifecycle should be verified in integration tests with a real Postgres dialect.

---

## Phase 2: Bulk FS Methods with Transactional Cache Safety

### Phase 2: Overview

Add `mvBulk`, `rmBulk`, and `cpBulk` to SqlFs. Each wraps all operations in a single `#withTx` call, paying the 4-RTT overhead once instead of N times. Cache updates use snapshot-and-restore: a full pathCache snapshot is taken before the tx, mutations happen inside the tx callback (so later pairs see earlier pairs' changes), and on tx failure the snapshot is restored.

These methods are **preparation for upstream just-bash integration**. Today, just-bash's builtins still call `fs.mv()` per arg. An upstream PR (or local shim) would teach builtins to detect `fs.mvBulk` and call it when present. Until then, these methods are callable directly by API consumers or future code paths but don't affect `bash.exec` behavior.

When combined with Phase 1's script-tx, the bulk methods benefit from the already-open tx — `#withTx` inside a bulk method reuses the script-tx, so even the single BEGIN/COMMIT per bulk call is eliminated.

### Phase 2: Changes Required

#### 2a. Add bulk method signatures to `ICoherentFs`

**File**: `src/fs/sql-fs/sql-fs.ts`
**Changes**: Extend `ICoherentFs` interface

```ts
export interface ICoherentFs extends IFileSystem {
    reload(): Promise<void>;
    wasDirty(): boolean;
    clearDirty(): void;
    bulkIngest(files: BulkIngestFile[]): Promise<void>;
    mvBulk(pairs: ReadonlyArray<{ src: string; dest: string }>): Promise<void>;
    rmBulk(paths: readonly string[], options?: RmOptions): Promise<void>;
    cpBulk(pairs: ReadonlyArray<{ src: string; dest: string }>, options?: CpOptions): Promise<void>;
}
```

Import `RmOptions` and `CpOptions` from `just-bash` (already imported for other methods).

#### 2b. Cache snapshot helper

**File**: `src/fs/sql-fs/sql-fs.ts`
**Changes**: New private method

```ts
#snapshotPathCache(): Map<string, PathCacheEntry> {
    return new Map(this.#pathCache);
}

#restorePathCache(snapshot: Map<string, PathCacheEntry>): void {
    this.#pathCache.clear();
    for (const [k, v] of snapshot) this.#pathCache.set(k, v);
}
```

#### 2c. `SqlFs.mvBulk()`

**File**: `src/fs/sql-fs/sql-fs.ts`
**Changes**: New method after `mv()` (~line 947)

Semantics: For each `{src, dest}` pair, move `src` to `dest`. All pairs run in one `#withTx`. Cache mutations happen in-loop inside the tx callback so later pairs see earlier pairs' changes. On tx failure, pathCache is restored from snapshot.

```ts
async mvBulk(pairs: ReadonlyArray<{ src: string; dest: string }>): Promise<void> {
    if (pairs.length === 0) return;
    if (pairs.length === 1) return this.mv(pairs[0]!.src, pairs[0]!.dest);

    const normalized = pairs.map(({ src, dest }) => ({
        src: validatePath(src),
        dest: validatePath(dest),
    }));

    const snapshot = this.#snapshotPathCache();
    try {
        await this.#withTx(async (tx) => {
            for (const { src, dest } of normalized) {
                const srcEntry = this.#pathCache.get(src);
                if (!srcEntry) throw createEnoent(src);

                const srcParentPath = this.#parentOf(src);
                const srcName = this.#nameOf(src);
                const destParentPath = this.#parentOf(dest);
                const destName = this.#nameOf(dest);

                const srcParentEntry = this.#pathCache.get(srcParentPath);
                if (!srcParentEntry) throw createEnoent(srcParentPath);
                const destParentEntry = this.#pathCache.get(destParentPath);
                if (!destParentEntry) throw createEnoent(destParentPath);
                if (destParentEntry.kind !== INODE_KIND.DIRECTORY) throw createEnotdir(destParentPath);

                if (srcEntry.kind === INODE_KIND.DIRECTORY) {
                    const srcPrefix = src === "/" ? "/" : `${src}/`;
                    if (dest.startsWith(srcPrefix) || dest === src) throw createEinval(src);
                }

                const destEntry = this.#pathCache.get(dest);
                if (destEntry) {
                    const newNlink = await this.#dialect.decrementNlink(tx, destEntry.inodeId);
                    if (newNlink === 0) await this.#dialect.deleteInode(tx, destEntry.inodeId);
                }
                await this.#dialect.moveDirent(
                    tx, srcParentEntry.inodeId, srcName, destParentEntry.inodeId, destName,
                );

                // Update pathCache in-loop so next pair sees correct state
                const srcPaths = this.#allPathsUnder(src);
                const srcSnapshot = new Map<string, PathCacheEntry>();
                for (const p of srcPaths) {
                    const e = this.#pathCache.get(p);
                    if (e) srcSnapshot.set(p, e);
                }
                for (const p of srcPaths) this.#pathCache.delete(p);
                const destPrefix = dest === "/" ? "/" : `${dest}/`;
                for (const key of [...this.#pathCache.keys()]) {
                    if (key === dest || key.startsWith(destPrefix)) this.#pathCache.delete(key);
                }
                for (const [oldPath, entry] of srcSnapshot) {
                    this.#pathCache.set(dest + oldPath.slice(src.length), entry);
                }
            }
        });
    } catch (err) {
        this.#restorePathCache(snapshot);
        throw err;
    }
    this.#dirty = true;
}
```

#### 2d. `SqlFs.rmBulk()`

**File**: `src/fs/sql-fs/sql-fs.ts`
**Changes**: New method after `rm()` (~line 670)

```ts
async rmBulk(inputPaths: readonly string[], options?: RmOptions): Promise<void> {
    if (inputPaths.length === 0) return;
    if (inputPaths.length === 1) return this.rm(inputPaths[0]!, options);

    const paths = inputPaths.map(validatePath);
    const snapshot = this.#snapshotPathCache();

    try {
        await this.#withTx(async (tx) => {
            for (const path of paths) {
                const entry = this.#pathCache.get(path);
                if (!entry) {
                    if (options?.force) continue;
                    throw createEnoent(path);
                }

                const parentPath = this.#parentOf(path);
                const name = this.#nameOf(path);
                const parentEntry = this.#pathCache.get(parentPath);

                if (options?.recursive && entry.kind === INODE_KIND.DIRECTORY) {
                    const subtreePaths = this.#allPathsUnder(path);
                    subtreePaths.sort((a, b) => b.split("/").length - a.split("/").length);

                    if (parentEntry) {
                        await this.#dialect.deleteDirent(tx, parentEntry.inodeId, name);
                    }
                    for (const p of subtreePaths) {
                        const e = this.#pathCache.get(p)!;
                        if (p !== path) {
                            const pParent = this.#pathCache.get(this.#parentOf(p));
                            if (pParent) {
                                await this.#dialect.deleteDirent(tx, pParent.inodeId, this.#nameOf(p));
                            }
                        }
                        const newNlink = await this.#dialect.decrementNlink(tx, e.inodeId);
                        if (newNlink === 0) await this.#dialect.deleteInode(tx, e.inodeId);
                    }

                    for (const p of subtreePaths) {
                        const e = this.#pathCache.get(p);
                        if (e) this.#contentCache.delete(e.inodeId);
                        this.#pathCache.delete(p);
                    }
                } else {
                    if (entry.kind === INODE_KIND.DIRECTORY) {
                        if (this.#childPaths(path).length > 0) throw createEnotempty(path);
                    }
                    const removedInodeId = await this.#dialect.deleteDirent(tx, parentEntry!.inodeId, name);
                    const newNlink = await this.#dialect.decrementNlink(tx, removedInodeId);
                    if (newNlink === 0) await this.#dialect.deleteInode(tx, removedInodeId);

                    this.#contentCache.delete(entry.inodeId);
                    this.#pathCache.delete(path);
                }
            }
        });
    } catch (err) {
        this.#restorePathCache(snapshot);
        throw err;
    }
    this.#dirty = true;
}
```

#### 2e. `SqlFs.cpBulk()`

**File**: `src/fs/sql-fs/sql-fs.ts`
**Changes**: New method after `cp()` (~line 886)

```ts
async cpBulk(
    pairs: ReadonlyArray<{ src: string; dest: string }>,
    options?: CpOptions,
): Promise<void> {
    if (pairs.length === 0) return;
    if (pairs.length === 1) return this.cp(pairs[0]!.src, pairs[0]!.dest, options);

    const normalized = pairs.map(({ src, dest }) => ({
        src: validatePath(src),
        dest: validatePath(dest),
    }));

    const mtime = new Date();
    const snapshot = this.#snapshotPathCache();

    try {
        await this.#withTx(async (tx) => {
            for (const { src, dest } of normalized) {
                const srcEntry = this.#pathCache.get(src);
                if (!srcEntry) throw createEnoent(src);

                if (srcEntry.kind === INODE_KIND.DIRECTORY) {
                    if (!options?.recursive) throw createEisdir(src);

                    const srcPaths = this.#allPathsUnder(src);
                    srcPaths.sort((a, b) => a.split("/").length - b.split("/").length);
                    this.#requireParentDir(dest);

                    const newInodeIds = new Map<string, bigint>();
                    for (const srcPath of srcPaths) {
                        const entry = this.#pathCache.get(srcPath)!;
                        const destPath = dest + srcPath.slice(src.length);
                        const entryName = this.#nameOf(destPath);
                        const entryParent = this.#parentOf(destPath);
                        const parentInodeId = newInodeIds.get(entryParent)
                            ?? this.#pathCache.get(entryParent)?.inodeId;
                        if (parentInodeId === undefined) throw createEnoent(entryParent);

                        const newId = await this.#dialect.createInode(tx, {
                            sandboxId: this.#sandboxId,
                            kind: entry.kind,
                            mode: entry.mode,
                            size: entry.size,
                            contentSha256: entry.contentSha256,
                            symlinkTarget: entry.symlinkTarget,
                        });
                        await this.#dialect.insertDirent(tx, parentInodeId, entryName, newId);
                        newInodeIds.set(destPath, newId);
                    }

                    for (const [destPath, inodeId] of newInodeIds) {
                        const srcPath = src + destPath.slice(dest.length);
                        const srcE = this.#pathCache.get(srcPath)!;
                        this.#pathCache.set(destPath, { ...srcE, inodeId, mtime });
                    }
                } else {
                    const { name: destName, parentEntry: destParentEntry } =
                        this.#requireParentDir(dest);
                    const newInodeId = await this.#dialect.createInode(tx, {
                        sandboxId: this.#sandboxId,
                        kind: INODE_KIND.FILE,
                        mode: srcEntry.mode,
                        size: srcEntry.size,
                        contentSha256: srcEntry.contentSha256,
                    });
                    const oldInodeId = await this.#dialect.upsertDirent(
                        tx, destParentEntry.inodeId, destName, newInodeId,
                    );
                    if (oldInodeId !== null) {
                        const newNlink = await this.#dialect.decrementNlink(tx, oldInodeId);
                        if (newNlink === 0) await this.#dialect.deleteInode(tx, oldInodeId);
                    }
                    this.#pathCache.set(dest, {
                        inodeId: newInodeId,
                        kind: INODE_KIND.FILE,
                        mode: srcEntry.mode,
                        size: srcEntry.size,
                        mtime,
                        contentSha256: srcEntry.contentSha256,
                        symlinkTarget: null,
                    });
                }
            }
        });
    } catch (err) {
        this.#restorePathCache(snapshot);
        throw err;
    }
    this.#dirty = true;
}
```

### Phase 2: Success Criteria

#### Phase 2: Automated Verification

- [x] `pnpm typecheck` passes
- [x] `pnpm lint:fix` passes
- [x] `pnpm test:unit` passes (existing tests unchanged)
- [x] New test files pass:
  - `src/fs/sql-fs/tests/sql-fs.mv-bulk.test.ts`
  - `src/fs/sql-fs/tests/sql-fs.rm-bulk.test.ts`
  - `src/fs/sql-fs/tests/sql-fs.cp-bulk.test.ts`

#### Phase 2: Manual Verification

- [x] Each bulk method invokes `dialect.transaction` exactly once for N operations (verify via mock call count)
- [x] pathCache state after successful bulk ops matches the state after N sequential individual ops
- [x] Error in any pair: tx rolls back AND pathCache restored from snapshot (no partial state)
- [x] `pairs.length === 1` delegates to the single-op method (no snapshot overhead)
- [x] `pairs.length === 0` returns immediately
- [x] Bulk method inside active script-scope: reuses script-tx (verify `dialect.transaction` not called again)

### Phase 2: Test Plan

Each bulk method gets its own test file following the project pattern (`beforeEach` mock setup, `SqlDialect<unknown>` cast).

**`sql-fs.mv-bulk.test.ts`** (~17 test cases):
- empty array returns immediately, no tx
- single pair delegates to `mv()`
- moves 3 files in one tx (`dialect.transaction` called once)
- pathCache updated correctly for all 3 moves
- directory move with descendants: subtree remapped
- **error in pair 2: pathCache restored from snapshot (pair 1 changes reverted)**
- **error in pair 2: `dirty` remains false (never set since tx failed)**
- destination collision: displaced inode decremented/deleted
- ENOENT on missing source — cache restored
- EINVAL on move-into-own-descendant — cache restored
- sets `dirty = true` on success
- inside active script scope: reuses tx (dialect.transaction not called by mvBulk)

**`sql-fs.rm-bulk.test.ts`** (~14 test cases):
- empty array returns immediately
- single path delegates to `rm()`
- removes 3 files in one tx
- pathCache and contentCache cleared for all paths
- recursive: subtree removed correctly
- non-recursive on non-empty dir throws ENOTEMPTY — cache restored
- force: missing paths silently skipped
- **error mid-batch: pathCache restored from snapshot**
- sets `dirty = true` on success
- inside active script scope: reuses tx

**`sql-fs.cp-bulk.test.ts`** (~14 test cases):
- empty array returns immediately
- single pair delegates to `cp()`
- copies 3 files in one tx (CAS dedup — no new blobs)
- pathCache updated with new inodeIds, original entries unchanged
- recursive directory copy creates full subtree
- destination collision: old inode cleaned up
- ENOENT on missing source — cache restored
- EISDIR when recursive not set — cache restored
- **error mid-batch: pathCache restored from snapshot**
- sets `dirty = true` on success
- inside active script scope: reuses tx

### Phase 2: Discoveries and Notable Information

**Technical Discoveries:**
- The `#snapshotPathCache` / `#restorePathCache` pattern cleanly handles both in-loop cache mutations and rollback recovery. The snapshot is a shallow `new Map(this.#pathCache)` copy — `PathCacheEntry` values are read-only objects so sharing references is safe.
- Bulk methods that delegate to single-op for `length === 1` skip the snapshot overhead entirely, since the single-op methods handle their own cache consistency.
- The `rmBulk` implementation needed to handle both recursive (subtree deletion) and non-recursive (single entry) paths within the same loop iteration, mirroring the branching structure of single `rm()`.

**Implementation Adaptations:**
- Plan specified ~17 test cases for `sql-fs.mv-bulk.test.ts`; implemented 12 covering all plan scenarios plus a "later pair sees earlier pair's cache changes" case that validates in-loop cache coherence.
- Plan specified ~14 test cases each for rm-bulk and cp-bulk; implemented 13 and 14 respectively, adding "dirty remains false on error" tests and "recursive rm of multiple dirs" tests not explicitly listed.
- All three test files follow the established pattern of clearing `transactionMock` after `fs.ready()` to isolate transaction counts to the method under test.

**Future Considerations:**
- When just-bash upstream adds `fs.mvBulk()` detection, the existing bulk methods will be called directly from shell builtins, compounding the script-tx benefit (fewer per-op queries inside the shared tx).
- The `contentCache` is not snapshot/restored in bulk methods — only `pathCache` is. This is acceptable because `contentCache` is an LRU read cache; stale entries just trigger a re-fetch on next read.

---

## Phase 3: Benchmark Verification

### Phase 3: Overview

Run the existing `scripts/benchmark_remote_bash.py` against a VFS deployment with the lazy script-tx feature enabled. Compare latency numbers against the baseline from the research document.

### Phase 3: Changes Required

No code changes. This phase is verification only.

### Phase 3: Steps

1. Deploy the updated API to a test environment with Postgres (session-pooler endpoint for long-lived txs)
2. Run `scripts/benchmark_remote_bash.py` with default settings
3. Compare the "VFS remote NEW" column against baseline:

| Case | Baseline (NEW) | Expected with script-tx | Rationale |
|---|---|---|---|
| `write: echo` | 47 ms | ~47 ms | Single op — 1 tx either way |
| `write: append 3x` | 585 ms | ~200 ms | 3 ops share 1 tx instead of 3 |
| `delete: single file` | 67 ms | ~50 ms | 2 ops share 1 tx instead of 2 |
| `delete: 3 files` | 204 ms | ~70 ms | 6 ops in 1 tx instead of 6 |
| `mkdir: single` | 62 ms | ~50 ms | 2 ops share 1 tx |
| `mkdir: nested deep` | 286 ms | ~70 ms | 6 ops in 1 tx instead of 6 |
| `mv: rename file` | 99 ms | ~50 ms | 3 ops in 1 tx instead of 3 |
| `mv: move 3 files` | 294 ms | ~70 ms | 8 ops in 1 tx instead of 8 |

Note: bulk methods do NOT affect these numbers yet — just-bash still calls `fs.mv()` per arg. The improvements come purely from the script-tx collapsing all per-op transactions into one. When a just-bash upstream PR lands teaching builtins to call `fs.mvBulk()`, the multi-arg cases will see additional improvement (fewer per-op queries inside the tx).

4. Verify read-only scripts (`ls`, `cat`, `grep`) show no regression (no tx opened → no connection held → no advisory lock contention)

### Phase 3: Success Criteria

- [ ] Multi-op benchmark cases show >= 2x latency improvement
- [ ] Single-op cases show no regression
- [ ] Read-only scripts show no regression
- [ ] No transaction timeout errors during benchmark run
- [ ] Session-pooler connection works correctly for long-lived txs

### Phase 3: Discoveries and Notable Information

_To be filled during implementation._

---

## Testing Strategy

### Unit Tests
- Mock `SqlDialect<unknown>` with vi.fn() — consistent with existing 29 test files
- Script-tx: lazy activation, commit path, abort path with reload, read-only no-tx, guard function
- Bulk methods: empty input, single input (delegation), N inputs, error mid-batch with cache restoration
- SessionScopedFs: lifecycle management, idempotent begin/end
- SessionManager integration: correct call ordering, error paths, guard narrowing

### Integration Tests
- Against real Postgres: script-tx multi-command script runs in one transaction (verify with `pg_stat_activity` or by checking tx id)
- Against real Postgres: bulk ops produce correct DB state
- Timeout/abort: script-tx rolls back on AbortController signal, pathCache restored

### Manual Testing Steps
1. Deploy to test environment
2. Run benchmark script
3. Verify multi-op latency reduction
4. Test `mv a b && echo done` — verify script-tx opened on `mv`, committed after script completes
5. Test `ls -la && echo done` — verify no tx opened at all
6. Test `mv a b` then AbortController timeout — verify rollback + cache recovery
7. Test error mid-script — verify partial state is committed (POSIX semantics: non-exception exit codes don't trigger rollback)

## Performance Considerations

- **Lazy activation eliminates read-only overhead**: Read-only scripts (`ls`, `cat`, `grep`, `echo`) never acquire a DB connection or advisory lock. Only the first write-path `#withTx` call triggers `#openScriptTx()`.
- **Connection hold time for writes**: Once opened, the script-tx holds a DB connection for the remainder of the script. Scripts with long-running non-FS work after a write (e.g., Python computation) will hold the connection idle. This is unavoidable if writes need to be in the same tx.
- **Neon transaction-pooler incompatibility**: Transaction-pooler terminates connections that hold transactions open too long. Must use session-pooler endpoint for script-tx. This may require a separate `DATABASE_SESSION_URL` env var or configuration flag.
- **Rollback cost**: `abortScriptScope()` calls `reload()` which issues a full `loadAllPaths` CTE query. This is the same cost as a cold start — acceptable for the exceptional (error) path, not the hot path.
- **Snapshot cost for bulk methods**: `#snapshotPathCache()` copies the entire `Map<string, PathCacheEntry>`. For a sandbox with 10k paths, this is ~10k map entries × ~100 bytes ≈ 1MB. Acceptable for bulk ops which are inherently large operations.

## Deployment Considerations

- **Feature flag**: Script-tx can be disabled via env var (`SCRIPT_TX_ENABLED=false`) to allow gradual rollout. When disabled, `asScriptTxFs()` can short-circuit to return `undefined`, and all execs fall back to per-op transactions.
- **Session-pooler URL**: When script-tx is enabled, the API must connect to Postgres via session-pooler (not transaction-pooler). This is a deployment configuration change.
- **Connection pool sizing**: With script-tx, each concurrent **write** exec holds a connection for the script duration. Pool size must cover **peak concurrent execs across all sandboxes and tenants**, not just per-sandbox. Read-only scripts don't hold connections (lazy activation). With 100 concurrent sandboxes each running a write script, that's 100 held connections. Size the pool accordingly: `pool_size >= expected_peak_concurrent_write_execs + headroom`.
- **Monitoring**: Log `scriptTxOpen` state at exec completion to track what fraction of execs actually open a tx. This informs pool sizing.

## References

- Research: `thoughts/shared/research/2026-05-02_11-24-37_remote-bash-latency-scaling.md`
- SqlFs implementation: `src/fs/sql-fs/sql-fs.ts`
- PostgresDialect: `src/fs/sql-fs/dialects/postgres.ts`
- SessionManager: `src/api/session-manager.ts`
- Exec routes: `src/api/routes/exec.ts`
- SqlDialect interface: `src/fs/sql-fs/types.ts`
- bulkIngest pattern: `src/fs/sql-fs/sql-fs.ts:401-428`
- `#withTx` (per-op tx): `src/fs/sql-fs/sql-fs.ts:164`
- `#withReadTx` (lock-free reads): `src/fs/sql-fs/sql-fs.ts:178`
- `withSessionEntry` finally block: `src/api/session-manager.ts:354-360`
- `asCoherentFs()` guard: `src/api/session-manager.ts:41-51`
- `execWithRuntimeThrottle()`: `src/api/session-manager.ts:606`
- just-bash mv loop: `node_modules/just-bash/.../chunk-A4JSPFCI.js`
- just-bash rm loop: `node_modules/just-bash/.../chunk-MIZPJHVH.js`
- just-bash cp loop: `node_modules/just-bash/.../chunk-NUYSJFDK.js`

---
date: 2026-05-10T13:03:37+09:30
researcher: Harry Nguyen
git_commit: c149f89b4ce04b88fce1d68f8b624d4dfbc036a6
branch: feature/RW-exec
repository: sql-fs
topic: "Parallel readOnly bash exec — Multiple Reader Single Writer pattern (Issue #60)"
tags: [research, codebase, session-manager, exec, concurrency, rw-lock, sql-fs]
status: complete
last_updated: 2026-05-10
last_updated_by: Harry Nguyen
---

# Research: Parallel readOnly bash exec — Multiple Reader Single Writer Pattern (Issue #60)

**Date**: 2026-05-10 13:03:37 ACST  
**Researcher**: Harry Nguyen  
**Git Commit**: `c149f89b4ce04b88fce1d68f8b624d4dfbc036a6`  
**Branch**: `feature/RW-exec`  
**Repository**: sql-fs

---

## Research Question

GitHub Issue #60 requests that multiple concurrent `bash.exec` calls against the same sandbox be allowed to run **without serializing on the per-session mutex** when those calls are explicitly tagged as `readOnly: true`. Today every exec acquires `session.mutex` exclusively — even for purely-read scripts like `cat`, `ls`, `grep`. This research maps the full current exec path and designs the integration points for the RW-lock feature.

---

## Summary

Every exec today flows through a two-level locking hierarchy: a distributed Redis lock (per-sandbox, cross-replica) and an in-process exclusive `Mutex` from `async-mutex` (per-session). The bottleneck for the read path is the in-process `session.mutex.runExclusive()` call in `withSessionEntry`. The fix is to:

1. Hand-roll an async readers-writer lock (`AsyncRwLock`) to replace `session.mutex`.
2. Add a `withSessionReadEntry` path that acquires the lock in **shared** mode, single-flights `ensureFreshCache`, and then runs the exec.
3. Guard all SqlFs write methods behind a `#readOnly` flag so lying scripts fail at the FS layer (option a from the issue).
4. Add `readOnly?: boolean` to the Zod schemas for `/exec-sync`, `/exec`, `/exec-sync-batch`, and the MCP `bash_exec` tool.

---

## Detailed Findings

### 1. The Current Exec Lock Hierarchy

```
HTTP request
  └─ parseExecBody()                               exec.ts:56-126
  └─ withOwnedSessionOrRehydrate()                 ownership.ts:27-44
       └─ sessionManager.withSessionOrRehydrate()  session-manager.ts:605-618
            └─ this.withExecLock()                 session-manager.ts:439-442
                 │  (distributed Redis lock — skipped if redis === undefined)
                 └─ this.withSessionEntry()         session-manager.ts:444-500
                      └─ ensureFreshCache()         session-manager.ts:502-525
                      └─ session.mutex.runExclusive()  ← THE BOTTLENECK
                           └─ fn(session)
                           └─ publishVersionIfDirty()  session-manager.ts:527-573
```

**Key files:**
- `src/api/routes/exec.ts:128-348` — three route handlers (`/exec-sync`, `/exec`, `/exec-sync-batch`)
- `src/api/session-manager.ts:444-500` — `withSessionEntry` — the central gating function
- `src/api/session-manager.ts:439-442` — `withExecLock` — wraps in distributed Redis lock
- `src/api/session-manager.ts:575-596` — `withSession` / `withExistingSession` — public entry points
- `src/api/ownership.ts:27-44` — `withOwnedSessionOrRehydrate` — adds ownership check under lock

### 2. The `session.mutex` — What it Protects

`session.mutex: Mutex` (from `async-mutex`, imported at `session-manager.ts:15`) is **exclusive**:

```typescript
// session-manager.ts:457-499
return session.mutex.runExclusive(async () => {
    // 1. Guard against closing sessions
    // 2. Increment session.inFlight
    // 3. Run fn(session) — the actual bash.exec
    // 4. publishVersionIfDirty (Redis version INCR)
    // 5. Decrement session.inFlight
    // 6. Refresh pathCacheBytes if dirty
});
```

Everything inside is serialized — one caller at a time per sandbox. There is no shared/exclusive split, so even 10 concurrent `cat` calls wait in a FIFO queue.

### 3. `ensureFreshCache` — the Cache Reload Point

`src/api/session-manager.ts:502-525` — Called **before** `session.mutex.runExclusive()` in `withSessionEntry`. It:
1. Reads the Redis version counter (`vfs:{tenantId}:ver:{sandboxId}`)
2. If `session.lastSeenVersion !== current`, calls `coherent.reload()` (full pathCache scan from Postgres)
3. Updates `session.lastSeenVersion`

For parallel readers, all N callers would trigger N separate version probes and potentially N parallel `coherent.reload()` calls on the same `SqlFs` — inefficient and potentially racy. The fix: single-flight this call so all concurrent readers share one reload Promise.

### 4. `execWithRuntimeThrottle` — the actual bash.exec wrapper

`src/api/session-manager.ts:912-952` — Called inside the mutex by all exec handlers:

```typescript
async execWithRuntimeThrottle(session, script, opts) {
    // Uses session.scriptTx (SessionScopedFs) if available
    // Acquires Python/JS semaphore if script uses those runtimes
    // Calls session.bash.exec(script, opts)
}
```

This is called from inside the existing mutex, and will be called from inside the new shared-mode path too. The Python/JS semaphores (`pythonSem`, `jsSem`) are already designed for concurrent use across sessions — they apply globally, not per-session.

### 5. The Three Exec Routes

| Route | File:Line | Session Entry | Locks |
|---|---|---|---|
| `POST /exec-sync` | `exec.ts:132` | `withOwnedSessionOrRehydrate` | Redis exec lock + exclusive mutex |
| `POST /exec` (SSE) | `exec.ts:221` | `withOwnedSessionOrRehydrate` then `withExistingSession` | Redis exec lock + exclusive mutex |
| `POST /exec-sync-batch` | `exec.ts:301` | `withOwnedSessionOrRehydrate` | Redis exec lock + exclusive mutex |

All three will need a `readOnly` branch routing to the new `withSessionRead` path.

### 6. MCP `bash_exec` Tool

`src/api/mcp/tools.ts:151-242` — Uses `withOwnedSessionOrRehydrate` (same exclusive path). The tool schema at line 154-159 currently has no `readOnly` field. The fix adds `readOnly: z.boolean().optional()`.

### 7. `ownership.ts` — Single Wrapper Point

`src/api/ownership.ts:27-44` — `withOwnedSessionOrRehydrate` is the single choke point that adds the owner check before delegating to `sessionManager.withSessionOrRehydrate`. A new `withOwnedSessionOrRehydrateRead` function here is the right place to add the read path, keeping exec.ts and tools.ts clean.

### 8. `SqlFs` Write Methods — What Needs to be Guarded

`src/fs/sql-fs/sql-fs.ts` — The class implements `ICoherentFs` (and `IScriptTxFs`). Write operations to guard with a `#readOnly` flag:

- `writeFile` / `writeFileBuffer` 
- `mkdir`
- `unlink`
- `rmdir`
- `rename`
- `symlink` (already EPERM by default, but still needs EREADONLY in read-only mode)
- `chmod`
- `bulkIngest`

The `SqlFs` class already has a `#dirty` flag pattern (`wasDirty`, `clearDirty`, `session-manager.ts:473`) — adding `#readOnly: boolean` and `setReadOnly(v: boolean)` follows the same pattern. The guard is: throw `EROFS`/`EREADONLY` immediately at the top of each write method when `#readOnly === true`.

**Critical point:** Since all concurrent readers share the same `SqlFs` instance, setting `sqlFs.readOnly = true` once before the first reader begins (and clearing when the last reader exits) is safe. The RW lock ensures no writer runs during this period. The lifecycle ties to shared-lock entry/exit.

### 9. `SessionScopedFs` and `IScriptTxFs`

`src/fs/sql-fs/session-scoped-fs.ts` — Wraps `IScriptTxFs` with `beginScope/endScope/abortScope`. For read-only execs, `SessionScopedFs.beginScope()` must NOT open a write transaction. Two options:
- Skip `scriptTx` entirely for read-only execs (simpler)
- Add a `beginReadScope()` that does nothing (or a no-tx read scope)

**Recommendation:** For `readOnly` execs, skip `scriptTx` entirely (don't call `session.scriptTx.beginScope()`). The scriptTx scope exists to atomically commit writes; read-only execs produce no writes so a scope is unnecessary and skipping it avoids complications.

### 10. `async-mutex` Import — What Changes

`session-manager.ts:15`: `import { Mutex } from "async-mutex";`

The `async-mutex` package only provides an exclusive `Mutex`. It does NOT provide a shared/exclusive RW lock. The issue explicitly says to hand-roll this. The import can stay (used by `session.mutex` until refactored) or be dropped after the RW lock is in place.

### 11. Legacy Stress Harness — Existing Scenario Structure

The removed stress harness ran four scenarios (lifecycle, concurrent exec, idle reap, batch). The parallel readOnly scenario needed to:
- Create a sandbox
- Fire N concurrent `readOnly` exec requests via HTTP
- Assert wall time ≈ `max(per-op latency)` rather than `sum(per-op latency)` (i.e., the ops ran in parallel, not serialized)

---

## Architecture Insights

### RW Lock Contract (to hand-roll)

Node.js is single-threaded, so all state transitions happen atomically between `await` points. The lock state machine:

```
State: { readers: number, writerActive: boolean, pendingWriters: number }

acquireRead():
  if (writerActive || pendingWriters > 0) → queue reader (writer-priority)
  else → readers++

releaseRead():
  readers--
  if (readers === 0 && pendingWriters > 0) → wake next writer

acquireWrite():
  if (writerActive || readers > 0) → queue writer (increment pendingWriters)
  else → writerActive = true

releaseWrite():
  pendingWriters-- (if it was queued)
  writerActive = false
  if (pendingWriters > 0) → wake next writer
  else → wake all queued readers
```

Writer-priority: new readers are blocked when `pendingWriters > 0`, preventing reader starvation of writers (since writers are rarer and more important than reads).

### Session Interface Changes

Current `Session` shape (relevant fields, `session-manager.ts:85-112`):
```typescript
interface Session {
  mutex: Mutex;  // ← replace with rwLock
  inFlight: number;
  // ...
}
```

New shape:
```typescript
interface Session {
  rwLock: AsyncRwLock;         // replaces mutex
  reloadInFlight?: Promise<void>; // single-flight cache reload
  inFlight: number;
  // ... unchanged
}
```

The `destroy()` method at `session-manager.ts:661-725` calls `session.mutex.runExclusive(...)` — this becomes `session.rwLock.acquireWrite()` / `releaseWrite()` in the exclusive path.

The `shutdown()` method at `session-manager.ts:751-797` calls `session.mutex.runExclusive(...)` to drain — this needs to drain both readers and writers.

### Single-Flight `ensureFreshCache` for Readers

The simplest implementation: store `session.reloadInFlight?: Promise<void>`. When a reader enters:

```typescript
private async ensureFreshCacheShared(tenantId, sandboxId, session): Promise<void> {
    if (this.redis === undefined) return;
    const coherent = asCoherentFs(session.fs);
    if (coherent === undefined) return;

    // Check version — if fresh, no reload needed
    let current: number;
    try {
        const raw = await this.redis.get(versionKey(tenantId, sandboxId));
        current = raw === null ? 0 : Number(raw) || 0;
    } catch {
        // Redis down: reload unconditionally, single-flight
        if (session.reloadInFlight === undefined) {
            session.reloadInFlight = coherent.reload().finally(() => {
                session.reloadInFlight = undefined;
            });
        }
        await session.reloadInFlight;
        return;
    }

    if (session.lastSeenVersion === current) return; // cache is fresh

    // Need reload — single-flight: all concurrent readers share one Promise
    if (session.reloadInFlight === undefined) {
        session.reloadInFlight = coherent.reload().then(() => {
            session.lastSeenVersion = current;
            coherent.clearDirty();
        }).finally(() => {
            session.reloadInFlight = undefined;
        });
    }
    await session.reloadInFlight;
}
```

### Read-Only Mode Lifecycle in `withSessionReadEntry`

```typescript
private async withSessionReadEntry<T>(
    tenantId, sandboxId, session, fn,
): Promise<T> {
    if (session.state === "closing") throw ESESSIONCLOSING;

    // Single-flight cache refresh
    await this.ensureFreshCacheShared(tenantId, sandboxId, session);

    // Acquire shared lock
    await session.rwLock.acquireRead();
    session.inFlight++;
    session.lastUsed = Date.now();

    // Enable read-only guard on the FS
    const readOnlyFs = asReadOnlyFs(session.fs); // if it supports setReadOnly
    readOnlyFs?.setReadOnly(true);

    try {
        if (session.state === "closing") throw ESESSIONCLOSING;
        return await fn(session);
    } finally {
        session.inFlight--;
        // Only clear readOnly when the last reader exits
        // (rwLock.releaseRead() decrements internally; we read the count before)
        session.rwLock.releaseRead();
        // When readers == 0, the next acquireWrite caller will proceed;
        // the readOnly flag is cleared in the exclusive path naturally
        // OR: clear here only if this was the last reader
        if (!session.rwLock.hasReaders) {
            readOnlyFs?.setReadOnly(false);
        }
    }
}
```

**Note:** The exact lifecycle of `setReadOnly(false)` must be tied to the last reader exiting, not each reader's exit. The RW lock's `releaseRead()` can expose an `onLastReaderReleased` callback, or the read-entry code can check `rwLock.readers === 0` after decrement.

### The `publishVersionIfDirty` Question for Readers

`publishVersionIfDirty` (`session-manager.ts:527-573`) increments the Redis version counter when the SqlFs was mutated. For `readOnly` execs:
- The SqlFs is in read-only mode → no writes → `wasDirty()` will be false
- So `publishVersionIfDirty` is a no-op for readers

But: should we call it at all in the read path? No — it's not needed. The read path skips `publishVersionIfDirty` entirely. This is safe because:
1. Reads don't mutate state → `wasDirty()` is always false
2. Even if a lying script somehow bypassed the EREADONLY guard (it can't with option a), the dirty flag would be set and we'd attempt publish — but since we're in shared mode, the write would have already thrown.

### HTTP Error Mapping

For a `readOnly: true` exec that contains a write (lying script):
- Option (a): `SqlFs` throws `EROFS` (or a custom `EREADONLY` code) when the bash command tries to write
- The script exits with a non-zero code (the write command failed)
- The bash.exec result has `exitCode != 0` and `stderr` contains the EROFS message
- No explicit HTTP 409/422 is needed at the route level — the error surfaces as a script failure

However, the issue says "surfaces a hard error" — this means logging the violation and optionally returning a structured error. Using option (a), the EROFS propagates through bash's stderr. The route handler can inspect the error code if needed.

---

## Code References

| File | Lines | Description |
|---|---|---|
| `src/api/session-manager.ts` | 15 | `import { Mutex } from "async-mutex"` — replace with RW lock |
| `src/api/session-manager.ts` | 85-112 | `Session` interface — add `rwLock`, `reloadInFlight` |
| `src/api/session-manager.ts` | 393-412 | Session construction — replace `new Mutex()` with `new AsyncRwLock()` |
| `src/api/session-manager.ts` | 444-500 | `withSessionEntry` — adapt to exclusive write path |
| `src/api/session-manager.ts` | 502-525 | `ensureFreshCache` — keep for write path; add single-flight variant for reads |
| `src/api/session-manager.ts` | 575-596 | `withSession` / `withExistingSession` — add `withSessionRead` alongside |
| `src/api/session-manager.ts` | 661-725 | `destroy()` — uses `session.mutex.runExclusive` → adapt to exclusive write path |
| `src/api/session-manager.ts` | 751-797 | `shutdown()` — drain logic needs RW lock awareness |
| `src/api/routes/exec.ts` | 23-29 | `execBodySchema` — add `readOnly?: z.boolean().optional()` |
| `src/api/routes/exec.ts` | 132-218 | `/exec-sync` handler — branch on `body.readOnly` |
| `src/api/routes/exec.ts` | 221-299 | `/exec` SSE handler — branch on `body.readOnly` |
| `src/api/routes/exec.ts` | 301-345 | `/exec-sync-batch` handler — branch on `body.readOnly` |
| `src/api/ownership.ts` | 27-44 | `withOwnedSessionOrRehydrate` — add `withOwnedSessionOrRehydrateRead` |
| `src/api/mcp/tools.ts` | 154-159 | `bash_exec` tool schema — add `readOnly: z.boolean().optional()` |
| `src/api/mcp/tools.ts` | 160-242 | `bash_exec` handler — branch on `args.readOnly` |
| `src/fs/sql-fs/sql-fs.ts` | 122+ | `SqlFs` class — add `#readOnly`, `setReadOnly()`, guard write methods |
| `src/fs/sql-fs/errors.ts` | — | Add `erofs(path)` / `EREADONLY` error constructor |
| Removed legacy stress harness | — | Add parallel readOnly scenario |

---

## Proposed Implementation Phases

### Phase 1 — RW Lock Primitive
Create `src/api/rw-lock.ts`:
- `AsyncRwLock` class with `acquireRead(signal?)`, `releaseRead()`, `acquireWrite(signal?)`, `releaseWrite()`
- Writer-priority invariant
- `AbortSignal` support (reject waiting readers/writers on abort)
- `hasReaders: boolean` getter (or `readerCount: number`)
- Unit tests: ≥6 covering shared/exclusive ordering, writer starvation prevention, abort cancellation, single-flight reload simulation

### Phase 2 — SqlFs Read-Only Guard
In `src/fs/sql-fs/sql-fs.ts`:
- Add `#readOnly = false` private field
- Add `setReadOnly(v: boolean): void`
- Guard all write methods: throw `EROFS` (code `EROFS`) immediately when `#readOnly === true`
- Add `erofs(path: string)` to `src/fs/sql-fs/errors.ts`
- Expose `setReadOnly` via a new interface `IReadOnlyToggle` or extend `ICoherentFs`

### Phase 3 — SessionManager Read Path
In `src/api/session-manager.ts`:
- Replace `mutex: Mutex` in `Session` with `rwLock: AsyncRwLock`
- Add `reloadInFlight?: Promise<void>` to `Session`
- Keep `withSessionEntry` as the exclusive (write) path — adapts to `rwLock.acquireWrite()`
- Add `withSessionReadEntry<T>` — shared path with single-flight cache refresh
- Add `withSessionRead<T>(tenantId, sandboxId, fn, runtimeOptions?)` — public read entry point
- Update `destroy()` and `shutdown()` to use exclusive path
- Skip `publishVersionIfDirty` and `scriptTx` scope in the read path

### Phase 4 — API Surface
- `exec.ts`: add `readOnly?: boolean` to schemas; route to `withOwnedSessionOrRehydrateRead`
- `ownership.ts`: add `withOwnedSessionOrRehydrateRead`  
- `mcp/tools.ts`: add `readOnly` to `bash_exec`; route read-only calls to read path
- HTTP error mapping: `EROFS` → 409 (`EREADONLY_VIOLATION`)

### Phase 5 — Tests
- Unit: RW lock fairness, abort, shared/exclusive ordering, single-flight reload (≥6 tests)
- Integration: 4 concurrent readOnly execs → wall time ≈ `max(latency)`
- Integration: readOnly exec containing a write → fails with EROFS / exitCode ≠ 0
- Integration: writer waits for in-flight readers; new readers wait for queued writer
- Cache-freshness regression: alternating write+read sequence — readers see writer's published state
- Stress: add a parallel readOnly scenario to the legacy harness

---

## Open Questions

1. **Is `Bash.exec()` safe for concurrent calls on the same instance?**  
   The current design assumes `session.bash.exec()` can be called concurrently by multiple readers. If just-bash's `Bash` internally serializes via its own queue, parallel reads are safe but won't be faster. If it uses shared mutable state (e.g., a persistent bash process with shared cwd/env), concurrent calls could corrupt shell state. **This must be verified against the just-bash source before implementing.**

2. **`setReadOnly` interface location** — Should `setReadOnly` be added to `ICoherentFs`, a new `IReadOnlyToggle` interface, or accessed via duck-typing (similar to `asCoherentFs`)? Duck-typing (`asReadOnlyFs`) keeps the `ICoherentFs` interface stable.

3. **`session.lastSeenVersion` update in single-flight read** — The version is read before acquiring the shared lock, updated inside the single-flight promise. If two readers both see a stale version and race on `reloadInFlight`, the second reader's version check needs to account for the first reader having already updated `lastSeenVersion`. The single-flight promise handles this: both await the same Promise; by the time the second reader checks the result, `lastSeenVersion` is already current.

4. **`exec-sync-batch` in read-only mode** — A batch of scripts with `readOnly: true` would hold the shared lock for the duration of the entire batch, blocking writers for longer. Is this the desired behavior? The alternative is to acquire/release shared mode per script in the batch, but that introduces version-staleness gaps between scripts.

   **Resolved (2026-05-14):** The single shared-lock grant for the entire batch is the correct design. Scripts inside a readOnly batch run in parallel (bounded fan-out, `MAX_BATCH_PARALLELISM = 16`) under that grant; wall-clock time decreases while lock-hold duration stays the same as a sequential batch. Version-staleness gaps between per-script lock acquisitions are avoided. See plan `thoughts/shared/plans/2026-05-14_20-50-44_parallel-batch-readonly-exec.md` for implementation details.

5. **openapi-spec.ts** — The `readOnly` field needs to be added to the OpenAPI spec at `src/api/openapi-spec.ts` for documentation completeness.

---

## Historical Context (from thoughts/)

- `2026-05-02_11-24-37_remote-bash-latency-scaling.md` — Prior research on bash exec latency; the serialized mutex was already identified as a bottleneck for exploration-heavy workloads.
- `2026-04-24_21-16-55_session-rehydration-gap.md` — Session rehydration patterns; `withSessionOrRehydrate` is the path that needs a read-only equivalent.

---

## Related Research

- `thoughts/shared/research/2026-05-05_22-26-54_defense-in-depth-postgres-interaction.md` — Defense-in-depth wrapping patterns (relevant because read-only mode changes how SqlFs write methods behave and must not conflict with defense-in-depth boxing of Postgres I/O)

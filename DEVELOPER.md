# Developer Guide

This document covers the internal architecture — how a request flows end-to-end, how the caching layers work, how concurrent requests are serialized, and how correctness is maintained across multiple replicas. Read this before touching `session-manager.ts`, `sql-fs.ts`, or any dialect code.

---

## Mental Model

sql-fs is a **stateless HTTP server** backed by Postgres, with warm in-process state per active sandbox. The key invariant:

> **Postgres is always the source of truth. Everything else is a cache or a lock.**

In-process caches (pathCache, contentCache) exist purely for speed during a single exec. Redis exists for four things: serializing requests across replicas, tracking cache freshness via a version counter, caching blob bytes to avoid Postgres round-trips, and snapshotting the path tree to speed up cold starts. If you dropped Redis and all in-process caches, the system would still be correct — just slower.

Within a single replica, two exec modes share the same `Session` and the same `SqlFs`:

- **Write path (default)** — exclusive per-session lock; one exec at a time; the only path that can mutate the FS.
- **Read path (`readOnly: true`)** — shared per-session lock; many concurrent execs; the FS is forced into a refcounted read-only scope and any mutating syscall throws `EREADONLY` pre-DB, surfaced to clients as HTTP **422 `EREADONLY_VIOLATION`**.

The single-replica feature deliberately skips the distributed Redis exec lock for the read path — cross-replica coherence on reads still relies on the per-session version probe, see the "Multi-replica" sections below.

---

## Core Data Flow

There are two exec paths, distinguished by the caller-declared `readOnly` flag on the request body. Both share the same lock layer — they just acquire it in different modes (exclusive vs. shared).

### Write path (`readOnly: false` — the default)

```
POST /exec
     │
     ▼
Auth middleware
     │
     ▼
SessionManager.withSession(tenantId, sandboxId, fn)
     │
     ├─[1] Acquire Redis exec lock ─────────────── cross-replica mutex
     │       key: vfs:{tenant}:lock:{sandboxId}
     │       SET NX PX + heartbeat renewal
     │
     ├─[2] Version check ────────────────────────── cache freshness
     │       GET vfs:{tenant}:ver:{sandboxId}
     │       (single-flighted across concurrent entries via session.freshCacheInflight,
     │        so N parallel entries share one Redis GET + one fs.reload() if needed)
     │       if lastSeenVersion !== current
     │         → fs.reload() from Postgres
     │         → session.lastSeenVersion = current
     │
     ├─[3] Acquire session.lock in EXCLUSIVE mode ── in-process RWLock
     │       (RWLock.runExclusive, per session, per replica)
     │
     ├─[4] bash.exec(script) ────────────────────── the actual work
     │       each SqlFs write:
     │         #withTx()
     │           SET LOCAL app.sandbox_id = X        ← RLS scoping
     │           pg_advisory_xact_lock(hash(X))      ← DB-layer lock
     │           write to inodes / dirents / blobs
     │           COMMIT
     │         update #pathCache + #contentCache (in-process)
     │         blobCache.set(sha256, data) → Redis    ← fire-and-forget
     │         set #dirty = true
     │
     ├─[5] publishVersionIfDirty (still under exclusive lock)
     │       if #dirty:
     │         INCR vfs:{tenant}:ver:{sandboxId}
     │         session.lastSeenVersion = newVersion
     │         pathSnapshot.write(ver, pathCache) → Redis   ← cold-start cache (optional)
     │         clearDirty()
     │
     ├─[6] Release session.lock (exclusive)
     │       → RWLock dispatch wakes the next waiter:
     │           • next exclusive writer (one), OR
     │           • every consecutive shared (readOnly) waiter in one batch
     │
     └─[7] Release Redis exec lock (Lua check-and-del)
```

### Read path (`readOnly: true`)

Parallel readers on the same sandbox no longer queue behind each other. Multiple readOnly requests acquire the same `Session.lock` in **shared** mode and run concurrently.

```
POST /exec   { readOnly: true }
     │
     ▼
Auth middleware
     │
     ▼
SessionManager.withSessionRead(tenantId, sandboxId, fn)
     │       ── NO distributed Redis exec lock (single-replica only feature; see "Multi-replica
     │           consistency" caveat below)
     │
     ├─[1] Version check (single-flighted across the reader cohort)
     │       same ensureFreshCache as write path
     │
     ├─[2] Acquire session.lock in SHARED mode ──── in-process RWLock
     │       (RWLock.runShared — multiple readers run concurrently)
     │       Writer-priority: if a writer is queued, new readers wait behind it.
     │
     ├─[3] fs.beginReadOnlyScope() ──────────────── refcounted, per-FS
     │       every mutating SqlFs method now throws EREADONLY pre-DB
     │       (writeFile, appendFile, mkdir, rm, chmod, utimes, cp, mv,
     │        symlink, link, bulkIngest)
     │
     ├─[4] readOnlyContext.run(ctx, () => bash.exec(script))
     │       AsyncLocalStorage propagates ctx down into SqlFs.#assertWritable,
     │       which marks THIS call's ctx.violated rather than a shared FS flag.
     │       → a lying script in one reader never falsely flags innocent siblings.
     │       → scriptTx is SKIPPED — no writes can occur, and the shared
     │         SessionScopedFs would race across concurrent readers.
     │
     ├─[5] After fn returns:
     │       • if a raw EREADONLY escaped bash.exec (shell redirections like
     │         `echo x > f` do this) → remap to EREADONLY_VIOLATION
     │       • if ctx.violated (script completed but tagged a violation) →
     │         throw EREADONLY_VIOLATION
     │       → route layer maps EREADONLY_VIOLATION to HTTP 422
     │
     ├─[6] fs.endReadOnlyScope() ──────────────── decrements refcount;
     │       last reader to leave clears the FS-level scope
     │
     └─[7] Release session.lock (shared)

NOTE: the read path does NOT call publishVersionIfDirty. No writes ⇒ #dirty
      stays false anyway, but the flag is preserved across read entries so a
      subsequent writer's publish still fires correctly.
```

---

## The Three Lock Layers

Three locks work together. Each is the fallback for the one above it.

### Lock 1 — `session.lock` (in-process RWLock)

- **Type:** hand-rolled async readers-writer lock (`RWLock`, `src/api/rw-lock.ts`), one per `Session` object. Replaced the original `async-mutex`-based exclusive `Mutex` in `0.3.0`.
- **Scope:** one replica, one sandbox
- **Modes:**
  - **Exclusive** (`runExclusive`) — held for the entire `bash.exec(script)` call on the write path, plus `destroy`, reaper drain, and `shutdown`. One holder at a time.
  - **Shared** (`runShared`) — held for the entire `bash.exec(script)` call on the readOnly path. Many holders at a time.
- **Purpose:** prevents two writers on the *same replica* from interleaving inside `Bash` or `SqlFs`, while letting readOnly callers proceed in parallel against a refcounted read-only FS scope.
- **Fairness:** writer-priority. A queued exclusive waiter blocks new shared acquisitions even when the lock is currently held in shared mode — readers cannot starve writers.
- **Batch wake:** when a writer releases and the head of the wait queue is a reader, `#dispatch()` wakes *every* consecutive shared waiter in a single pass, so the whole reader cohort starts in parallel rather than via N separate dispatches.
- **AbortSignal:** pending acquisitions (not held locks) honour `AbortSignal` — client disconnect / timeout on a queued reader/writer rejects cleanly with `code: "ABORTED"`.
- **Cost:** zero network — pure microtask queue.

**Invariants enforced by the lock:**

| State | Meaning |
|---|---|
| `writerActive=true, readers=0` | one writer holds the lock; all other callers queue |
| `writerActive=false, readers≥1` | N readers hold the lock; a writer queues, new readers also queue (writer-priority) |
| `writerActive=false, readers=0` | lock is free; next dispatch picks the head waiter |

Bypassing the lock to write directly to `SqlFs` from elsewhere in the codebase will break the read-only safety net. All exec entry must go through `SessionManager.withSession` / `withSessionRead` / `withSessionOrRehydrate`.

### Lock 2 — Redis exec lock (distributed)

- **Type:** `SET NX PX` with a unique token + heartbeat renewal + Lua check-and-release
- **Key:** `vfs:{tenant}:lock:{sandboxId}`
- **Scope:** entire fleet
- **Held for:** entire `withSession` callback (wraps bash.exec + pre/post logic)
- **Purpose:** only one replica runs exec for a given sandbox at a time
- **Failure mode:** if a GC pause exceeds the lease interval, the lock expires and another replica can acquire. Lock 3 catches the resulting DB-level race. This is an accepted trade-off — data integrity is preserved but script atomicity for that one request is not.
- **`LockLostError` is post-hoc, not preventive:** the heartbeat sets `lost = true` when the renew Lua script returns 0 (key no longer holds our token), but `lost` is only checked *after* `fn()` completes (`distributed-lock.ts:137`). By the time `LockLostError` is thrown, the bash script has already finished executing — including any DB writes — and Replica B has already been running concurrently. The error tells the caller the result is unreliable; it does not interrupt execution mid-script. Interrupting `fn()` mid-execution would leave `SqlFs` in a half-written state, which is worse than letting it finish and surfacing the error after.

  ```
  t=0s    Replica A acquires lock (leaseMs=60s)
  t=20s   heartbeat fires → RENEW_SCRIPT returns 1 ✓
  t=40s   heartbeat fires → RENEW_SCRIPT returns 1 ✓
          ← Node.js GC pause starts (or Redis outage)
  t=60s   lease expires — Replica B acquires the lock
  t=60s   heartbeat fires → RENEW_SCRIPT returns 0 (key now holds B's token)
          → lost = true
          ← GC pause ends, Replica A resumes
  t=61s   fn() finishes
  t=61s   if (lost) throw new LockLostError  ← thrown here, but overlap already happened
  ```
- **Redis down:** fail closed → 503. Mutating endpoints never proceed without this lock.

### Lock 3 — `pg_advisory_xact_lock` (database)

- **Type:** Postgres transaction-scoped advisory lock
- **Key:** `hashtextextended(sandboxId, 0)` — 64-bit keyspace
- **Held for:** one `#withTx` transaction (milliseconds)
- **Purpose:** last line of defense for DB data integrity when Lock 1 or Lock 2 fail — GC pause beyond lease, code paths that bypass `withSession`, pathological split-brain
- **Why `_xact_` variant:** transaction-scoped, auto-released on commit/rollback. The session-scoped `pg_advisory_lock` breaks silently under pgbouncer / Neon transaction-mode pooling.
- **Cost in the happy path:** one extra SQL statement per transaction, always uncontended

**What each lock actually catches:**

| Scenario | Lock 1 | Lock 2 | Lock 3 |
|---|---|---|---|
| Two concurrent writes, same replica, same sandbox | blocks (exclusive) | redundant | redundant |
| Two concurrent writes, different replicas, same sandbox | — | blocks | backstop |
| N concurrent readOnly reads, same replica, same sandbox | **lets them run in parallel (shared)** | (read path skips Lock 2) | not engaged (no writes) |
| Mixed reader + writer, same replica | reader waits for writer / writer waits for readers; writer-priority | only the writer takes it | only the writer's DB tx |
| GC pause > lease; second replica interleaves DB writes | — | fails | serializes at DB layer |
| `DELETE /sandboxes/:id` races an active exec | drains via exclusive acquire | blocks (routed through lock) | backstop |
| Admin/test route bypasses `withSession` | — | — | still catches |

### Lock observability — event-loop lag (F8)

Every lease above (the exec-lock writer lease, the RW-lock writer flag, and the RW-lock reader ZSET scores) is kept alive by a `setTimeout` heartbeat that renews well before expiry (`renewMs` 20s < `leaseMs` 60s). They all assume the timer fires roughly on schedule. The GC-pause failure mode in the table above is exactly a violation of that assumption: when the event loop stalls longer than the lease, the renewal fires too late, Redis has already expired the key / reaped the reader entry, and the next renew returns 0 → `LockLostError`. Lock 3 keeps the DB consistent, so this is an **observability** concern, not a correctness one — but until F8 nothing measured how close the process ran to the lease floor.

`src/api/event-loop-monitor.ts` is purely observational and emits two structured log events:

| Event | Emitted by | Fields | Meaning / alert threshold |
|---|---|---|---|
| `event_loop_lag` | boot sampler (`startEventLoopMonitor`, every `EVENT_LOOP_MONITOR_INTERVAL_MS`, default 10s) | `p50Ms`, `p99Ms`, `maxMs`, `meanMs`, `windowMs` | Process-wide event-loop delay from `perf_hooks.monitorEventLoopDelay`. **Page** when `p99Ms`/`maxMs` approaches `renewMs` (~20s) — the lease margin is being eaten. |
| `heartbeat_gap` | each heartbeat callback (`recordHeartbeatGap`) | `severity`, `lock` (`exec`\|`rw-writer`\|`rw-reader`), `key`, `gapMs`, `renewMs`, `leaseMs` | Actual-minus-expected fire time for one heartbeat. `severity:"warn"` at `gapMs > renewMs` (a full interval late); `severity:"critical"` at `gapMs > leaseMs` (the lease almost certainly lapsed). Silent below `renewMs`. |

`warn`/`critical` go to `console.warn`/`console.error` respectively; the sampler logs at `console.log`. A `critical` `heartbeat_gap` for `exec`/`rw-writer` is the breadcrumb that explains a subsequent `LockLostError`; for `rw-reader` it flags the window during which a writer could have reaped the stale reader entry and entered mid-read. `eventLoopLagSnapshot()` exposes the live histogram for a future health endpoint without perturbing the windowed log.

---

## ReadOnly Safety Model

When `withSessionRead` is the entry point, three independent mechanisms cooperate to make parallel reads safe against a shared `SqlFs` instance:

1. **`session.lock` in shared mode** — bounds the cohort. No writer can interleave; the FS instance is mutation-free for the duration.
2. **`fs.beginReadOnlyScope()` / `endReadOnlyScope()`** on `SqlFs` — refcounted. Every mutating syscall (`writeFile`, `appendFile`, `mkdir`, `rm`, `chmod`, `utimes`, `cp`, `mv`, `symlink`, `link`, `bulkIngest`) throws `EREADONLY` *before* any DB call. The throw happens in `SqlFs.#assertWritable` and never reaches the dialect — so the dialect mocks in unit tests confirm zero spurious connections / transactions on violation.
3. **`readOnlyContext` (AsyncLocalStorage)** — per-call violation attribution. When `SqlFs.#assertWritable` fires, it marks the *current* call's `ctx.violated = true`, not a boolean on the shared FS. This is what prevents a lying script in reader A from poisoning innocent reader B running in parallel.

`SessionManager.withSessionReadEntry` then turns either signal into a uniform `EREADONLY_VIOLATION`:

- If `bash.exec` rejects with a raw `EREADONLY` (some bash builtins, notably shell redirections like `echo x > f`, let the synchronous reject escape rather than normalising it to a non-zero exit), the catch re-throws as `EREADONLY_VIOLATION`.
- Otherwise, after `fn` returns successfully, if `ctx.violated` was set, throw `EREADONLY_VIOLATION`.

Route handlers (`/exec-sync`, `/exec` SSE, `/exec-sync-batch`, MCP `bash_exec` / `bash_exec_batch`) map `EREADONLY_VIOLATION` → HTTP **422**.

**The `scriptTx` is intentionally bypassed in the read path** (`execWithRuntimeThrottle` inspects `readOnlyContext.getStore()`). The script transaction is a per-script DB transaction shared via `SessionScopedFs` — concurrent readers would race on its `beginScope`/`endScope`. Since no writes can occur, there is nothing for it to commit.

**Parallel batch execution (`exec-sync-batch` / `bash_exec_batch` with `readOnly:true`):** When a batch is invoked with `readOnly:true`, its scripts execute in parallel under a single shared-lock grant. The lock-hold duration is unchanged relative to a sequential batch — only wall-clock time decreases. Result order is preserved by indexed assignment into a pre-sized array. The fan-out is bounded by `MAX_BATCH_PARALLELISM = 16` (defined in `src/api/lib/batch-exec.ts`). The branching is controlled by `readOnlyContext.getStore()` inside `executeBatch` — if the ALS store is populated (i.e., the caller is inside a `withSessionReadEntry` scope), the parallel path runs; otherwise the sequential path runs.

---

## Cache Layers

### L1 — In-process, per session

Lives inside each `SqlFs` instance. Thrown away when the session is evicted.

| Cache | Type | Keyed by | Size limit | Populated |
|---|---|---|---|---|
| `#pathCache` | `Map<string, PathCacheEntry>` | absolute path | configurable (default 50 MB) | `loadAllPaths` at session start, then updated on every write |
| `#contentCache` | `LRUCache<bigint, Uint8Array>` | inode ID | 50 MB, LRU-evicted | lazy on first `readFile`, evicted on write/delete |

Reads during an exec hit these at zero latency. They may be arbitrarily stale *between* execs — that is fine because nothing reads them between execs. The version counter (below) ensures they're refreshed before the next exec begins.

### L2 — Redis blob cache

- **Key:** `vfs:{tenant}:blob:{sha256hex}` → raw bytes
- **Read path:** `PostgresDialect.getBlob` → try Redis first, fall through to Postgres on miss, populate Redis on Postgres hit
- **Write path:** `PostgresDialect.upsertBlob` → write Postgres first, then `blobCache.set(sha256, data)` (fire-and-forget, no await)
- **Invalidation:** never needed — content is immutable under its sha256
- **Size cap per entry:** `REDIS_BLOB_MAX_BYTES` (default 8 MB); larger blobs bypass Redis entirely to prevent a single large file from flushing the working set
- **Eviction:** Redis `allkeys-lru` + per-key TTL (default 24 h)

### L2b — Redis path snapshot

- **Key:** `vfs:{tenant}:snap:{sandboxId}` → msgpack-encoded full `pathCache` with embedded version number
- **Purpose:** cold-start optimization — lets a replica bootstrap its `pathCache` from Redis instead of running a full `loadAllPaths` Postgres CTE scan
- **Write path:** `publishVersionIfDirty` (session-manager) → after `INCR ver`, writes the current `pathCache` to Redis via `pathSnapshot.write(tenantId, sandboxId, newVersion, pathCache)`. Only fires if `pathSnapshot` is configured.
- **Read path:** `SqlFs.#loadFreshPathCache()` (called by `ready()` on session creation and `reload()` on cache refresh) → reads snapshot, checks embedded version matches `vfs:ver:{sandboxId}` exactly; any mismatch, miss, or Redis error falls through to `loadAllPaths` from Postgres
- **Correctness:** the embedded version acts as a consistency guard — a snapshot is only used if it was written by the exact same exec that last bumped the version counter. Stale or partially-written snapshots are always rejected
- **Failure mode:** all Redis errors fail open — `read` returns `null`, `write` logs and returns. The system falls back to Postgres silently
- **TTL:** 1 hour (default); sandbox delete also calls `pathSnapshot.delete()` eagerly
- **Enabled by:** set `REDIS_PATH_SNAPSHOT_ENABLED=true` (requires Redis to also be configured). `server.ts` constructs the `RedisPathSnapshot` instance and passes it to `SessionManager` when both conditions are met.

```
Cold start without snapshot:  session created → loadAllPaths (Postgres CTE, proportional to file count)
Cold start with snapshot hit: session created → GET snap key → msgpack decode → pathCache ready
Cold start with snapshot miss: snapshot absent or version mismatch → falls through to Postgres
```

### L3 — Postgres

Always the source of truth. Every mutation writes here first before any cache is updated. A cache miss at any layer falls through to Postgres.

---

## Cross-Replica Cache Coherence

No pub/sub. Coherence is solved with a single version counter in Redis, feasible because exec serialization (Lock 2) collapses the requirement from continuous to exec-boundary only.

### Version counter

- **Key:** `vfs:{tenant}:ver:{sandboxId}` — a monotonic integer, absent = 0
- **Bumped:** `INCR` after every exec that set `#dirty = true`, performed *after* the bash.exec completes but *before* releasing the Redis lock
- **Checked:** at the start of every exec, after acquiring the Redis lock

### Protocol

**On exec entry (after Lock 2 acquired):**
```
current = GET vfs:ver:{sandboxId}
if session.lastSeenVersion !== current:
    fs.reload()                  ← clears #pathCache and #contentCache, re-runs loadAllPaths from Postgres
    session.lastSeenVersion = current
```

**On exec exit (before Lock 2 released):**
```
if fs.wasDirty():
    newVersion = INCR vfs:ver:{sandboxId}
    session.lastSeenVersion = newVersion
    fs.clearDirty()
```

### Why this is sufficient

1. Lock 2 ensures only one replica holds an exec for a given sandbox at a time
2. Nothing reads sandbox state outside of an exec
3. When a replica picks up a sandbox after another replica left it:
   - It acquires Lock 2 (previous holder has released it)
   - Reads the version counter → mismatch → `reload()` from Postgres
   - Proceeds with a fully fresh cache
4. Between execs, caches can be stale — harmless because they are never read between execs

---

## Handling Multiple Concurrent Requests

### Same sandbox, same replica

The behaviour depends on whether each request is `readOnly`:

| Request A | Request B | Outcome on the same replica |
|---|---|---|
| write | write | B queues behind A at the Redis lock and at `session.lock` (exclusive). Fully serialized. |
| write | readOnly | B skips the Redis lock but queues behind A at `session.lock` (shared waits for exclusive). |
| readOnly | write | B grabs the Redis lock immediately, then queues at `session.lock` (exclusive waits for active readers). New readers arriving after B queue behind B (writer-priority). |
| readOnly | readOnly | **Both run in parallel.** Both take `session.lock` in shared mode; the FS is in a refcounted read-only scope; any mutating syscall throws `EREADONLY` pre-DB and is remapped to HTTP 422 `EREADONLY_VIOLATION`. |

Mixed read/write inside a *single script* is always handled on the write path — `readOnly` is a caller declaration, not auto-detected. An agent that issues a script with any chance of writing must leave `readOnly` unset (defaults to false).

### Same sandbox, different replicas

Request B on Replica 2 tries to acquire `vfs:lock:{sandboxId}` while Request A on Replica 1 holds it. Request B blocks at the Redis lock until Request A completes, version is incremented, and the lock is released. When Request B acquires, it reads the updated version, sees a mismatch, reloads from Postgres, and proceeds with a fresh cache.

```
Replica 1:  [acquire lock] → [exec] → [INCR ver] → [release lock]
Replica 2:                    [waiting on Redis lock]
                                                              [acquire lock] → [version mismatch → reload] → [exec]
```

### Different sandboxes

Locks and caches are entirely per-sandbox. Requests on different sandboxes are always fully parallel with no contention between them.

### Sandbox destruction during active exec

`DELETE /sandboxes/:id` routes through the same Redis exec lock. It cannot acquire the lock until all in-flight execs for that sandbox complete. At the DB layer, `pg_advisory_xact_lock` also serializes the destroy transaction against any stray writes.

---

## Session Lifecycle

### Creation

`getOrCreate` builds a session lazily on first access for a `(tenantId, sandboxId)` pair. It constructs the `SqlFs` instance (which runs `loadAllPaths` or loads from path snapshot), creates a `Bash` instance with the filesystem wired in, reads the current version counter from Redis, and stores the session in the in-process map. Concurrent creation requests for the same sandbox coalesce onto a single `Promise` via the `pending` map — only one `SqlFs` + `Bash` is ever constructed.

### Rehydration from cold storage

`withSessionOrRehydrate` is used by exec routes. If the session is not in the in-process map (evicted or first access on this replica), it calls `getSandboxMetaFn` to restore owner and runtime flags (python/javascript) from Postgres, then constructs a **brand new** `SqlFs` + `Bash`. There is no reuse of the old instances — they were evicted and are gone.

```
Request hits Replica B, session not in memory
  → getSandboxMetaFn(tenantId, sandboxId) → Postgres → { owner, python, javascript }
  → getOrCreate → new SqlFs + new Bash   ← full construction, not reuse
      → ready() → loadAllPaths from Postgres (or Redis snapshot if enabled)
  → withSessionEntry → exec proceeds normally
```

What rehydration saves is knowing *which* owner and runtime flags to reconstruct with — the client does not need to re-specify them. It does not avoid the `SqlFs` initialization cost.

**The actual cold-start speedup** comes from the path snapshot (`REDIS_PATH_SNAPSHOT_ENABLED=true`), not rehydration. Without the snapshot, `ready()` runs a full `loadAllPaths` Postgres CTE scan proportional to the number of files. With the snapshot, it becomes a single Redis GET + msgpack decode. Rehydration and path snapshot are complementary: rehydration restores metadata, the snapshot restores the path tree.

### Eviction (reaper)

A background reaper runs every 60s and evicts sessions that are either:
- **Idle** — `now - lastUsed > idleMs` (default 600s)
- **Over budget** — `pathCacheBytes > pathCacheMaxBytes` (default 50 MB); triggered when a sandbox has too many files to fit in the path cache

Sessions with in-flight requests (`inFlight !== 0`) are never evicted. Eviction just removes the entry from the session map — the next request for that sandbox will rehydrate it from Postgres.

### Content prewarm

After the path cache is loaded, `SqlFs` spawns a background task that bulk-fetches all blob bytes for the sandbox from Postgres into the in-memory content cache in a single query. This avoids N individual `readFile` queries when a script reads many files on cold start. If `reload()` clears the cache while prewarm is running, a queued flag ensures a follow-up prewarm fires.

---

## Script Transaction Scope

Every `bash.exec(script)` call on the Postgres backend is wrapped in a database transaction that spans the entire script. This is the `scriptTx` mechanism (`SessionScopedFs` + `IScriptTxFs`).

```
bash.exec(script)
  → scriptTx.beginScope()     ← sets #scriptScope = true (no DB call yet)
  → script runs:
      first write → #openScriptTx() ← NOW opens the DB transaction (lazy)
      subsequent writes reuse the same open transaction
  → scriptTx.endScope()       ← COMMIT
  on error:
  → scriptTx.abortScope()     ← ROLLBACK + reload() to clear stale in-process caches
```

**What it buys:** if a script creates 5 files and then fails, all 5 writes are rolled back atomically. Without this, partial writes would persist. The script either fully succeeds or leaves no trace.

**The transaction is lazy:** `beginScope()` only sets a flag. The actual DB transaction is opened on the first write operation inside `#withTx`. Read-only scripts never open a DB transaction at all — they just run through `#withReadTx` with no advisory lock.

**What it does NOT change:** the three lock layers still operate identically. The transaction scope is an additional DB-level atomicity guarantee layered on top of the existing locking.

**Backend support:** the session manager duck-types the `IFileSystem` instance for `IScriptTxFs` at session creation time. `SqlFs` always implements it, so `scriptTx` is always active in production. If the backend doesn't support it (e.g., `InMemoryFs` in tests), `scriptTx` is `undefined` and `bash.exec` runs without the transaction wrapper.

---

## Runtime Semaphores

Two per-replica semaphores cap concurrent CPU-intensive language runtimes:

| Semaphore | Default limit | Trigger condition |
|---|---|---|
| `pythonSem` | 5 | script text matches `\bpython3?\b` and session has `python: true` |
| `jsSem` | 5 | script text matches `\bjs-exec\b` or `\bnode\b` and session has `javascript: true` |

Before calling `bash.exec`, `execWithRuntimeThrottle` acquires the relevant slot(s). Excess requests queue on the semaphore's `waiters` array and fire FIFO as slots free. Slots are always released in `finally`.

**Why this matters:** CPython WASM workers consume ~80 MB each; QuickJS workers ~64 MB each. Without a cap, 20 concurrent Python scripts on one replica would consume 1.6 GB and likely OOM. Bash-only scripts are completely unaffected — they bypass both semaphores.

**Scope:** per-replica, not global. A fleet of 3 replicas has an effective Python concurrency of 15.

---

## Multi-Tenancy

### Two modes

**Single-tenant (default):** set `DATABASE_URL`. The connection string is registered under the fixed tenant id `"default"`. All sandboxes share one Postgres database, isolated by RLS on `sandbox_id`. `tenantId` is always `"default"` — the multi-tenant machinery is present but a no-op.

**Multi-tenant:** set `TENANT_DATABASES` as a JSON object:
```
TENANT_DATABASES={"acme":"postgres://acme-db/...", "widgets":"postgres://widgets-db/..."}
```
Each tenant maps to a separate Postgres database. Per-tenant connection pools are lazily constructed on first access and cached for the lifetime of the process. `DATABASE_URL` is ignored when `TENANT_DATABASES` is set.

### Isolation layers

Every session key, Redis key, and exec lock key is prefixed with `tenantId` so the isolation holds even when tenants share the same Redis instance:

| Layer | Isolation mechanism |
|---|---|
| Session map | Key is `${tenantId}:${sandboxId}` |
| Redis keys | All prefixed `vfs:{tenant}:...` |
| Postgres | Separate database per tenant (multi-tenant mode); RLS on `sandbox_id` within each database |
| Exec lock | Key includes `tenantId` — no cross-tenant lock contention |

---

## What Is NOT Guaranteed

**Multi-step client atomicity.** The lock is acquired and released per `exec` call, not across your entire agent session. Two separate exec calls with logic in between leave a window where another agent can slip in:

```
Agent A: exec "cat balance.txt"         → Python: 100 - 50 = 50    → exec "echo 50 > balance.txt"
Agent B:                          exec "echo 0 > balance.txt"
                                  ↑ acquired the lock here, overwrote to 0
                                                                        ↑ Agent A now writes 50 — B's write is lost
```

**Fix: bundle the read, compute, and write into one script.** The lock is held for the entire duration of a single script.

```bash
# One exec call — nothing can slip in between the read and the write
balance=$(cat balance.txt)
new=$((balance - 50))
echo $new > balance.txt
```

**Script atomicity under pathological GC pauses.** If the Node.js GC pauses longer than the Redis lock lease (`REDIS_EXEC_LOCK_LEASE_MS`, default 60s), the lock expires, another replica can acquire, and two scripts may interleave in time. Postgres data integrity is preserved by Lock 3 — no corruption, but bash-level semantics are not guaranteed for the affected request.

**Continuous cache freshness between execs.** The in-process caches are stale between execs by design. This is fine — they are only authoritative *during* an exec, after the version check has confirmed or refreshed them.

---

## Redis Key Inventory

All Redis keys are tenant-prefixed to prevent cross-tenant collisions.

| Key pattern | Type | Purpose | Written by | Read by |
|---|---|---|---|---|
| `vfs:{tenant}:lock:{sandboxId}` | string (token) | Distributed exec mutex — one replica holds exec at a time | `withDistributedLock` (SET NX PX) | `withDistributedLock` (Lua renew + release) |
| `vfs:{tenant}:ver:{sandboxId}` | integer | Monotonic version counter — cache freshness signal | `publishVersionIfDirty` (INCR) | `ensureFreshCache` (GET), `#loadFreshPathCache` (GET) |
| `vfs:{tenant}:blob:{sha256hex}` | bytes | Blob content cache — avoids Postgres round-trips for file reads | `PostgresDialect.upsertBlob` (fire-and-forget SET) | `PostgresDialect.getBlob` (GET before Postgres) |
| `vfs:{tenant}:snap:{sandboxId}` | bytes (msgpack) | Path snapshot — cold-start pathCache bootstrap | `publishVersionIfDirty` → `pathSnapshot.write` | `SqlFs.#loadFreshPathCache` → `pathSnapshot.read` |

---

## Key Source Files

| File | What it does |
|---|---|
| `src/api/session-manager.ts` | Owns the session pool, all three lock acquisitions, write + read entries (`withSession`, `withSessionRead`, `withSessionOrRehydrate`), version check, dirty publish, `EREADONLY` → `EREADONLY_VIOLATION` remap |
| `src/api/rw-lock.ts` | `RWLock` — hand-rolled async readers-writer lock used by `Session.lock`. Writer-priority, batch-wake for queued readers, `AbortSignal` support |
| `src/api/read-only-context.ts` | `readOnlyContext` AsyncLocalStorage — per-call violation attribution for the parallel-readOnly path |
| `src/api/ownership.ts` | `withOwnedSessionOrRehydrate` / `withOwnedSessionRead` — adds owner check inside the lock before delegating to `SessionManager` |
| `src/fs/sql-fs/sql-fs.ts` | `SqlFs` class — all `IFileSystem` methods, pathCache, contentCache, `#dirty` flag, `reload()`, refcounted `beginReadOnlyScope`/`endReadOnlyScope`, `#assertWritable` |
| `src/fs/sql-fs/dialects/postgres.ts` | Postgres dialect — `setSandboxContext` (RLS + advisory lock), blob cache read/write, all SQL |
| `src/fs/sql-fs/session-scoped-fs.ts` | `ICoherentFs` interface — `reload`, `wasDirty`, `clearDirty` |
| `src/fs/sql-fs/redis-blob-cache.ts` | Redis blob cache — `get`/`set` with TTL and size cap |
| `src/fs/sql-fs/redis-path-snapshot.ts` | Version key helpers; path snapshot — cold-start pathCache bootstrap from Redis (off by default) |
| `src/api/routes/exec.ts` | HTTP exec routes — branches on `readOnly` to funnel through `withOwnedSessionOrRehydrate` (write) or `withOwnedSessionRead` (read); maps `EREADONLY_VIOLATION` → 422 |
| `src/api/mcp/tools.ts` | MCP `bash_exec` / `bash_exec_batch` — same `readOnly` branching as HTTP routes |
| `thoughts/shared/research/2026-05-10_13-03-37_parallel-readonly-bash-exec.md` | Design doc for the parallel-readOnly feature |

---

## Consensus Algorithm Discussion

sql-fs does not implement a consensus algorithm (Raft, Paxos, or similar). This is a deliberate design choice, not an oversight.

Consensus algorithms are needed when multiple nodes must agree on a sequence of writes with no single authoritative source. sql-fs avoids that requirement entirely by keeping Postgres as the single authoritative source and serializing all writes to a sandbox through a single exec lock at any given time.

Each concern that consensus typically solves is handled more simply here:

| Concern | Consensus approach | sql-fs approach |
|---|---|---|
| Leader election | Raft leader vote, quorum | Redis `SET NX` — whoever wins the atomic SET owns the exec |
| Distributed state agreement | Log replication across nodes | Version counter (`INCR ver`) + reload from Postgres on mismatch |
| Conflict resolution | Consensus on write order | Not needed — exec serialization prevents concurrent writes to the same sandbox |
| Partition tolerance | Quorum reads/writes | Fail closed → 503 when Redis is unreachable (CP, not AP) |

**Why this works here but wouldn't in the general case:**

The key constraint is that all writes to a sandbox are serialized through a single exec at a time (Lock 2). This collapses the consistency requirement from *continuous* (nodes must agree at all times) to *exec-boundary only* (a replica only needs a fresh view at the start of each exec). A single monotonic integer answers that in one Redis GET — no voting, no quorum, no log replication.

If the workload ever required two replicas to concurrently write the same sandbox, this model would break and a stronger coordination mechanism would be needed. The architecture avoids that requirement by design.

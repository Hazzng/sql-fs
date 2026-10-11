# Developer Guide

This document covers the internal architecture — how a request flows end-to-end, how the caching layers work, how concurrent requests are serialized, and how correctness is maintained across multiple replicas. Read this before touching `session-manager.ts`, `sql-fs.ts`, or any dialect code.

---

## Production-readiness harness

Reproductions for the distributed, memory, and durability issues (#164-#175) — how to stand up the
multi-replica stack, inject the faults, and verify a fix — live in
`thoughts/shared/research/2026-09-18_prod-readiness-harness.md`. Most of those failures are not
reachable from the unit suite or from a single replica.


## Mental Model

sql-fs is a **stateless HTTP server** backed by Postgres, with warm in-process state per active sandbox. The key invariant:

> **Postgres is always the source of truth. Everything else is a cache or a lock.**

In-process caches serve filesystem calls after request admission validates their durable PostgreSQL epoch. Redis provides distributed locks and immutable blob caching. PostgreSQL remains required for every filesystem request, including warm reads.

Within a single replica, two exec modes share the same `Session` and the same `SqlFs`:

- **Write path (default)** — exclusive per-session lock; one exec at a time; the only path that can mutate the FS.
- **Read path (`readOnly: true`)** — shared per-session lock; many concurrent execs; the FS is forced into a refcounted read-only scope and any mutating syscall throws `EREADONLY` pre-DB, surfaced to clients as HTTP **422 `EREADONLY_VIOLATION`**.

Readers acquire shared local locks and writers acquire exclusive local locks before admission. With Redis configured, they also acquire the corresponding distributed locks.

---

## Core Data Flow

There are two exec paths, distinguished by the caller-declared `readOnly` flag on the request body. Both share the same lock layer — they just acquire it in different modes (exclusive vs. shared).

### Write path (`readOnly: false`)

1. Acquire the distributed Redis writer lock.
2. Acquire the local session lock in exclusive mode.
3. Call `SqlFs.ensureFresh()` to validate PostgreSQL authority before invoking the handler.
4. Run the handler or script scope. SQL mutation transactions hold the advisory lock and advance the durable epoch. A buffered script records metadata changes locally and flushes them in one transaction at scope completion.
5. Refresh the session memory estimate and release both locks.

### Read path (`readOnly: true`)

1. Acquire a shared distributed Redis lock and the local session lock in shared mode.
2. Call `SqlFs.ensureFresh()`. A sealed cohort may share one SQL sample; requests arriving after that sample starts wait for another sample.
3. Enter the refcounted read-only filesystem scope and run the callback inside its `readOnlyContext`. Every mutating syscall rejects with `EREADONLY`; the request maps a violation to `EREADONLY_VIOLATION` and HTTP 422.
4. End the read-only scope and release both locks. Concurrent readers keep separate violation contexts.

Writers queue behind active readers, and newly arriving readers queue behind a local waiting writer. Read-only callbacks do not open a script transaction. Failed admission never invokes the callback.

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

### Lock 2 — Redis readers-writer lock (distributed)

- **Type:** Lua acquisition and release with token ownership and heartbeat renewal. Writers hold an exclusive lease; readers hold shared leases in a sorted set.
- **Keys:** `vfs:${tenantId}:rwlock:{${sandboxId}}:writer` and `vfs:${tenantId}:rwlock:{${sandboxId}}:readers`. The sandbox braces are Redis Cluster hash tags.
- **Legacy fallback:** `REDIS_RWLOCK_ENABLED=false` uses `SET NX PX` at `vfs:${tenantId}:lock:${sandboxId}`. Both readers and writers acquire this exclusive lock.
- **Scope:** entire fleet
- **Held for:** entire `withSession` callback (wraps bash.exec + pre/post logic)
- **Purpose:** serialize writers against other writers and readers across replicas, while allowing concurrent readers
- **Failure mode:** a pause longer than the lease can allow another replica to enter. The SQL advisory lock and epoch fence reject stale mutations. Request-entry freshness does not promise a fixed view for a whole script after lease loss.
- **Lease loss:** a definitive heartbeat failure aborts the signal passed to active exec work. A guarded callback that has already completed returns `ELOCKLOST_APPLIED`, so clients must not retry a non-idempotent write blindly.
- **Redis down:** with Redis configured, lock acquisition fails closed with 503.

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
| N concurrent readOnly reads, same replica, same sandbox | **lets them run in parallel (shared)** | shared reader leases | not engaged (no writes) |
| Mixed reader + writer, same replica | reader waits for writer / writer waits for readers; writer-priority | shared readers exclude the writer lease | only the writer's DB tx |
| GC pause > lease; second replica interleaves DB writes | — | fails | serializes at DB layer |
| `DELETE /sandboxes/:id` races an active exec | drains via exclusive acquire | blocks (routed through lock) | backstop |
| Admin/test route bypasses `withSession` | — | — | still catches |

### Lock observability — event-loop lag (F8)

Every lease above (the exec-lock writer lease, the RW-lock writer flag, and the RW-lock reader ZSET scores) is kept alive by a `setTimeout` heartbeat that renews well before expiry (`renewMs` 20s < `leaseMs` 60s). They all assume the timer fires roughly on schedule. The GC-pause failure mode in the table above is exactly a violation of that assumption: when the event loop stalls longer than the lease, the renewal fires too late, Redis has already expired the key / reaped the reader entry, and the next renew returns 0 → `LockLostError`. Lock 3 keeps the DB consistent, so this is an **observability** concern, not a correctness one — but until F8 nothing measured how close the process ran to the lease floor.

`src/api/event-loop-monitor.ts` is purely observational and emits three structured log events:

| Event | Emitted by | Fields | Meaning / alert threshold |
|---|---|---|---|
| `event_loop_lag` | boot sampler (`startEventLoopMonitor`, every `EVENT_LOOP_MONITOR_INTERVAL_MS`, default 10s) | `p50Ms`, `p99Ms`, `p999Ms`, `maxMs`, `meanMs`, `windowMs` | Process-wide event-loop delay from `perf_hooks.monitorEventLoopDelay`. **Page** when `p99Ms`/`maxMs` approaches `renewMs` (~20s) — the lease margin is being eaten. |
| `event_loop_stall` | same sampler, only when a window's `maxMs` crosses `EVENT_LOOP_STALL_THRESHOLD_MS` (default 2000) | `severity:"critical"`, `maxMs`, `p999Ms`, `thresholdMs`, `windowMs` | One window blocked long enough to time out Redis commands belonging to *other* tenants (the client's `commandTimeout` is 2s). **Page**: past this point a stall is a correctness bug, not a latency one (#168). |
| `heartbeat_gap` | each heartbeat callback (`recordHeartbeatGap`) | `severity`, `lock` (`exec`\|`rw-writer`\|`rw-reader`), `key`, `gapMs`, `renewMs`, `leaseMs` | Actual-minus-expected fire time for one heartbeat. `severity:"warn"` at `gapMs > renewMs` (a full interval late); `severity:"critical"` at `gapMs > leaseMs` (the lease almost certainly lapsed). Silent below `renewMs`. |

`warn`/`critical` go to `console.warn`/`console.error` respectively; the sampler logs at `console.log`. A `critical` `heartbeat_gap` for `exec`/`rw-writer` is the breadcrumb that explains a subsequent `LockLostError`; for `rw-reader` it flags the window during which a writer could have reaped the stale reader entry and entered mid-read.

**Reading the percentiles (#168).** `p50Ms`/`p99Ms` sit at the histogram resolution (20ms) whenever the loop is healthy, and a *lone* multi-second stall does not move them: a 10s window holds ~400–500 readings, so one stall is a couple of tenths of a percent of the sample and falls above p99 by construction. `p999Ms` is the percentile that answers for a single outlier at that sample count; `maxMs` and the `event_loop_stall` line are the signals that always do. Lowering `DEFAULT_RESOLUTION_MS` makes the dilution worse, not better (more readings, a smaller share each), so it is deliberately left at 20ms — 50 libuv wakeups per second, order 1e-5 of a core.

`GET /readyz` carries the live histogram as an `eventLoop` object (`p50Ms`, `p99Ms`, `p999Ms`, `maxMs`, `meanMs`) whenever the monitor is running, so a scraper can poll the lease margin without parsing logs. The field is **absent** — not null, not zeroed — when the monitor was never started (any embed that does not boot through the entry point), so an idle loop and an unmeasured one cannot be confused. Reading it does not reset the histogram, so scraping never erases a window the sampler is about to log.

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

Reads during an exec hit these at zero latency. They may be arbitrarily stale *between* execs — that is fine because nothing reads them between execs. The authoritative epoch check refreshes them before the next request callback begins.

### L2 — Redis blob cache

- **Key:** `vfs:{tenant}:blob:{sha256hex}` → raw bytes
- **Read path:** `PostgresDialect.getBlob` → try Redis first, fall through to Postgres on miss, populate Redis on Postgres hit
- **Write path:** `PostgresDialect.upsertBlob` → write Postgres first, then `blobCache.set(sha256, data)` (fire-and-forget, no await)
- **Invalidation:** never needed — content is immutable under its sha256
- **Size cap per entry:** `REDIS_BLOB_MAX_BYTES` (default 8 MB); larger blobs bypass Redis entirely to prevent a single large file from flushing the working set
- **Eviction:** Redis `allkeys-lru` + per-key TTL (default 24 h)

### L3 — Postgres

Always the source of truth. Every mutation writes here first before any cache is updated. A cache miss at any layer falls through to Postgres.

---

## Cross-Replica Cache Coherence

`SqlFs` owns a committed view containing a bigint epoch and the path map. Every session entry holds distributed and local lifecycle locks while `ensureFresh()` opens a REPEATABLE READ transaction. The transaction reads the durable epoch. A changed epoch, a cold load, or poisoned state also loads paths from that same SQL snapshot. Only a successful transaction can replace the paired view.

An unchanged epoch avoids the recursive path scan. Each validation cohort executes BEGIN, sets the sandbox context, reads the epoch, and executes COMMIT. A mismatch adds the path query in that transaction. Concurrent readers can share a cohort only when they arrive before its SQL sample begins. Later arrivals join the next cohort, even while the earlier query is still in flight. Authority failures propagate and no callback runs with an unvalidated view.

Cold loads and recovery use the same loader. Each installed view clears content and advances its generation. Delayed blob fills must still belong to the current generation and entry. Prewarm also verifies the blob hash against the committed entry.

A writer needs no Redis notification after commit. Other replicas detect the durable epoch on their next request, including after writer process loss. A missing sandbox returns ENOENT and queues session disconnect after all local readers release. Recovery never reruns the original command. ESTALE still fences writes that lost their epoch, and applied or uncertain errors remain nonretryable.

Freshness is measured at request admission. It does not promise a continuous snapshot after a distributed lock lease is lost.

---

## Handling Multiple Concurrent Requests

### Same sandbox, same replica

The behaviour depends on whether each request is `readOnly`:

| Request A | Request B | Outcome on the same replica |
|---|---|---|
| write | write | B queues behind A at the Redis lock and at `session.lock` (exclusive). Fully serialized. |
| write | readOnly | B waits for the shared Redis lock, then acquires `session.lock` in shared mode. |
| readOnly | write | B waits for the exclusive Redis lock, then queues at `session.lock` (exclusive waits for active readers). New readers arriving after B queue behind B (writer-priority). |
| readOnly | readOnly | **Both run in parallel.** Both take `session.lock` in shared mode; the FS is in a refcounted read-only scope; any mutating syscall throws `EREADONLY` pre-DB and is remapped to HTTP 422 `EREADONLY_VIOLATION`. |

Mixed read/write inside a *single script* is always handled on the write path — `readOnly` is a caller declaration, not auto-detected. An agent that issues a script with any chance of writing must leave `readOnly` unset (defaults to false).

### Same sandbox, different replicas

If either request writes, Request B waits for Request A to release its distributed lock. Readers can hold shared locks concurrently. After acquiring its own distributed and local locks, B samples PostgreSQL and reloads the tree if A advanced the epoch.

### Different sandboxes

Locks and caches are entirely per-sandbox. Requests on different sandboxes are always fully parallel with no contention between them.

### Sandbox destruction during active exec

`DELETE /sandboxes/:id` routes through the same Redis exec lock. It cannot acquire the lock until all in-flight execs for that sandbox complete. At the DB layer, `pg_advisory_xact_lock` also serializes the destroy transaction against any stray writes.

---

## Session Lifecycle

### Creation

`getOrCreate` builds a session lazily on first access for a `(tenantId, sandboxId)` pair. It constructs the `SqlFs` instance (which loads epoch and paths in one PostgreSQL transaction), creates a `Bash` instance with the filesystem wired in, and stores the session in the in-process map. Concurrent creation requests for the same sandbox coalesce onto a single `Promise` via the `pending` map — only one `SqlFs` + `Bash` is ever constructed.

### Rehydration from cold storage

`withSessionOrRehydrate` is used by exec routes. If the session is not in the in-process map (evicted or first access on this replica), it calls `getSandboxMetaFn` to restore owner and runtime flags (python/javascript) from Postgres, then constructs a **brand new** `SqlFs` + `Bash`. There is no reuse of the old instances — they were evicted and are gone.

```
Request hits Replica B, session not in memory
  → getSandboxMetaFn(tenantId, sandboxId) → Postgres → { owner, python, javascript }
  → getOrCreate → new SqlFs + new Bash   ← full construction, not reuse
      → ready() → paired epoch and path load from Postgres
  → withSessionEntry → exec proceeds normally
```

What rehydration saves is knowing *which* owner and runtime flags to reconstruct with — the client does not need to re-specify them. It does not avoid the `SqlFs` initialization cost.



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

**Continuous cache freshness between execs.** The in-process caches are stale between execs by design. This is fine — they are only authoritative *during* an exec, after the durable epoch check has confirmed or refreshed them.

---

## Redis Key Inventory

All Redis keys are tenant-prefixed to prevent cross-tenant collisions.

| Key pattern | Type | Purpose | Written by | Read by |
|---|---|---|---|---|
| `vfs:${tenantId}:rwlock:{${sandboxId}}:writer` | string (token) | Default distributed writer lease | `withDistributedRWLock` | `withDistributedRWLock` (Lua acquire, renew, and release) |
| `vfs:${tenantId}:rwlock:{${sandboxId}}:readers` | sorted set (tokens and lease deadlines) | Default distributed shared reader leases | `withDistributedRWLock` | `withDistributedRWLock` (Lua acquire, renew, and release) |
| `vfs:${tenantId}:lock:${sandboxId}` | string (token) | Exclusive reader and writer fallback when `REDIS_RWLOCK_ENABLED=false` | `withDistributedLock` (SET NX PX) | `withDistributedLock` (Lua renew + release) |
| `vfs:{tenant}:blob:{sha256hex}` | bytes | Blob content cache — avoids Postgres round-trips for file reads | `PostgresDialect.upsertBlob` (fire-and-forget SET) | `PostgresDialect.getBlob` (GET before Postgres) |

---

## Key Source Files

| File | What it does |
|---|---|
| `src/api/session-manager.ts` | Owns the session pool, all three lock acquisitions, write + read entries (`withSession`, `withSessionRead`, `withSessionOrRehydrate`), authoritative admission, lifecycle protection, `EREADONLY` → `EREADONLY_VIOLATION` remap |
| `src/api/rw-lock.ts` | `RWLock` — hand-rolled async readers-writer lock used by `Session.lock`. Writer-priority, batch-wake for queued readers, `AbortSignal` support |
| `src/api/read-only-context.ts` | `readOnlyContext` AsyncLocalStorage — per-call violation attribution for the parallel-readOnly path |
| `src/api/ownership.ts` | `withOwnedSessionOrRehydrate` / `withOwnedSessionRead` — adds owner check inside the lock before delegating to `SessionManager` |
| `src/fs/sql-fs/sql-fs.ts` | `SqlFs` class — all `IFileSystem` methods, pathCache, contentCache, `#dirty` flag, `reload()`, refcounted `beginReadOnlyScope`/`endReadOnlyScope`, `#assertWritable` |
| `src/fs/sql-fs/dialects/postgres.ts` | Postgres dialect — `setSandboxContext` (RLS + advisory lock), blob cache read/write, all SQL |
| `src/fs/sql-fs/session-scoped-fs.ts` | `ICoherentFs` interface — `reload`, `wasDirty`, `clearDirty` |
| `src/fs/sql-fs/redis-blob-cache.ts` | Redis blob cache — `get`/`set` with TTL and size cap |
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
| Distributed state agreement | Log replication across nodes | Durable PostgreSQL epoch validation and paired path reload |
| Conflict resolution | Consensus on write order | Not needed — exec serialization prevents concurrent writes to the same sandbox |
| Partition tolerance | Quorum reads/writes | Fail closed → 503 when Redis is unreachable (CP, not AP) |

**Why this works here but wouldn't in the general case:**

The key constraint is that all writes to a sandbox are serialized through a single exec at a time (Lock 2). This collapses the consistency requirement from *continuous* (nodes must agree at all times) to *exec-boundary only* (a replica only needs a fresh view at the start of each exec). A durable epoch sampled in PostgreSQL establishes freshness at request admission. If the epoch changed, the same transaction loads the corresponding paths.

If the workload ever required two replicas to concurrently write the same sandbox, this model would break and a stronger coordination mechanism would be needed. The architecture avoids that requirement by design.

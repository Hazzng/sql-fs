# Developer guide

This guide explains how a request moves through sql-fs, how the caches and locks keep it correct, and what sql-fs does not guarantee. Read it before you change `session-manager.ts`, `sql-fs.ts` or dialect code.

Commands and coding standards are in [CLAUDE.md](CLAUDE.md). Environment variables are in [CONFIGURATION.md](CONFIGURATION.md). The reproductions for the distributed, memory and durability issues #164-#175 are in `thoughts/shared/research/2026-09-18_prod-readiness-harness.md`. Most of those failures are out of reach of a unit test or a single replica.

## Postgres is the source of truth

Everything other than Postgres is a cache or a lock.

Each replica keeps warm in-process state for every active sandbox. Before a request callback runs, the replica reads a durable epoch from Postgres and reloads its path cache if the epoch moved. Warm reads still make that round trip. Redis holds the distributed lock and an immutable blob cache.

sql-fs has no consensus protocol, and it does not need one. Postgres is the single authority and the distributed lock serializes writers, so a replica needs a fresh view only when it admits a request. If two replicas ever had to write one sandbox at the same time, this design would not hold.

The caller picks one of two exec modes:

- A write exec is the default. It takes the locks in exclusive mode and runs one at a time per sandbox. Only a write exec can change the filesystem.
- A read exec sets `readOnly: true`. It takes the locks in shared mode, so many run at once. A mutating syscall throws `EREADONLY` before it reaches the database, and the client gets HTTP 422 `EREADONLY_VIOLATION`.

sql-fs does not detect read-only scripts. If a script might write, leave `readOnly` unset.

## How a request runs

A write exec runs these steps:

1. Acquire the distributed lock in exclusive mode if Redis is configured. Then acquire `session.lock` in exclusive mode.
2. Call `SqlFs.ensureFresh()` to check the durable epoch.
3. Run the handler or script. Each SQL mutation transaction takes the advisory lock and advances the epoch. A buffered script commits its metadata in one transaction when it ends. See [Scripts commit all or nothing](#scripts-commit-all-or-nothing).
4. Refresh the session memory estimate and release both locks.

A read exec runs these steps:

1. Acquire the distributed lock in shared mode if Redis is configured. Then acquire `session.lock` in shared mode.
2. Call `SqlFs.ensureFresh()`. Readers that arrive before a check starts its SQL query share that check. Later readers wait for the next one.
3. Open the refcounted read-only scope and run the callback inside `readOnlyContext`.
4. Close the scope and release both locks.

A writer waits for active readers, and new readers wait behind a queued writer. If admission fails, the callback never runs.

## Three locks serialize access

| Lock | Scope | Held for | Catches |
|---|---|---|---|
| 1. `session.lock`, an `RWLock` from `src/api/rw-lock.ts` | One replica, one sandbox | The whole `withSession` callback | Two requests on the same replica |
| 2. The distributed lock, from `src/api/distributed-rw-lock.ts` | All replicas | The whole `withSession` callback | Requests on different replicas |
| 3. The advisory lock, `pg_advisory_xact_lock(hashtextextended(sandboxId, 0))` | The database | One transaction | Anything that gets past locks 1 and 2 |

Every exec must enter through `SessionManager.withSession`, `withSessionRead` or `withSessionOrRehydrate`. Code that writes to `SqlFs` any other way skips lock 1 and the read-only checks.

**Lock 1** is a hand-rolled async readers-writer lock, one for each `Session`. It favours writers. A queued writer blocks new readers even while other readers hold the lock. When a writer releases and readers are next in the queue, `#dispatch()` wakes all of those readers in one pass. A queued acquisition honours `AbortSignal` and rejects with `code: "ABORTED"`. An acquisition that already holds the lock does not. `destroy` and `shutdown` drain a session by taking lock 1 in exclusive mode.

**Lock 2** uses Lua scripts with token ownership and heartbeat renewal. The writer lease is at `vfs:${tenantId}:rwlock:{${sandboxId}}:writer`, and the reader leases are a sorted set at `vfs:${tenantId}:rwlock:{${sandboxId}}:readers`. The braces are Redis Cluster hash tags. If `REDIS_RWLOCK_ENABLED=false`, readers and writers both take the old exclusive lock at `vfs:${tenantId}:lock:${sandboxId}`, and reads no longer run beside writes. If Redis is configured but unreachable, acquisition fails closed with 503.

If a replica pauses for longer than the lease, another replica can take the lock. A GC pause or a blocked event loop can do that. When a heartbeat fails for certain, the replica aborts the signal it passed to the running exec. If the guarded callback had already finished, the request returns `ELOCKLOST_APPLIED`. Clients must not retry a non-idempotent write after that error without checking state first. The advisory lock and the epoch fence still reject stale mutations, but the request loses its bash-level guarantees.

**Lock 3** is transaction-scoped because the session-scoped `pg_advisory_lock` breaks without an error under transaction-mode pooling, as in pgbouncer and Neon. When nothing contends, it costs one statement per transaction.

| Scenario | Lock 1 | Lock 2 | Lock 3 |
|---|---|---|---|
| Two writes, same replica | Blocks | Redundant | Redundant |
| Two writes, different replicas | Not involved | Blocks | Backstop |
| Many reads, same replica | Shared, reads run in parallel | Shared leases | Not used |
| A read and a write, same replica | Writer goes first | Readers keep the writer out | Only the writer's transaction |
| A pause longer than the lease, then a second replica writes | Not involved | Fails | Serializes at the database |
| `DELETE /sandboxes/:id` during an exec | Drains in exclusive mode | Blocks | Backstop |
| Code that bypasses `withSession` | Not involved | Not involved | Still catches it |

When a request on another replica releases the lock, the next request checks the epoch and reloads if it changed. `DELETE /sandboxes/:id` takes the distributed lock and then drains `session.lock`, so it waits for in-flight execs. Different sandboxes share no locks and no caches.

### Lock observability

A `setTimeout` heartbeat renews every Redis lease. By default it renews every 20s and the lease lasts 60s. If the event loop stalls, the renewal fires late, Redis expires the key, and the next renewal throws `LockLostError`. Lock 3 keeps the data consistent, so a late renewal is a visibility problem, not a corruption risk. `src/api/event-loop-monitor.ts` measures the stalls and logs three events.

| Event | Logged when | Fields | What to do |
|---|---|---|---|
| `event_loop_lag` | Every `EVENT_LOOP_MONITOR_INTERVAL_MS`, default 10s | `p50Ms`, `p99Ms`, `p999Ms`, `maxMs`, `meanMs`, `windowMs` | Page when `p99Ms` or `maxMs` gets close to the 20s renew interval. |
| `event_loop_stall` | A window's `maxMs` exceeds `EVENT_LOOP_STALL_THRESHOLD_MS`, default 2000 | `severity:"critical"`, `maxMs`, `p999Ms`, `thresholdMs`, `windowMs` | Page. The Redis `commandTimeout` is 2s, so past this point Redis commands for other tenants time out (#168). |
| `heartbeat_gap` | A heartbeat fires late | `severity`, `lock` (one of `exec`, `rw-writer`, `rw-reader`), `key`, `gapMs`, `renewMs`, `leaseMs` | Severity is `warn` above `renewMs` and `critical` above `leaseMs`. At `critical`, the lease has almost certainly lapsed. |

A critical `heartbeat_gap` on `exec` or `rw-writer` explains a later `LockLostError`. On `rw-reader`, it marks a window in which a writer could have reaped the reader and started mid-read.

**Reading the percentiles (#168).** On a healthy loop, `p50Ms` and `p99Ms` sit at the 20ms histogram resolution. One multi-second stall does not move them. A 10s window holds about 400-500 readings, so a single stall lands above p99. To catch one-off stalls, watch `p999Ms`, `maxMs` and `event_loop_stall`. A lower `DEFAULT_RESOLUTION_MS` adds readings and hides a stall further, so the resolution stays at 20ms.

When the monitor runs, `GET /readyz` returns the live histogram as `eventLoop`. If the monitor never started, the field is absent rather than null or zero, so an idle loop never looks like an unmeasured one. A read of `/readyz` does not reset the histogram.

## Read execs share one filesystem safely

Three mechanisms let parallel readers share one `SqlFs`:

1. `session.lock` in shared mode keeps writers out while any reader runs.
2. The read-only scope, opened by `SqlFs.beginReadOnlyScope()` and closed by `endReadOnlyScope()`, is refcounted. While it is open, `#assertWritable` makes every mutating method throw `EREADONLY` before any database call. The mutating methods are write, append, mkdir, rm, chmod, utimes, cp, mv, symlink, link and bulk ingest. Unit tests on dialect mocks depend on this order, because a violation must open no connection.
3. `readOnlyContext`, an AsyncLocalStorage, records a violation on the current call's context instead of on the shared filesystem. A misbehaving script in reader A cannot fail reader B.

`withSessionReadEntry` turns either signal into `EREADONLY_VIOLATION`. Some builtins, notably redirections such as `echo x > f`, let a raw `EREADONLY` escape from `bash.exec`. The entry rethrows that error as `EREADONLY_VIOLATION`. If the callback succeeds but its context records a violation, the entry throws `EREADONLY_VIOLATION` after the callback. The HTTP exec routes and the MCP tools `bash_exec` and `bash_exec_batch` map the error to 422.

Read execs skip the script scope. `src/api/session-runtime/engine.ts` checks `readOnlyContext.getStore()` and opens no scope, because parallel readers would race on one scope and have nothing to commit.

If a batch request (`exec-sync-batch` or `bash_exec_batch`) sets `readOnly: true`, its scripts run in parallel under one shared lock. `MAX_BATCH_PARALLELISM = 16` in `src/api/lib/batch-exec.ts` caps the fan-out. Results keep their input order.

## Caches sit in front of Postgres

| Cache | Where | Key | Behaviour |
|---|---|---|---|
| `#pathCache` | `SqlFs`, per session | Absolute path | Loaded with the epoch in one transaction. Updated on every write. |
| `#contentCache` | `SqlFs`, per session | Inode id | LRU capped at 50 MB. Filled on the first `readFile`. Cleared for an inode on write and delete. |
| Blob cache | Redis, at `vfs:${tenantId}:blob:${sha256hex}` | Content hash | `PostgresDialect.getBlob` reads it before Postgres. The dialect fills it without waiting, after a Postgres read or a blob write. |

Postgres sits behind all three. Every miss falls through to it.

A blob cache entry never needs invalidation, because content never changes under its hash. A blob larger than `REDIS_BLOB_MAX_BYTES` (8 MB by default) skips Redis, so one large file cannot push the working set out. The blob cache lives on the data Redis in `REDIS_DATA_URL`, which falls back to `REDIS_URL`. The data Redis must use `allkeys-lru` or `allkeys-lfu`. The control Redis in `REDIS_URL` holds the exec locks and must use `noeviction`, because an evicting policy can delete a live lock. See [Redis eviction policy](CONFIGURATION.md#redis-eviction-policy).

The in-process caches can go stale between requests. Nothing reads them between requests, and `ensureFresh()` checks them before the next callback.

## Replicas check freshness at admission

`SqlFs` holds a committed view, which pairs a bigint epoch with the path map. `ensureFresh()` opens a REPEATABLE READ transaction and reads the durable epoch from the `sandbox_epochs` table (migration `0007_fence_sandbox_epochs.sql`). The same transaction loads the paths in three cases: the epoch changed, the view was never loaded, or the cache is poisoned. Only a transaction that succeeds replaces the view.

If the epoch has not changed, the check costs four statements: BEGIN, set the sandbox context, read the epoch, and COMMIT. It does not run the recursive path query. If the check fails, the error propagates and no callback runs on the unchecked view.

Each new view clears the content cache and advances a generation counter. A blob fill that arrives late must still match the current generation and path entry. Prewarm also checks each blob hash against the committed entry.

A writer sends no notification after it commits. Other replicas see the new epoch on their next request, even if the writer process died. A request for a deleted sandbox returns ENOENT, and the session disconnects after its local readers finish. Recovery never reruns the original command. `ESTALE` rejects writes from a holder whose epoch is out of date.

sql-fs measures freshness when it admits a request. After a lost lease, a script has no promise of a fixed view for the rest of its run.

## Sessions are built on demand and evicted when idle

**Creation.** `getOrCreate` builds a session the first time a `(tenantId, sandboxId)` pair is used. It constructs a `SqlFs`, which loads the epoch and paths, and a `Bash` that uses it. Concurrent requests for the same sandbox share one construction through the `pending` map.

**Rehydration.** A session can be missing from memory because the reaper evicted it or because this replica has not served the sandbox yet. Then `withSessionOrRehydrate` calls `getSandboxMetaFn` to read the owner and runtime flags from Postgres, and builds a new `SqlFs` and `Bash`. The client does not need to resend the flags. The full load still runs.

**Eviction.** A reaper runs every 60s. It evicts a session that has been idle longer than `SESSION_IDLE_MS` (600s by default), or whose path cache estimate exceeds 50 MB. It never evicts a session that has requests in flight. The next request rehydrates the session.

**Prewarm.** After the path cache loads, `SqlFs` fetches every blob for the sandbox into the content cache in one query. A cold script that reads many files then avoids one query per file. If `reload()` clears the cache while prewarm runs, `SqlFs` starts another prewarm when the first one ends.

## Scripts commit all or nothing

A write exec runs its script inside a script scope. If the script creates five files and then fails, none of the five persist. `SCRIPT_TX_BUFFERED` picks one of two implementations:

- **Buffered** is the default (`SCRIPT_TX_BUFFERED=true`, #166). Each mutation updates the caches and appends to an in-memory journal. `endScriptScope` replays the journal in one short transaction that holds the advisory lock. `commitBlob` still writes file bytes immediately. CLAUDE.md covers the rest under "Caching strategy": the caches running ahead of the database, placeholder inode ids, buffer caps, and errors at commit time.
- **Legacy** is `SCRIPT_TX_BUFFERED=false`. The first write opens a transaction that stays open until the script ends. That transaction holds a pooled connection for the whole script, and long scripts can exhaust a transaction pooler. That cost is why legacy is no longer the default.

On error, `abortScriptScope` discards the journal or rolls back the transaction, and then reloads committed state. If the reload fails, `SqlFs` marks the cache poisoned, and the next `ensureFresh()` reloads it.

The session runtime opens a script scope only if the filesystem implements `IScriptTxFs`. `SqlFs` implements it. The `InMemoryFs` used in tests does not, so those execs run without a scope.

## Worker owners run scripts off the main thread

Worker owners are off by default. If `SQL_FS_WORKERS_ENABLED=true`, Bash and `SqlFs` run in a fixed pool of worker threads from `src/api/worker-owner/`, two by default. Each worker builds its own Postgres filesystem and Redis client in `runtime.ts`. The main thread keeps a `WorkerFileSystem` proxy in the session and sends commands to the pool. The same flag turns on ingress admission in `src/api/ingress-admission.ts`, which limits in-flight requests and bytes for each replica and each tenant. Admission rules, rollout prerequisites and tuning variables are in [Worker owners](CONFIGURATION.md#worker-owners).

## Semaphores cap Python and JavaScript runs

Two semaphores on each replica cap concurrent language runtimes. A CPython WASM run costs about 80 MB, and a QuickJS run can use up to 64 MB.

| Semaphore | Slots | A request takes a slot when |
|---|---|---|
| `pythonSem` | `MAX_CONCURRENT_PYTHON`, default 5 | the session has `python: true` |
| `jsSem` | `MAX_CONCURRENT_JS`, default 5 | the session has `javascript: true` |

The session's runtime flags decide the slot, not the script text. Every exec on a sandbox with Python enabled takes a Python slot, even `ls`. A session with neither flag takes no slot. To change `python`, `javascript`, or `network` after creation, send `PATCH /v1/sandboxes/:id` or call the MCP tool `sandbox_update`. The next exec takes its slot from the new flags. Waiters run in FIFO order. `MAX_PYTHON_QUEUE` and `MAX_JS_QUEUE` cap the number of waiters. `PYTHON_QUEUE_TIMEOUT_MS` and `JS_QUEUE_TIMEOUT_MS` cap the wait, 60s by default. See [CONFIGURATION.md](CONFIGURATION.md). The caps apply per replica, so three replicas allow 15 concurrent Python execs.

## Each tenant gets its own database

To run one tenant, set `DATABASE_URL`. sql-fs registers it as the tenant `"default"`. To run several, set `TENANT_DATABASES` to a JSON map of tenant id to connection string. If both are set, `TENANT_DATABASES` wins. Each tenant gets its own database and a connection pool that sql-fs builds on first use.

The tenant comes from the JWT `tenant` claim. For example, `pnpm token:create -- --sub agent-1 --tenant acme` mints a token for the tenant `acme`. A token without the claim uses `"default"`.

The tenant id is part of the session map key (`${tenantId}:${sandboxId}`), every Redis key (`vfs:${tenantId}:...`) and every lock key. Tenants that share one Redis therefore never collide. Inside one database, RLS isolates sandboxes by `sandbox_id`.

## What sql-fs does not guarantee

**Atomicity across exec calls.** The lock covers one exec. Two calls with client logic between them leave a gap that another agent can use:

```
Agent A: exec "cat balance.txt" -> computes 50 -> exec "echo 50 > balance.txt"
Agent B:                  exec "echo 0 > balance.txt"
```

B's write lands in the gap, and A's second exec overwrites it. To avoid the gap, put the read, the computation and the write in one script:

```bash
balance=$(cat balance.txt)
echo $((balance - 50)) > balance.txt
```

**Script semantics after a lost lease.** If a replica pauses longer than `REDIS_EXEC_LOCK_LEASE_MS` (60s by default), another replica can run a script that interleaves with the paused one. Lock 3 prevents corruption, but the affected request has no bash-level guarantee.

## Redis keys

| Key | Type | Purpose |
|---|---|---|
| `vfs:${tenantId}:rwlock:{${sandboxId}}:writer` | String holding a token | Writer lease |
| `vfs:${tenantId}:rwlock:{${sandboxId}}:readers` | Sorted set of tokens scored by deadline | Reader leases |
| `vfs:${tenantId}:lock:${sandboxId}` | String holding a token | Exclusive lock when `REDIS_RWLOCK_ENABLED=false` |
| `vfs:${tenantId}:blob:${sha256hex}` | Bytes | Blob cache |

## Key source files

| File | Contents |
|---|---|
| `src/api/session-manager.ts` | Session pool, lock acquisition, the entries `withSession`, `withSessionRead` and `withSessionOrRehydrate`, admission, the reaper, the semaphores, and the `EREADONLY_VIOLATION` remap |
| `src/api/session-runtime/engine.ts` | Builds the `Bash` runtime for a session and wraps each exec in a script scope |
| `src/api/rw-lock.ts` | `RWLock`, lock 1 |
| `src/api/distributed-rw-lock.ts` | The distributed lock, lock 2 |
| `src/api/distributed-lock.ts` | The legacy exclusive lock used when `REDIS_RWLOCK_ENABLED=false` |
| `src/api/read-only-context.ts` | `readOnlyContext`, which records violations per call |
| `src/api/ownership.ts` | `withOwnedSessionOrRehydrate` and `withOwnedSessionRead`, which check the owner inside the lock |
| `src/api/worker-owner/` | Worker pool, message protocol and worker runtime |
| `src/api/event-loop-monitor.ts` | Event-loop lag sampler and `heartbeat_gap` logging |
| `src/sql-fs/sql-fs.ts` | `SqlFs`, the `ICoherentFs` and `IScriptTxFs` interfaces, the caches, `ensureFresh`, the read-only scope and the script scope |
| `src/sql-fs/script-tx-buffer.ts` | The buffered script journal and its limits |
| `src/sql-fs/session-scoped-fs.ts` | `SessionScopedFs`, the script scope wrapper that the runtime uses |
| `src/sql-fs/dialects/postgres.ts` | All SQL, the RLS context, the advisory lock, and blob cache reads and writes |
| `src/sql-fs/redis-blob-cache.ts` | Redis blob cache |
| `src/api/routes/exec.ts`, `src/api/mcp/tools.ts` | HTTP and MCP exec, which pick the read or write entry from `readOnly` |

The design record for parallel read execs is `thoughts/shared/research/2026-05-10_13-03-37_parallel-readonly-bash-exec.md`.

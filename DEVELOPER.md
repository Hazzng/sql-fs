# Developer Guide

This document covers the internal architecture — how a request flows end-to-end, how the caching layers work, how concurrent requests are serialized, and how correctness is maintained across multiple replicas. Read this before touching `session-manager.ts`, `sql-fs.ts`, or any dialect code.

---

## Mental Model

virtualFS is a **stateless HTTP server** backed by Postgres, with warm in-process state per active sandbox. The key invariant:

> **Postgres is always the source of truth. Everything else is a cache or a lock.**

In-process caches (pathCache, contentCache) exist purely for speed during a single exec. Redis exists for two things: serializing requests across replicas, and caching blob bytes to avoid Postgres round-trips. If you dropped Redis and all in-process caches, the system would still be correct — just slower.

---

## Core Data Flow: Single Exec

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
     │       if lastSeenVersion !== current
     │         → fs.reload() from Postgres
     │         → session.lastSeenVersion = current
     │
     ├─[3] Acquire session.mutex ────────────────── in-process mutex
     │       (async-mutex, per session, per replica)
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
     ├─[5] Release session.mutex
     │
     ├─[6] publishVersionIfDirty
     │       if #dirty:
     │         INCR vfs:{tenant}:ver:{sandboxId}
     │         session.lastSeenVersion = newVersion
     │         clearDirty()
     │
     └─[7] Release Redis exec lock (Lua check-and-del)
```

---

## The Three Lock Layers

Three locks work together. Each is the fallback for the one above it.

### Lock 1 — `session.mutex` (in-process)

- **Type:** `async-mutex` in the Node heap, one per `Session` object
- **Scope:** one replica, one sandbox
- **Held for:** entire `bash.exec(script)` call
- **Purpose:** prevents two concurrent requests on the *same replica* from interleaving inside `Bash` or `SqlFs`
- **Cost:** zero network — pure microtask queue

### Lock 2 — Redis exec lock (distributed)

- **Type:** `SET NX PX` with a unique token + heartbeat renewal + Lua check-and-release
- **Key:** `vfs:{tenant}:lock:{sandboxId}`
- **Scope:** entire fleet
- **Held for:** entire `withSession` callback (wraps bash.exec + pre/post logic)
- **Purpose:** only one replica runs exec for a given sandbox at a time
- **Failure mode:** if a GC pause exceeds the lease interval, the lock expires and another replica can acquire. Lock 3 catches the resulting DB-level race. This is an accepted trade-off — data integrity is preserved but script atomicity for that one request is not.
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
| Two concurrent requests, same replica, same sandbox | blocks | redundant | redundant |
| Two concurrent requests, different replicas, same sandbox | — | blocks | backstop |
| GC pause > lease; second replica interleaves DB writes | — | fails | serializes at DB layer |
| `DELETE /sandboxes/:id` races an active exec | — | blocks (routed through lock) | backstop |
| Admin/test route bypasses `withSession` | — | — | still catches |

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

Request 2 acquires the Redis lock first (or tries to), then hits the `session.mutex`. It queues behind Request 1 at the mutex level. The two requests are fully serialized — no interleaving inside `Bash` or `SqlFs`.

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

## What Is NOT Guaranteed

**Multi-step client atomicity.** Two separate `exec` calls are two separate lock acquisitions. Another request can slip in between them:

```
Agent A: exec { read state }  →  compute new state  →  exec { write state }
Agent B:                                           exec { also writes state }  ← races here
```

If you need read-modify-write atomicity, bundle the entire sequence into a single bash script. The lock is held for the full duration of one script, not across multiple requests.

**Script atomicity under pathological GC pauses.** If the Node.js GC pauses longer than the Redis lock lease (`REDIS_EXEC_LOCK_LEASE_MS`, default 60s), the lock expires, another replica can acquire, and two scripts may interleave in time. Postgres data integrity is preserved by Lock 3 — no corruption, but bash-level semantics are not guaranteed for the affected request.

**Continuous cache freshness between execs.** The in-process caches are stale between execs by design. This is fine — they are only authoritative *during* an exec, after the version check has confirmed or refreshed them.

---

## Key Source Files

| File | What it does |
|---|---|
| `src/api/session-manager.ts` | Owns the session pool, all three lock acquisitions, version check, dirty publish |
| `src/fs/sql-fs/sql-fs.ts` | `SqlFs` class — all `IFileSystem` methods, pathCache, contentCache, `#dirty` flag, `reload()` |
| `src/fs/sql-fs/dialects/postgres.ts` | Postgres dialect — `setSandboxContext` (RLS + advisory lock), blob cache read/write, all SQL |
| `src/fs/sql-fs/session-scoped-fs.ts` | `ICoherentFs` interface — `reload`, `wasDirty`, `clearDirty` |
| `src/fs/sql-fs/redis-blob-cache.ts` | Redis blob cache — `get`/`set` with TTL and size cap |
| `src/fs/sql-fs/redis-path-snapshot.ts` | Version key helpers; path snapshot (off by default) |
| `src/api/routes/exec.ts` | HTTP exec routes — funnels through `withSession` |
| `tasks/arch-redis-caching-and-locking.md` | Full design doc for the multi-replica architecture |

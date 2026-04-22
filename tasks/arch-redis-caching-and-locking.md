# Architecture: Multi-Replica Redis Caching and Locking

**Status:** Proposed
**Date:** 2026-04-22
**Depends on:** US-001 through US-088 complete (PRD phases 1–5)

## Summary

virtualfs-api today runs correctly on a single replica. This document specifies the architecture required to scale to N replicas behind an autoscaling load balancer (Azure Container Apps) **without sandbox affinity**. Two orthogonal problems are solved:

1. **Zero cold-start cost** across replicas — blob content and path trees persist in Redis so new replicas don't re-fetch from Postgres.
2. **Correctness under concurrent access** — no stale caches, no interleaved bash scripts, no DB-level data corruption.

The design rests on two deliberate simplifications:

- **Exec-only client contract.** All mutations flow through `POST /v1/sandboxes/:id/exec[-sync]`. Non-exec mutation routes (direct file API, ingest) become admin-only or deprecated.
- **No pub/sub.** Coherence is solved with a version counter and reload-on-handoff. Feasible because exec-only serialization collapses the coherence requirement from continuous to exec-boundary.

## Context

### Current single-replica design

- `SessionManager` holds a pool of warm `Bash` + `SqlFs` instances, one per active sandbox.
- Each `SqlFs` owns an in-memory `#pathCache: Map<string, PathCacheEntry>` and `#contentCache: LRUCache<bigint, Uint8Array>`, populated by `loadAllPaths` at session start.
- `session.mutex` (per-session `async-mutex`) serializes same-sandbox operations within one replica.
- Postgres is the ground truth for all persistent state.

### Why this breaks under multi-replica

- Each replica independently runs `loadAllPaths` on cold start — an expensive recursive CTE, repeated per scale-out event.
- Two replicas holding warm sessions for the same sandbox maintain independent `#pathCache`s; writes on one don't propagate to the other.
- `session.mutex` lives in the Node heap — it does not cross replica boundaries. Same-sandbox writes from different replicas race at the row level.
- `SessionManager.destroy` has a fast-path that CASCADE-deletes without any cross-replica coordination.

### Deployment constraints

- **Target:** Azure Container Apps with autoscale. Only cookie-based sticky sessions are exposed; consistent-hash routing on a URL path segment is not available.
- **Client contract:** agents interact with sandboxes exclusively through `bash.exec`. This is a deliberate narrowing — see Guarantees section for implications.
- **No new infrastructure beyond Redis.** Putting Envoy / Application Gateway in front of ACA is out of scope.

## Architecture Overview

### Request flow

```
POST /v1/sandboxes/X/exec
      │
      ▼
SessionManager.withSession(X, fn)
      │
      ▼
[1] Acquire Redis exec lock (vfs:lock:X)         ← cross-replica mutex
      │                                            (SET NX PX + heartbeat)
      ▼
[2] Version check: GET vfs:ver:X
      ├─ matches session.lastSeenVersion → cache is fresh
      └─ mismatch → fs.reload() from Redis snapshot or Postgres
      │
      ▼
[3] Acquire session.mutex                         ← in-replica mutex
      │
      ▼
[4] bash.exec(script)
      │   each SqlFs mutation:
      │     #withTx begins
      │     setSandboxContext →
      │       SET LOCAL app.sandbox_id
      │       pg_advisory_xact_lock(hash(X))      ← per-txn DB lock
      │     DB ops
      │     COMMIT (advisory lock auto-released)
      │
      ▼
[5] If writes happened: INCR vfs:ver:X
      │
      ▼
[6] Release session.mutex
      │
      ▼
[7] Release Redis exec lock (Lua check-and-del)
```

### Component responsibilities

| Component | Responsibility |
|---|---|
| L1 in-memory caches | Fast reads during an exec |
| L2 Redis blob cache | Cross-replica content dedup; cold-start speed |
| L2 Redis path snapshot (optional) | Skip `loadAllPaths` on cold start / handoff |
| L3 Postgres | Ground truth for all persistent state |
| `session.mutex` | In-replica same-sandbox serialization |
| Redis exec lock | Cross-replica same-sandbox serialization |
| `pg_advisory_xact_lock` | DB-layer backstop when above two fail |
| Redis version counter | Cross-replica cache freshness at exec boundary |

## Caching Layers

### L1: In-memory, per-session, per-replica

Unchanged from today. Lives on each replica's `SqlFs` instance.

- **`#pathCache: Map<string, PathCacheEntry>`** — full path tree, loaded via `loadAllPaths` at session start.
- **`#contentCache: LRUCache<bigint, Uint8Array>`** — up to 50 MB, LRU-evicted, keyed by `inodeId`.
- **Lifetime:** bounded by `SESSION_IDLE_MS` (default 600_000) and `pathCacheMaxBytes` (default 50 MB).
- **Authority:** source of truth for reads *during an exec* only. Between execs it may be stale (see Version Counter below).

### L2: Redis, two independent sub-caches

#### Blob cache (always-on)

- **Key:** `vfs:blob:{sha256hex}` → raw bytes.
- **Read path:** `PostgresDialect.getBlob` → Redis GET first, fall back to PG on miss, populate Redis on successful PG read.
- **Write path:** `PostgresDialect.upsertBlob` → write PG first, then Redis SET with TTL (order matters — PG is authoritative).
- **Invalidation:** none ever. Content is immutable under its sha256; a different version has a different key.
- **Eviction:** Redis `maxmemory-policy allkeys-lru` + per-key TTL (default 24 h).
- **Size cap per entry:** `REDIS_BLOB_MAX_BYTES` (default 8 MB). Larger blobs bypass Redis and go direct to PG — keeps a single large write from flushing the working set.

#### Path snapshot (optional, phase E)

- **Key:** `vfs:snap:{sandboxId}` → msgpack-encoded path tree + version stamp.
- **Read path:** `SqlFs.ready()` and `SqlFs.reload()` try Redis first, fall back to `loadAllPaths`.
- **Write path:** after `INCR vfs:ver:{sandboxId}` on exec exit, serialize current `#pathCache` and SET.
- **Invalidation:** stale snapshots are caught by version mismatch; no active invalidation needed.

Blob cache is phase A (ship first, zero correctness risk). Path snapshot is phase E (defer until measurement justifies it).

### L3: Postgres

- Authoritative data store: `inodes`, `dirents`, `blobs`, `sandboxes` tables with their existing schema.
- Read only on L1 and L2 misses.
- Every mutation writes through (CAS blobs, adjacency-list dirents).

## Locking Layers

Three locks, each at a different granularity. All three are required; each is the fallback for the one above.

### Lock 1: `session.mutex` (existing, unchanged)

- **Type:** `async-mutex` in the Node process heap.
- **Scope:** one `Mutex` per `Session` keyed by `sandboxId` in `SessionManager.sessions`.
- **Held for:** entire `fn(session)` — the whole `bash.exec()` call.
- **Protects:** same-sandbox concurrent callers within one replica from corrupting `SqlFs` / `Bash` state.
- **Crosses replicas?** No.
- **Why keep it when the Redis lock exists?** It's free (microtask-queue wait) and prevents same-replica re-entry without a Redis round-trip. Becomes effectively a no-op in steady state but stays as local defense.

### Lock 2: Redis exec lock (new)

- **Type:** `SET NX PX` with unique token + Lua check-and-release + heartbeat renewal.
- **Key:** `vfs:lock:{sandboxId}`.
- **Held for:** entire `fn(session)` callback across the fleet.
- **Protects:** cross-replica script atomicity. Only one replica runs an exec for a given sandbox at a time.
- **Crosses replicas?** Yes — this is its reason for existing.
- **Parameters (initial):**
  - Lease: `REDIS_EXEC_LOCK_LEASE_MS` (default 60_000).
  - Heartbeat: `REDIS_EXEC_LOCK_RENEW_MS` (default 20_000, must be < lease / 2).
  - Acquire timeout: `REDIS_EXEC_LOCK_ACQUIRE_TIMEOUT_MS` (default 300_000).
- **Release:** Lua script atomically checks token matches before deleting (prevents deleting a successor's lock if ours expired).
- **Failure modes:**
  - Process GC pause > (lease − renewal interval) → lease expires mid-exec → another replica can acquire. Lock 3 (PG advisory) catches resulting DB-level race; script atomicity is violated for that one request. Accepted trade-off.
  - Redis outage → fail closed (503). Mutating endpoints do not proceed without the lock.

### Lock 3: `pg_advisory_xact_lock` (new)

- **Type:** Postgres transaction-scoped advisory lock.
- **Key:** `hashtextextended(sandboxId, 0)` → bigint (64-bit keyspace).
- **Held for:** one `#withTx` transaction — milliseconds.
- **Protects:** DB data integrity when Lock 1 and Lock 2 both fail (GC pause beyond lease, process split-brain, code paths that bypass `withSession`).
- **Crosses replicas?** Yes.
- **Crucial properties:**
  - Tied to transaction lifetime. No TTL, no clock skew, no fencing concerns.
  - Automatically released on COMMIT or ROLLBACK.
  - Works with transaction-mode connection pooling — this is why `_xact_` variant is mandatory; `pg_advisory_lock` (session-scoped) would silently break on pgbouncer / Neon pooler.
- **Added to:**
  - `PostgresDialect.setSandboxContext(tx, sandboxId)` — every `#withTx` acquires it via:
    ```sql
    SELECT pg_advisory_xact_lock(hashtextextended($1, 0));
    ```
  - `PostgresDialect.deleteSandbox(tx, sandboxId)` — explicit acquisition at the top of the method, since destroy's fast-path does not call `setSandboxContext`. Without this, destroy races with active execs.

### What each lock actually catches

| Scenario | Lock 1 | Lock 2 | Lock 3 |
|---|---|---|---|
| Two same-replica callers of `withSession` for sandbox X | ✅ blocks | ✅ (redundant) | ✅ (redundant) |
| Two cross-replica execs on sandbox X | — | ✅ blocks | ✅ if they reach DB simultaneously |
| Process GC > lease; another replica interleaves DB writes | — | ❌ fails | ✅ serializes DB ops |
| `destroy` fast-path called while another replica has active exec | — | ✅ if routed through lock | ✅ at DB layer |
| Admin route bypasses `withSession` and goes direct to SqlFs | — | — | ✅ still catches |

Lock 3 is **not** the primary serializer under normal operation. It is the last line of defense for data integrity when Lock 1 or Lock 2 have a bad day. Its cost in the happy path is one extra SQL statement per txn, always uncontended.

### What none of the locks catch

- **Client-level multi-step atomicity.** If an agent makes two separate exec calls with logic in between (`exec { cat state } → compute → exec { write state }`), another agent can slip in between the calls. This is outside the service's scope. Clients requiring read-modify-write atomicity must bundle the sequence into a single bash script.
- **GC pause > lease duration.** Script atomicity is violated for the affected request; data integrity is preserved by Lock 3. Monitor and accept as rare.

## Cache Coherence: Version Counter

Replaces pub/sub entirely. Feasible because exec-only + Lock 2 collapse coherence requirement from continuous to boundary-only.

### State

- **Redis:** `vfs:ver:{sandboxId}` — monotonic bigint counter. Absent key ≡ version 0.
- **Session:** carries `lastSeenVersion: number`, initialized at session creation.
- **SqlFs:** carries a `#dirty: boolean` flag reset on exec entry, set by every mutation method.

### Protocol

**On `withSession` entry** (after Lock 2 acquired, before Lock 1):

```ts
const current = Number(await redis.get(`vfs:ver:${sandboxId}`)) || 0;
if (session.lastSeenVersion !== current) {
    await session.fs.reload();
    session.lastSeenVersion = current;
}
session.fs.clearDirty();
```

**On `withSession` exit** (after Lock 1 released, before Lock 2 released):

```ts
if (session.fs.wasDirty()) {
    session.lastSeenVersion = Number(await redis.incr(`vfs:ver:${sandboxId}`));
    // Optional phase E: also update vfs:snap:{sandboxId}
}
```

### Why this is sufficient under exec-only

1. Only one exec runs per sandbox at a time (Lock 2).
2. No replica reads sandbox state outside of an exec.
3. At the moment any exec starts, either:
   - The same replica held the previous exec → `lastSeenVersion === current` → cache is trivially fresh.
   - A different replica held it → version mismatch → `reload()` pulls fresh data.
4. Between execs, caches may be arbitrarily stale. Harmless because nothing reads them.

No subscription lifecycle. No message ordering. No missed-message safety net. No initial-subscription race.

### `SqlFs.reload()`

New method; semantics:

1. Clear `#pathCache`.
2. Clear `#contentCache` (content keyed by inodeId may be invalid after cross-replica handoff — inodes may have been replaced).
3. Re-run `dialect.loadAllPaths` (or pull `vfs:snap:{sandboxId}` from Redis if phase E is in play).
4. Repopulate `#pathCache`.

Cost: one recursive CTE on the happy path, or one Redis GET if snapshot is available. Amortized over the exec duration.

## Request Lifecycle Details

### Exec (common path)

Steps as shown in the Request Flow diagram. All routes (`/exec-sync`, `/exec` SSE) funnel through `SessionManager.withSession` and get Lock 2 + version check + Lock 1 + advisory lock for free.

### Destroy

```ts
async destroy(sandboxId: string): Promise<boolean> {
    return await withDistributedLock(redis, `vfs:lock:${sandboxId}`, async () => {
        const session = this.sessions.get(sandboxId);
        if (session !== undefined) {
            session.state = "closing";
            await session.mutex.runExclusive(async () => {
                this.sessions.delete(sandboxId);
                await this.destroySandboxFn(this.backend, sandboxId);
            });
        } else {
            await this.destroySandboxFn(this.backend, sandboxId);
        }
        await redis.del(`vfs:ver:${sandboxId}`, `vfs:snap:${sandboxId}`);
        return session !== undefined;
    });
}
```

This closes the current fast-path race (destroy on replica B while replica A has active exec). Even though `deleteSandbox` also acquires the PG advisory lock as a backstop, the Redis exec lock ensures destroy waits for the full exec, not just the current transaction.

### Cold start on a new replica

```
1. First exec request for sandbox X arrives at a replica that has no Session for X.
2. withSession acquires Redis exec lock (no contention if X is newly active).
3. getOrCreate → createSandboxFs:
     a. new PostgresDialect; connect.
     b. createSandbox txn (idempotent — catches unique violation 23505).
     c. new SqlFs({ dialect, sandboxId }).
     d. fs.ready():
        - If vfs:snap:X in Redis (phase E): deserialize, populate #pathCache, stamp lastSeenVersion.
        - Else: dialect.loadAllPaths → populate #pathCache; stamp lastSeenVersion from vfs:ver:X.
4. Session added to pool.
5. Version check (no-op on cold create, lastSeenVersion already matches).
6. Proceed with exec.
```

## Guarantees

### Guaranteed under normal operation

1. **Data integrity.** No orphan inodes, no broken FK cascades, no corrupt dirent chains. Ensured by Lock 3 + Postgres MVCC.
2. **Per-exec atomicity within a replica.** No two execs for the same sandbox interleave on the same replica. Ensured by Lock 1.
3. **Per-exec atomicity across replicas.** Only one replica runs an exec for a given sandbox at a time. Ensured by Lock 2.
4. **Cache freshness at exec entry.** A session never begins an exec observing a cache older than the latest committed write from any replica. Ensured by the version counter.
5. **Destroy ordering.** `DELETE /v1/sandboxes/X` cannot race with active execs. Ensured by routing destroy through Lock 2.

### Explicitly not guaranteed

1. **Cross-replica script atomicity under pathological pauses.** If a replica GC-pauses longer than the Redis lock lease, another replica can acquire and interleave. Lock 3 preserves DB integrity; script semantics do not. Monitored, accepted as rare.
2. **Atomicity across multiple exec calls from the same client.** Two separate exec requests are two separate lock acquisitions. Clients needing cross-call atomicity must bundle into a single script.
3. **Continuous cache freshness between execs.** A replica's cache may be arbitrarily stale between execs. Harmless under the exec-only contract.
4. **Operation during Redis outage.** Fail-closed: mutating endpoints return 503.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `REDIS_URL` | (required when caching enabled) | Redis connection string |
| `REDIS_BLOB_CACHE_ENABLED` | `true` | Master switch for blob caching |
| `REDIS_BLOB_CACHE_TTL_MS` | `86400000` | Blob cache TTL (24 h) |
| `REDIS_BLOB_MAX_BYTES` | `8388608` | Max blob size to cache (8 MB); larger blobs bypass |
| `REDIS_EXEC_LOCK_LEASE_MS` | `60000` | Exec lock lease duration |
| `REDIS_EXEC_LOCK_RENEW_MS` | `20000` | Heartbeat interval (must be < lease / 2) |
| `REDIS_EXEC_LOCK_ACQUIRE_TIMEOUT_MS` | `300000` | Max time a request waits to acquire |
| `REDIS_PATH_SNAPSHOT_ENABLED` | `false` | Phase E toggle |
| `REDIS_PATH_SNAPSHOT_TTL_MS` | `3600000` | Path snapshot TTL (1 h) |

## Failure Modes and Operational Response

| Failure | Impact | Response |
|---|---|---|
| Redis unreachable | Mutating endpoints 503 | Fail closed; circuit breaker with short retry |
| Postgres unreachable | All endpoints 503 | Existing behavior |
| GC pause > lease / 2 | Near-miss on fencing | Alert; investigate if recurring |
| GC pause > lease | Script atomicity violation for affected request | Alert; consider increasing lease if persistent |
| Redis exec lock held indefinitely (client crash mid-exec) | Other requests wait up to lease | Acquire timeout returns 503 to waiters; lease expiry releases the lock within `leaseMs` |
| Two replicas both believe they hold the lock | Lock 3 serializes DB writes; scripts may interleave | Accept; validate Redis persistence mode prevents key loss on restart |
| `pg_advisory_xact_lock` contention | Slower writes, possible brief queueing | Normal under heavy same-sandbox write load |
| Stale `lastSeenVersion` on a never-used session | First exec reloads cache | Intentional; one-time cost |

### Metrics to monitor

- Redis exec lock acquire latency (p50/p99).
- Redis exec lock contention (acquires that waited > 100 ms).
- Heartbeat failure rate (renewals that returned 0 from the Lua check).
- Node GC pause time (p99 — alert if > lease / 3).
- `loadAllPaths` latency at session creation (drives phase E decision).
- Version mismatch rate on exec entry (indicates cross-replica handoff frequency).

## Phased Implementation Plan

Each phase is independently shippable and independently valuable. Recommended order: A → B → C → D. Defer E until measured need.

### Phase A: Redis client + blob cache

- Add `REDIS_URL` env var and a shared `RedisClient` singleton.
- New `src/fs/sql-fs/redis-blob-cache.ts` with `get(sha256)` / `set(sha256, bytes)` / `has(sha256)`.
- Wire into `PostgresDialect.upsertBlob` (write-through) and `getBlob` (read-through).
- Graceful degradation: if `REDIS_URL` is unset or Redis is unreachable, log and proceed with PG-only path.
- **Independent value:** cold blob reads drop from ~10 ms + bytes transfer to ~1 ms.
- **Risk:** near zero. Content is immutable; cache can never serve wrong data.

### Phase B: PG advisory lock

- Add advisory lock acquisition to `PostgresDialect.setSandboxContext`:
  ```ts
  await tx`SELECT set_config('app.sandbox_id', ${sandboxId}, true)`;
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${sandboxId}, 0))`;
  ```
- Add same to top of `PostgresDialect.deleteSandbox`.
- No other code changes required.
- **Independent value:** cross-replica FS mutations become safe at the DB layer immediately, before any higher-level work lands.
- **Risk:** near zero. One extra SQL statement per transaction; always uncontended in single-replica deployment.

### Phase C: Redis exec lock

- New `src/api/distributed-lock.ts` with `withDistributedLock(redis, key, opts, fn)`:
  - Acquire: `SET NX PX` with retry.
  - Heartbeat: `setInterval` renewing via Lua check-and-pexpire.
  - Release: Lua check-and-del.
- Wrap `SessionManager.withSession` and `SessionManager.destroy` with the lock.
- Keep `session.mutex` nested inside.
- Fail-closed on Redis outage.
- **Independent value:** cross-replica script atomicity in the happy path; destroy races closed.
- **Risk:** moderate. Requires tests for expiry during long exec, concurrent acquire races, release after expiry.

### Phase D: Version counter + reload-on-handoff

- Add `lastSeenVersion: number` to `Session` interface.
- Add `#dirty: boolean` and `clearDirty()` / `wasDirty()` / internal `markDirty()` to `SqlFs`.
- Call `markDirty()` in every mutation method (`writeFile`, `appendFile`, `mkdir`, `rm`, `mv`, `cp`, `chmod`, `utimes`, `link`, `symlink`).
- Add `SqlFs.reload()`: clears caches, re-runs `loadAllPaths`, repopulates `#pathCache`.
- In `withSession`, between lock acquire and `runExclusive`: version check + reload if mismatch.
- In `withSession` exit: if dirty, `INCR vfs:ver:{sandboxId}` and update `lastSeenVersion`.
- **Independent value:** cross-replica cache freshness. Complete multi-replica correctness.
- **Risk:** moderate. Missing `markDirty()` on any mutation method means silently wrong version increments. Mitigated by test coverage that asserts dirty-after-mutation for each method.

### Phase E: Redis path snapshot (optional)

- New `src/fs/sql-fs/redis-path-snapshot.ts` using `@msgpack/msgpack` for serialization.
- After `INCR vfs:ver`: serialize current `#pathCache` + version stamp, SET `vfs:snap:{sandboxId}`.
- In `SqlFs.ready()` and `reload()`: try snapshot first, fall back to `loadAllPaths`.
- **Independent value:** cold-start and cross-replica handoff drop from ~tens of ms (recursive CTE) to ~single-digit ms (Redis GET + decode) for large sandboxes.
- **Risk:** low. Snapshot is always gated by the version counter; a stale snapshot is caught on the next access and reloaded.
- **When to do it:** only after measuring `loadAllPaths` latency on representative sandboxes. If p99 < 50 ms, skip.

## Out of Scope

- **Fencing tokens for Redis exec lock.** Accepted trade-off: occasional script atomicity violation under GC pause > lease. Revisit if monitoring shows > 0.01% incidence.
- **Read-only exec path.** Not currently needed. If reads become contended under head-of-line blocking, explore `pg_advisory_xact_lock_shared` + shared Redis lock variant.
- **Cross-region active-active.** Single-region only.
- **File API under multi-replica.** Current plan: deprecate `/v1/sandboxes/:id/files/*` for client traffic; keep only as admin/test endpoint. If kept, every route handler must wrap in `SessionManager.withSession` to participate in the lock hierarchy.
- **Pub/sub-based coherence.** Explicitly rejected in favor of version counter + reload-on-handoff. Pub/sub reintroduces subscription lifecycle, message ordering, and initial-sync race — all unnecessary under the exec-only contract.
- **Consistent-hash LB affinity.** Would make most of this design unnecessary, but ACA does not expose it. Revisit if deployment target changes.

## Summary Decision Table

| Decision | Choice | Rationale |
|---|---|---|
| Script atomicity across replicas | Redis exec lock wrapping `withSession` | Matches semantic of `session.mutex`; works without LB affinity |
| DB-level data integrity | `pg_advisory_xact_lock` in every `#withTx` | Transaction-tied, no fencing/TTL concerns, works with pooling |
| Same-replica serialization | Keep existing `session.mutex` | Free, catches re-entry without Redis round-trip |
| Cache coherence protocol | Version counter + reload-on-handoff | Simpler than pub/sub; exec-only makes it sufficient |
| Blob caching | Redis keyed by sha256 | Immutable; zero invalidation complexity |
| Path tree caching | L1 in-memory always; L2 Redis snapshot optional | Only add L2 if `loadAllPaths` proves slow |
| Redis outage policy | Fail closed | Availability trade for correctness; clear signal |
| Client contract | Exec-only | Enables version counter instead of pub/sub |

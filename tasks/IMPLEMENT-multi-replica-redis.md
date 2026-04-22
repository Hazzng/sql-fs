---
date: 2026-04-22
researcher: Harry.Nguyen@insightfactory.ai
task: Multi-Replica Redis Caching and Locking
tags: [implementation-plan, redis, caching, locking, multi-replica, postgres]
status: draft
last_updated: 2026-04-22
depends_on: tasks/arch-redis-caching-and-locking.md
---

# Multi-Replica Redis Caching and Locking — Implementation Plan

## Overview

Implements the architecture described in `tasks/arch-redis-caching-and-locking.md`. Scales virtualfs-api from single-replica to N replicas on Azure Container Apps without sandbox affinity. Adds a Redis-backed L2 cache (blobs + optional path snapshot), three layered locks (existing `session.mutex` + new Redis exec lock + new PG advisory lock), and a version-counter coherence protocol that replaces pub/sub.

Five phases, each independently shippable:

| Phase | Scope | Risk | Dependency |
|---|---|---|---|
| A | Redis client + blob cache | near-zero | none |
| B | PG advisory lock | near-zero | none |
| C | Redis exec lock | moderate | A |
| D | Version counter + reload-on-handoff | moderate | A, C |
| E | Redis path snapshot (optional) | low | D |

Recommended order: A → B → C → D. Defer E until measurement justifies it.

## Current State Analysis

### What exists (from PRD US-001 through US-088)

- **`src/fs/sql-fs/sql-fs.ts`** — `SqlFs` class implementing `IFileSystem`. Owns `#pathCache: Map<string, PathCacheEntry>` and `#contentCache: LRUCache<bigint, Uint8Array>` (50 MB default). Populates via `loadAllPaths` recursive CTE at `ready()`.
- **`src/fs/sql-fs/types.ts`** — `SqlDialect<Tx>` interface with ~25 methods including `upsertBlob`, `getBlob`, `setSandboxContext`, `deleteSandbox`, `loadAllPaths`.
- **`src/fs/sql-fs/dialects/postgres.ts`** — `PostgresDialect` implements `SqlDialect<postgres.TransactionSql>` using the `postgres` npm driver with tagged-template SQL. `setSandboxContext` sets `app.sandbox_id` via `set_config()`.
- **`src/fs/sql-fs/index.ts`** — `createSandboxFs` factory; `destroySandbox` top-level function.
- **`src/api/session-manager.ts`** — `SessionManager` with `sessions: Map<string, Session>`, `getOrCreate`/`withSession`/`withExistingSession`/`destroy`. Each session has `mutex: Mutex` (async-mutex). Reaper evicts idle sessions.
- **`src/api/routes/exec.ts`** — `POST /v1/sandboxes/:id/exec-sync` and `/exec` (SSE). Both use `sessionManager.withExistingSession`. Throws ENOENT if sandbox isn't in pool.
- **`src/api/routes/sandboxes.ts`** — `POST /v1/sandboxes` uses `withSession` with create options. `DELETE /:id` calls `sessionManager.destroy(id)` directly (no `withSession` wrap).
- **`src/api/server.ts`** — Hono app bootstrap, instantiates `SessionManager` with backend from env.
- **`package.json`** — Node ≥ 22, `postgres@3.4`, `lru-cache@11`, `async-mutex@0.5`. **No Redis client yet.**

### What's missing

- No Redis dependency in the project. Adding `ioredis` will be first code change.
- No shared mechanism for cross-replica coordination. All locking is in-process.
- `setSandboxContext` does not acquire any lock.
- `destroySandbox` fast-path (when session absent from local pool) is unprotected.
- `upsertBlob` / `getBlob` go direct to PG with no L2 cache layer.

### Key constraints discovered

- **Transaction-mode pooling** is mandated by `CLAUDE.md` (Neon pgbouncer-style). This dictates: we must use `pg_advisory_xact_lock` (transaction-scoped), NOT `pg_advisory_lock` (session-scoped). Session-scoped would silently break under pgbouncer.
- **`PathCacheEntry` contains `bigint` (`inodeId`) and `Uint8Array` (`contentSha256`)** — neither survives `JSON.stringify` natively. Phase E (path snapshot) requires msgpack or custom encoding.
- **Biome formatting**: tabs, 120 line width, no unused imports.
- **Coding standards** (per `CLAUDE.md`): `interface` over `type` for object shapes, `readonly` on immutable properties, explicit return types on exported functions, `Object.create(null)` for user-controlled-key objects, no raw `any`.
- **Test layout**: unit tests colocated as `*.test.ts`, integration tests under `__tests__/` or `integration/` (skip gracefully on missing DB).

## Desired End State

After all phases (A–D) are implemented:

- virtualfs-api runs correctly on N replicas behind an ACA load balancer with no sandbox affinity.
- Cross-replica script atomicity is guaranteed under normal operation (Redis exec lock).
- DB data integrity is guaranteed even under lock-lost scenarios (PG advisory lock).
- Caches on any replica are always fresh at exec entry (version counter + reload).
- Cold-start blob reads hit Redis before Postgres (blob cache).
- `SessionManager.destroy` cannot race with in-flight execs on other replicas.
- `REDIS_URL` unset or Redis unavailable at startup → application logs a warning but continues in single-replica mode (graceful degradation for Phase A); at Phase C+ the service fails closed.

Verification: end-to-end test from Phase C onward spins up 2+ replicas sharing Postgres + Redis, launches concurrent execs on the same sandbox, and asserts atomicity + coherence.

## What We're NOT Doing

These are explicitly out of scope to prevent scope creep:

- **Fencing tokens for the Redis exec lock.** Accepted trade-off: occasional script atomicity violation under GC pause > lease. Monitored, not engineered around.
- **Pub/sub-based cache coherence.** Explicitly rejected in favor of version counter + reload-on-handoff.
- **Sandbox affinity at the LB.** ACA does not expose consistent-hash routing on path segments. Revisit only if deployment target changes.
- **Read-only exec path.** Not needed under current workload.
- **File API hardening for multi-replica.** Plan: deprecate or mark admin-only. Not touched in this implementation. Any remaining file-API routes must be wrapped in `withSession` before multi-replica rollout; tracked as a follow-up.
- **Cross-region active-active.** Single-region only.
- **Redis Cluster / Sentinel support.** Single-node Redis or Azure Cache for Redis Standard tier. HA via managed Redis, not client-side.
- **MySQL / Azure SQL dialect changes.** Advisory-lock equivalents differ per dialect; V1 is Postgres-only.

## Implementation Approach

### High-level strategy

1. **Introduce Redis as an opt-in capability** in Phase A. Everything degrades gracefully when `REDIS_URL` is unset.
2. **Add the PG advisory lock in Phase B** independently. No Redis dependency. Tightens DB correctness immediately on a single replica; becomes the backstop once multi-replica is live.
3. **Layer the Redis exec lock in Phase C** on top of Phase A's client. Introduces a `withDistributedLock` helper; retrofits `SessionManager`. Tests simulate failure scenarios (expiry, contention, concurrent acquire) with a fake Redis client to avoid integration-test flakiness.
4. **Add the version counter in Phase D** after the exec lock exists, since coherence is only meaningful when script atomicity holds.
5. **Defer Phase E** (path snapshot) until metrics from Phase D show `loadAllPaths` is a real bottleneck.

### Testing strategy

- **Unit tests** mock the `SqlDialect` and Redis client interfaces. Run without any external services. Part of `pnpm test:unit`.
- **Integration tests** (skippable via `describe.skipIf`) hit real Postgres and real Redis. Run in CI under `pnpm test:integration`.
- **End-to-end tests** (new, under `src/api/__tests__/`) spin up two Hono instances sharing one Postgres + Redis, simulating 2-replica traffic. Gated behind env vars to skip when infra is unavailable.

### Rollback posture

- Each phase is independently revertible at the commit/PR granularity.
- Phase A + B are hot-deployable with zero downtime.
- Phase C requires a rolling deploy; new replicas acquire the Redis lock, old replicas don't — mixed-fleet is unsafe for 1–2 minutes per rollout. Document the risk window.
- Phase D: mixed-fleet is safe — replicas on old code simply don't bump the version counter; replicas on new code will reload more often than strictly needed (harmless).

---

## Edge Cases and Operational Gotchas

This section captures sharp edges surfaced during architecture design that are not obvious from the per-phase instructions. Missing any of these during implementation produces silent correctness bugs or operational pain later. Each item is tagged with the phase(s) where it applies.

### 1. `PathCacheEntry` serialization is not JSON-safe (Phase E)

`PathCacheEntry` has two fields that vanilla `JSON.stringify` cannot round-trip:

- `inodeId: bigint` — throws on `JSON.stringify`.
- `contentSha256: Uint8Array | null` — silently becomes `{"0": 123, "1": 234, ...}`, does not round-trip back to `Uint8Array`.

Phase E uses `@msgpack/msgpack` with manual encoding (`inodeId` as string via `String(bigint)`, `Uint8Array` via native msgpack `bin` type). **Do not attempt a JSON shortcut with a custom replacer/reviver** — sign extension on negative bigints, zero-length `Uint8Array` collapsing, and null-vs-undefined disambiguation are subtle failure modes.

Required round-trip tests (Phase E.E.2):
- `contentSha256` = zero-length `Uint8Array`.
- `contentSha256` = `null`.
- `inodeId` > `Number.MAX_SAFE_INTEGER` (e.g., `2n**62n`).
- All-null optional fields (`symlinkTarget`, `contentSha256`).

### 2. `INCR` → `SET` atomicity gap (Phase D and E)

`SessionManager.publishVersionIfDirty` does two sequential Redis operations: `INCR vfs:ver:X` and (Phase E) `SET vfs:snap:X`. Between them, a crash or network blip leaves:

- `vfs:ver:X` bumped to `v`.
- `vfs:snap:X` still showing old version `v-1` (or missing).

**Not a correctness bug** — the reader compares the snapshot's embedded version against the counter, finds the mismatch, and falls back to `loadAllPaths`. But availability suffers: other replicas pay CTE cost until a writer repopulates the snapshot.

**Mitigation:** collapse both into a single Lua script so they are atomic server-side:

```lua
-- KEYS[1] = vfs:ver:X
-- KEYS[2] = vfs:snap:X
-- ARGV[1] = serialized snapshot bytes (already containing the pre-computed new version)
-- ARGV[2] = TTL in ms
local v = redis.call('INCR', KEYS[1])
redis.call('SET', KEYS[2], ARGV[1], 'PX', ARGV[2])
return v
```

Caller pre-computes `serializedSnapshot` with `version = currentVersion + 1`, runs the script, then asserts the returned `v` matches the pre-computed one (a different value means a concurrent write slipped in, which shouldn't happen under the exec lock — treat as invariant violation).

Pragmatic alternative: accept the window, rely on the fallback. Document it in the phase D implementation notes.

### 3. Snapshot key lifecycle on destroy (Phase E)

**The implementation uses a single un-versioned snapshot key `vfs:snap:{sandboxId}` with the version embedded in the serialized value.** This is the chosen design (see E.2), not an alternative to evaluate.

Operational consequences:
- Every write `SET`s `vfs:snap:X`; prior contents are overwritten. No stale version keys accumulate.
- Destroy needs only a single `DEL vfs:snap:X` — no version enumeration required.
- The reader must **always** decode the snapshot and compare `snap.version` to `GET vfs:ver:X` before trusting it. Mismatch → treat as miss and fall back to `loadAllPaths`.

**This does not affect the versioning system.** `vfs:ver:{sandboxId}` remains the single source of truth for "what version is this sandbox at." The snapshot's embedded version is a freshness tag on cached data, not a parallel version authority.

Required reader pattern (make this explicit when implementing Phase E.3 in `SqlFs.ready()` / `reload()`):

```ts
const currentVersion = this.#redis
    ? Number(await this.#redis.get(`vfs:ver:${this.#sandboxId}`)) || 0
    : 0;

if (this.#pathSnapshot && this.#redis) {
    const snap = await this.#pathSnapshot.read(this.#sandboxId);
    if (snap && snap.version === currentVersion) {
        const fresh = new Map<string, PathCacheEntry>();
        for (const [p, e] of snap.entries) fresh.set(p, e);
        this.#pathCache.clear();
        for (const [p, e] of fresh) this.#pathCache.set(p, e);
        this.#contentCache.clear();
        return;
    }
    // snapshot missing or stale → fall through to loadAllPaths
}

// existing loadAllPaths path
```

**Freshness check must be strict equality (`===`).** If a writer crashed between `INCR` and `SET`, the snapshot's embedded version can be ahead of the counter (writer pre-computed `currentVersion + 1`). Any non-equal comparison falls back to the DB — the counter is authoritative.

### 4. Memory budgeting (Phase E)

Serialized snapshot size, rough:

- Avg path length: ~50 bytes.
- `PathCacheEntry` msgpack-encoded: ~60 bytes.
- Per entry: ~110 bytes.

Scale: 10k paths ≈ 1.1 MB, 50k ≈ 5.5 MB, 100k ≈ 11 MB. Redis's 512 MB value limit is not a practical ceiling, but:

- Total snapshot memory budget: `N active sandboxes × avg snapshot size`. Budget `maxmemory` ≥ 2 × (blob cache + snapshots + locks + counters). For 1000 active sandboxes, reserve at least 1 GB.
- `SET` operations ≥ 10 MB briefly stall Redis's event loop. Monitor `latency-monitor-threshold` and add it to the alerts list.
- `allkeys-lru` eviction silently drops cold snapshots — harmless (falls back to CTE) but cascades into Postgres load if many snapshots evict at once.

### 5. Thundering herd on cold Redis (Phase D reload, amplified in Phase E)

Scenario: Redis restarts, or a popular sandbox's snapshot evicts. `N` replicas simultaneously:

1. `GET vfs:ver:X` → v
2. `GET vfs:snap:X` → miss (or stale)
3. `loadAllPaths` from Postgres
4. `SET vfs:snap:X` back

`N` parallel recursive CTEs for one sandbox. Under Redis cold-start or pressure-eviction, this cascades to noticeable PG load.

**Per-replica mitigation — single-flight on reload:**

```ts
// SessionManager new field:
private readonly pendingReloads: Map<string, Promise<void>> = new Map();

private async ensureFreshCache(sandboxId: string, session: Session): Promise<void> {
    if (!this.redis) return;
    const current = Number(await this.redis.get(SessionManager.versionKey(sandboxId))) || 0;
    if (session.lastSeenVersion === current) {
        (session.fs as ICoherentFs).clearDirty();
        return;
    }
    let inFlight = this.pendingReloads.get(sandboxId);
    if (!inFlight) {
        inFlight = (session.fs as ICoherentFs).reload().finally(() => {
            this.pendingReloads.delete(sandboxId);
        });
        this.pendingReloads.set(sandboxId, inFlight);
    }
    await inFlight;
    session.lastSeenVersion = current;
    (session.fs as ICoherentFs).clearDirty();
}
```

This mirrors the existing `SessionManager.pending` single-flight pattern used for session creation. Cross-replica herds are harder to prevent without leader election — accepted; monitor `vfs.sql_fs.load_all_paths_duration_ms` for sandboxes with persistent concurrent spikes.

### 6. Reload atomicity in `SqlFs` (Phase D)

The draft `reload()` in D.1 (`#pathCache.clear()` → `this.ready()`) has a subtle failure mode: if `ready()` throws after `#pathCache.clear()`, the session's cache is empty and `lastSeenVersion` is still stale. Every subsequent read on that session returns `ENOENT` until the next exec forces another reload attempt.

**Fix — build the new state before swapping:**

```ts
async reload(): Promise<void> {
    const fresh = await this.#loadFreshPathCache(); // can throw, does NOT touch #pathCache
    this.#pathCache.clear();
    for (const [p, e] of fresh) this.#pathCache.set(p, e);
    this.#contentCache.clear();
    this.#dirty = false;
}

async #loadFreshPathCache(): Promise<Map<string, PathCacheEntry>> {
    const result = new Map<string, PathCacheEntry>();
    // Try Redis snapshot first (Phase E), else dialect.loadAllPaths.
    // Populate into `result`; never touch #pathCache here.
    // ...
    return result;
}
```

`ready()` should be refactored to use `#loadFreshPathCache()` too, so the "failure leaves cache unchanged" invariant holds uniformly. Update Phase D.1's `reload()` sketch accordingly during implementation.

### 7. Debugging state is a four-way lookup (all phases)

Questions like "why does this file appear missing?" require consulting:

1. **Postgres** — authoritative `inodes` / `dirents` / `blobs` rows.
2. **`vfs:ver:{sandboxId}`** — what version Redis is advertising.
3. **`vfs:snap:{sandboxId}`** (Phase E) — cached contents and its embedded version.
4. **`session.lastSeenVersion`** on each replica with a warm session — what that replica currently believes.

Invest up front in a debug CLI under `src/api/cli/debug-sandbox.ts` alongside `gc.ts`:

```
pnpm debug:sandbox <sandboxId>
  # Prints:
  #   PG:    inode count, dirent count, root inode id
  #   Redis: vfs:ver:X
  #   Redis: vfs:snap:X — decoded embedded version, entry count, approx size
  #   Redis: vfs:lock:X (if held, token + expiry)
```

Add during Phase D (when the four-way state first exists). Skipping this will cost more time in the first production incident than building it costs.

### 8. Schema version tag on serialized snapshots (Phase E)

If `PathCacheEntry` ever gains a field (e.g., `atime`, ACL bits, extended metadata), all existing snapshots become incompatible. Without a schema-version guard, a deploy that changes the entry shape silently corrupts reads on warm replicas until snapshots expire via TTL.

Add in `redis-path-snapshot.ts`:

```ts
const SNAPSHOT_SCHEMA_VERSION = 1;

interface Snapshot {
    readonly schemaVersion: number;
    readonly version: number;
    readonly entries: readonly EncodedEntry[];
}

// In write():
const snap: Snapshot = { schemaVersion: SNAPSHOT_SCHEMA_VERSION, version, entries };

// In read():
const snap = decode(buf) as Snapshot;
if (snap.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) return null; // treat as miss
```

Bump `SNAPSHOT_SCHEMA_VERSION` on any change to `EncodedEntry` or `Snapshot` shape. Anticipate a one-time cold-start penalty after such a deploy — briefly, snapshot hit rate drops to zero while caches rebuild via `loadAllPaths`. Harmless but worth noting in release notes.

### 9. Redis client specifics (Phase A onward)

- **Binary mode:** use `client.getBuffer(key)`, not `client.get(key)`, for msgpack or raw-byte values. `get` returns a UTF-8 string and corrupts binary bytes.
- **Offline queue** (ioredis default): leave enabled. Smooths brief Redis disconnects without surfacing errors to the request path.
- **`maxRetriesPerRequest: 3`** (already in A.2): caps waits during Redis outages so request paths don't stall indefinitely.
- **One client per process:** `ioredis` multiplexes commands over a single connection. Do not instantiate a client per request.
- **Version-counter TTL** (Phase D): add `EXPIRE vfs:ver:X` on write (e.g., 7 days sliding). Phase D.2 explicitly DELs on destroy, but TTL is defense-in-depth for missed cleanup — prevents counter keys accumulating for sandboxes that were destroyed without going through `SessionManager.destroy` (e.g., force-deleted from the DB out-of-band).

### Cross-reference checklist

Before completing each phase, re-read the items tagged with that phase and tick them off against the code changes.

| Item | Phases |
|---|---|
| 1. `PathCacheEntry` serialization correctness | E |
| 2. `INCR` → `SET` atomicity gap | D, E |
| 3. Snapshot key lifecycle + strict version check | E |
| 4. Memory budgeting for Redis | E |
| 5. Thundering herd / single-flight reload | D, E |
| 6. Reload atomicity in `SqlFs` | D |
| 7. Debug CLI (`pnpm debug:sandbox`) | All (land during D) |
| 8. Schema version tag on snapshots | E |
| 9. Redis client specifics | A, C, D, E |

---

## Phase A: Redis Client + Blob Cache

### Phase A: Overview

Add `ioredis` as a dependency, expose a shared `RedisClient` singleton, and wire a content-addressable blob cache into `PostgresDialect.upsertBlob` / `getBlob`. Zero correctness risk — blobs are immutable under their sha256, so the cache cannot serve wrong data.

**Independent value:** cold blob reads on any replica drop from ~PG round-trip + bytes-transfer to ~1 ms Redis GET. Deduplicates content globally across sandboxes.

### Phase A: Files and Changes

#### A.1. Add `ioredis` dependency

**File**: `package.json`

Add to `dependencies`:

```json
"ioredis": "^5.4.0"
```

Run `pnpm install`. Commit `pnpm-lock.yaml`.

**Rationale for `ioredis` over `redis` (node-redis):** better TypeScript types out of the box, mature `eval`/`evalsha` API for Lua scripting (needed in Phase C), widely used in production Node services at scale.

#### A.2. Redis client singleton

**File**: `src/redis/client.ts` (new)

```ts
/**
 * Shared Redis client singleton. Lazy-initialized from REDIS_URL.
 * Returns undefined if REDIS_URL is unset — callers handle graceful degradation.
 */

import Redis, { type RedisOptions } from "ioredis";

let client: Redis | undefined;
let initialized = false;

export interface RedisConfig {
	readonly url: string;
	readonly options?: RedisOptions;
}

/**
 * Returns the shared Redis client, or undefined if REDIS_URL is unset.
 * The first call initializes the connection; subsequent calls return the cached instance.
 */
export function getRedisClient(): Redis | undefined {
	if (initialized) return client;
	initialized = true;

	const url = process.env.REDIS_URL;
	if (!url) {
		console.log(JSON.stringify({ event: "redis_disabled", reason: "REDIS_URL not set" }));
		return undefined;
	}

	client = new Redis(url, {
		lazyConnect: false,
		maxRetriesPerRequest: 3,
		enableReadyCheck: true,
		// Exponential backoff for reconnection; capped at 30s
		retryStrategy: (times) => Math.min(1000 * 2 ** times, 30_000),
	});

	client.on("error", (err) => {
		console.error(JSON.stringify({ event: "redis_error", error: err.message }));
	});
	client.on("connect", () => {
		console.log(JSON.stringify({ event: "redis_connect" }));
	});

	return client;
}

/** Closes the Redis client. Intended for test teardown and graceful shutdown. */
export async function disconnectRedis(): Promise<void> {
	if (client) {
		await client.quit();
		client = undefined;
		initialized = false;
	}
}

/** Resets the singleton state. Test-only helper. */
export function __resetRedisForTests(): void {
	client = undefined;
	initialized = false;
}
```

#### A.3. Redis blob cache

**File**: `src/fs/sql-fs/redis-blob-cache.ts` (new)

```ts
/**
 * Content-addressable blob cache in Redis.
 * Keyed by sha256; values are raw bytes. Immutable — no invalidation needed.
 */

import type Redis from "ioredis";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 h
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024; // 8 MB

export interface RedisBlobCacheOptions {
	readonly ttlMs?: number;
	readonly maxBytes?: number;
	readonly enabled?: boolean;
}

export class RedisBlobCache {
	readonly #client: Redis;
	readonly #ttlMs: number;
	readonly #maxBytes: number;
	readonly #enabled: boolean;

	constructor(client: Redis, opts: RedisBlobCacheOptions = {}) {
		this.#client = client;
		this.#ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
		this.#maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
		this.#enabled = opts.enabled ?? true;
	}

	static key(sha256: Uint8Array): string {
		return `vfs:blob:${Buffer.from(sha256).toString("hex")}`;
	}

	async get(sha256: Uint8Array): Promise<Uint8Array | null> {
		if (!this.#enabled) return null;
		try {
			const buf = await this.#client.getBuffer(RedisBlobCache.key(sha256));
			return buf ? new Uint8Array(buf) : null;
		} catch (err) {
			console.error(JSON.stringify({ event: "redis_blob_get_error", error: (err as Error).message }));
			return null; // Fail open on read — fall back to Postgres
		}
	}

	async set(sha256: Uint8Array, data: Uint8Array): Promise<void> {
		if (!this.#enabled) return;
		if (data.byteLength > this.#maxBytes) return; // skip blobs larger than cap
		try {
			await this.#client.set(RedisBlobCache.key(sha256), Buffer.from(data), "PX", this.#ttlMs);
		} catch (err) {
			console.error(JSON.stringify({ event: "redis_blob_set_error", error: (err as Error).message }));
			// Fail open on write — PG is authoritative
		}
	}
}
```

#### A.4. Wire blob cache into `PostgresDialect`

**File**: `src/fs/sql-fs/dialects/postgres.ts`

Changes:

1. Add optional `blobCache` constructor parameter.
2. Update `upsertBlob` to write through to Redis after successful PG insert.
3. Update `getBlob` to read Redis first, fall back to PG.

```ts
// At top of class:
readonly #blobCache: RedisBlobCache | undefined;

constructor(connectionString: string, blobCache?: RedisBlobCache) {
	this.connectionString = connectionString;
	this.#blobCache = blobCache;
}

// Replace existing upsertBlob:
async upsertBlob(tx: PgTx, sha256: Uint8Array, data: Uint8Array): Promise<void> {
	await tx`
		INSERT INTO blobs (sha256, data, size)
		VALUES (${sha256}, ${data}, ${data.length})
		ON CONFLICT (sha256) DO NOTHING
	`;
	// Populate Redis AFTER successful PG commit (best-effort; PG is authoritative)
	if (this.#blobCache) {
		// Note: deferred until after the outer txn commits would be cleaner, but the postgres driver
		// doesn't expose a post-commit hook. Acceptable: the Redis write races slightly ahead of commit,
		// but ON CONFLICT DO NOTHING makes this idempotent.
		await this.#blobCache.set(sha256, data);
	}
}

// Replace existing getBlob:
async getBlob(tx: PgTx, sha256: Uint8Array): Promise<Uint8Array | null> {
	if (this.#blobCache) {
		const cached = await this.#blobCache.get(sha256);
		if (cached !== null) return cached;
	}
	const rows = await tx<{ data: Buffer }[]>`SELECT data FROM blobs WHERE sha256 = ${sha256}`;
	const data = rows[0]?.data;
	if (!data) return null;
	const bytes = new Uint8Array(data);
	if (this.#blobCache) {
		await this.#blobCache.set(sha256, bytes);
	}
	return bytes;
}
```

Imports to add at top of file:
```ts
import type { RedisBlobCache } from "../redis-blob-cache.js";
```

#### A.5. Wire blob cache into `createSandboxFs`

**File**: `src/fs/sql-fs/index.ts`

```ts
// At top:
import { getRedisClient } from "../../redis/client.js";
import { RedisBlobCache } from "./redis-blob-cache.js";

// Replace the postgres branch of createSandboxFs:
case "postgres": {
	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl) {
		throw new Error("DATABASE_URL environment variable is required for the postgres backend");
	}

	const redis = getRedisClient();
	const blobCacheEnabled = process.env.REDIS_BLOB_CACHE_ENABLED !== "false";
	const blobCache = redis && blobCacheEnabled
		? new RedisBlobCache(redis, {
			ttlMs: Number(process.env.REDIS_BLOB_CACHE_TTL_MS ?? 24 * 60 * 60 * 1000),
			maxBytes: Number(process.env.REDIS_BLOB_MAX_BYTES ?? 8 * 1024 * 1024),
		})
		: undefined;

	const dialect = new PostgresDialect(databaseUrl, blobCache);
	await dialect.connect();
	// ... rest unchanged ...
}
```

Apply the same change to the postgres branch of `destroySandbox` (but blobCache is not needed there — destroy doesn't call upsertBlob/getBlob).

### Phase A: Testing

#### Unit tests

**File**: `src/fs/sql-fs/redis-blob-cache.test.ts` (new)

- Mock `ioredis` with an in-memory map.
- Test cases:
  - `get` returns `null` when key is absent.
  - `set` followed by `get` returns the same bytes.
  - `set` skips blobs larger than `maxBytes`.
  - `get` returns `null` on Redis error (fail open).
  - `set` swallows Redis errors (fail open).
  - `enabled: false` makes both `get` and `set` no-op.

#### Integration tests

**File**: `src/fs/sql-fs/integration/redis-blob-cache.integration.test.ts` (new)

- Skip unless `REDIS_URL` and `DATABASE_URL` both set.
- Test cases:
  - Write a blob via `upsertBlob`; verify Redis key exists with correct bytes.
  - Clear Redis; call `getBlob` against a PG-only blob; verify Redis is backfilled after the call.
  - Write a blob larger than `maxBytes`; verify Redis does not cache it.
  - Write, then stop Redis container, then `getBlob` — verify it falls back to PG without error.

### Phase A: Success Criteria

#### Automated verification

- [x] `pnpm typecheck` passes.
- [x] `pnpm lint` passes.
- [x] `pnpm test:unit` passes (new blob-cache tests included).
- [x] `pnpm test:integration` passes when `REDIS_URL` and `DATABASE_URL` are set.
- [x] `pnpm build` produces a working `dist/` that runs with and without `REDIS_URL`.

#### Manual verification

- [x] Start the server with `REDIS_URL` unset — logs `redis_disabled`, all file operations still work.
- [x] Start with `REDIS_URL` set — logs `redis_connect`, write a file, confirm `vfs:blob:*` key appears in `redis-cli KEYS vfs:blob:*`.
- [x] Restart the server, read the same file — verified via integration test `getBlob backfills Redis after a cache miss` (session pool is in-memory only, so direct restart-read via API is not feasible; the integration test exercises the same `dialect.getBlob` Redis-miss → PG → backfill path the API would hit after `contentCache` LRU eviction).

### Phase A: Rollback

Revert the PR. No schema changes, no data migration, no environmental state to clean up.

### Phase A: Discoveries and Notable Information

**Technical Discoveries:**
- `ioredis@5.10.1` (latest on the `^5.4.0` range) is CJS-only. Under our `module: "NodeNext"` TS config, the default import form `import Redis from "ioredis"` fails with `This expression is not constructable` and `Cannot use namespace 'Redis' as a type`. Use the named import `import { Redis } from "ioredis"` instead — the package also exports it as a named class binding. Do the same in type-only imports (`import type { Redis } from "ioredis"`).
- `RedisBlobCache` keeps its `Redis` dependency as a **value** via a private field, but the type annotation uses the named interface-like type. The previous default-import pattern would also have failed here.

**Implementation Adaptations:**
- Integration test `redis-blob-cache.integration.test.ts` is gated on **both** `REDIS_URL` *and* `DATABASE_URL` via a single `SKIP` constant, since it exercises the full `PostgresDialect + RedisBlobCache` path and neither dependency alone is sufficient.
- The "Redis down mid-flight" integration case connects to `127.0.0.1:1` with `retryStrategy: () => null` and `maxRetriesPerRequest: 0`, so the test fails fast without waiting on real retries. An `'error'` listener is attached to swallow the unavoidable "connection refused" events.

**Future Considerations:**
- Phase B will add the `withPgAdvisoryLock` helper on `PostgresDialect`. The constructor already carries the optional blob cache — extend the signature carefully so we don't break call sites.
- Session manager integration (`createSandboxFs`) reads four env vars (`REDIS_URL`, `REDIS_BLOB_CACHE_ENABLED`, `REDIS_BLOB_CACHE_TTL_MS`, `REDIS_BLOB_MAX_BYTES`). If Phase C/D adds more, consider centralising Redis-related env parsing in `src/redis/config.ts`.
- No call site needed changes in `destroySandbox` — it only deletes the sandbox row, which cascades via FKs without touching blobs.
- **Session rehydration gap (surfaced during manual E2E verification):** HTTP routes use `withExistingSession`, which requires the sandbox to be in the `SessionManager` in-memory pool. After a server restart the pool is empty, so `GET /v1/sandboxes/:id/files/...` returns ENOENT for sandboxes created before the restart. This is pre-existing behaviour (not caused by Phase A) but blocks the most natural manual repro of Redis backfill via the API. It will matter for multi-replica scaling in Phase D — we need either a rehydration path (on-demand `createSandboxFs` when a session miss collides with a known sandbox in PG) or sticky routing. Integration tests currently cover the backfill path directly.
- **Phase A side-benefit:** wrapping `getBlob`'s PG `Buffer` result in `new Uint8Array(data)` happens to fix 3 pre-existing `toEqual` comparison failures in `src/fs/sql-fs/integration/postgres.test.ts` (`getInode` / `loadAllPaths` tests compared raw PG Buffers to typed arrays). Main still has 2 similar failures in unrelated paths (`updateInode` returns, path-cache entry round-trip); those pre-date Phase A and are noted for a separate cleanup.

---

## Phase B: PG Advisory Lock

### Phase B: Overview

Add `pg_advisory_xact_lock(hashtextextended(sandboxId, 0))` acquisition to `PostgresDialect.setSandboxContext` and to the top of `PostgresDialect.deleteSandbox`. Makes cross-replica DB mutations safe at the row level even before any other multi-replica work lands. Catches destroy races at the DB layer.

**Independent value:** immediately hardens DB correctness. Uncontended in single-replica mode (costs ~microseconds per txn). Becomes the last-line-of-defense backstop once Phase C lands.

### Phase B: Files and Changes

#### B.1. `setSandboxContext`

**File**: `src/fs/sql-fs/dialects/postgres.ts`

```ts
async setSandboxContext(tx: PgTx, sandboxId: string): Promise<void> {
	await tx`SELECT set_config('app.sandbox_id', ${sandboxId}, true)`;
	// Cross-replica write serialization at the DB layer.
	// Transaction-scoped; auto-released on COMMIT/ROLLBACK.
	// Works with transaction-mode pooling (Neon/pgbouncer) — session-scoped would not.
	await tx`SELECT pg_advisory_xact_lock(hashtextextended(${sandboxId}, 0))`;
}
```

#### B.2. `deleteSandbox`

**File**: `src/fs/sql-fs/dialects/postgres.ts`

`deleteSandbox` runs inside a transaction but does NOT call `setSandboxContext`. Add the lock explicitly at the top so destroy races are caught at the DB layer.

```ts
async deleteSandbox(tx: PgTx, sandboxId: string): Promise<void> {
	// Acquire advisory lock before any destructive SQL so in-flight writes
	// (from other replicas or code paths that bypass withSession) serialize first.
	await tx`SELECT pg_advisory_xact_lock(hashtextextended(${sandboxId}, 0))`;
	await tx`DELETE FROM sandboxes WHERE id = ${sandboxId}`;
}
```

#### B.3. Docstring / comment updates

**File**: `src/fs/sql-fs/types.ts`

Update the doc comment on `setSandboxContext` to reflect the new behavior:

```ts
/**
 * Sets the per-transaction sandbox context so RLS policies and stored procedures
 * can scope queries to the current sandbox, and acquires a per-sandbox advisory lock
 * (pg_advisory_xact_lock) so cross-replica writers serialize at the DB layer.
 *
 * The advisory lock is transaction-scoped — automatically released on COMMIT/ROLLBACK.
 * Compatible with transaction-mode connection pooling (pgbouncer, Neon pooler).
 */
setSandboxContext(tx: Tx, sandboxId: string): Promise<void>;
```

### Phase B: Testing

#### Unit tests

**File**: `src/fs/sql-fs/dialects/postgres.advisory-lock.test.ts` (new)

Mock `postgres.TransactionSql` and assert:
- `setSandboxContext` invokes the advisory-lock SQL once per call.
- `deleteSandbox` invokes the advisory-lock SQL at the top (before DELETE).

These are mostly assertions on SQL-string composition to catch regressions.

#### Integration tests

**File**: `src/fs/sql-fs/integration/advisory-lock.integration.test.ts` (new)

Skip unless `DATABASE_URL` set. Test cases:

1. **Concurrent writers block**: two `#withTx` transactions on the same sandboxId; one holds for 500 ms, verify the other's `pg_advisory_xact_lock` blocks for ≥ 400 ms.
2. **Different sandboxes do not block**: two `#withTx` transactions on different sandboxIds run concurrently; both finish within ~100 ms.
3. **Destroy-vs-write race**: one txn writing, another calling `deleteSandbox` on the same sandbox — destroy blocks until the writer commits.
4. **Lock released on error**: writer throws inside `#withTx`; verify the second txn's lock acquisition proceeds after the rollback.

Use `pg_locks` view in a third connection to inspect lock state during the test (optional but useful for debugging).

### Phase B: Success Criteria

#### Automated verification

- [x] `pnpm typecheck` passes.
- [x] `pnpm lint` passes.
- [x] `pnpm test:unit` passes (329 tests, including 4 new `postgres.advisory-lock.test.ts` cases).
- [x] `pnpm test:integration` passes with the new advisory-lock tests (4/4 pass against docker `pg-test`).
- [x] Existing `sql-fs` integration tests still pass — 40 pass, 2 pre-existing Buffer/Uint8Array `toEqual` failures documented in Phase A discoveries remain (unrelated to Phase B).

#### Manual verification

- [x] External `psql` transaction holding `pg_advisory_xact_lock(hashtextextended('<sandboxId>', 0))` blocks a concurrent API `PUT /v1/sandboxes/:id/files/...` write for ≥ the remaining hold time (observed 1.92 s while holder slept 3 s), and the lock appears in `pg_locks` as `advisory / ExclusiveLock / granted=t` and disappears on COMMIT.
- [ ] Benchmark a single-replica workload before and after Phase B. Write p99 should be within ~1 ms of pre-Phase-B; zero contention expected. _(Deferred — not gated on Phase B merge; single-replica uncontended cost is microseconds.)_

### Phase B: Rollback

Revert the PR. No data changes. Lock state is process-local and clears on disconnect.

### Phase B: Discoveries and Notable Information

**Technical Discoveries:**
- `pg_locks` exposes the advisory lock as two 32-bit ints (`classid` = upper 32 bits, `objid` = lower 32 bits of the bigint key). Casting the key directly to `int` for filtering fails with `integer out of range`; manual diagnostics should either filter by `locktype='advisory'` alone or compare the reconstructed `(classid::bigint << 32) | objid::bigint`. The dialect code is unaffected — `postgres.js` passes the bigint through the parameter binding correctly.
- Confirmed end-to-end through the real HTTP API, not just the dialect: `POST /v1/sandboxes/:id/files/...` serializes against an external `psql` session holding the same advisory key, proving there's no write path that bypasses `setSandboxContext`.

**Implementation Adaptations:**
- Integration test uses three separate `PostgresDialect` instances (and therefore three independent `postgres` Sql pools) for writer/destroyer/observer so the concurrent transactions do not share a connection and actually contend on the advisory lock at the DB level. Sharing a single pool would have let `postgres.js` queue the second `begin` behind the first on the same physical connection, masking the lock behaviour.
- `deleteSandbox` test seeds an actual sandbox via `createSandbox` before racing destroy-vs-write — otherwise there is no inode tree to make the "writer" side realistic. `createSandbox` goes through its own `setSandboxContext`-free path (creating the sandbox row plus root inode), so the seeding itself does not contend.
- Timeout-wrapped (`timed(...)`) every concurrent promise so a regression surfaces as a diagnostic test failure instead of a hung vitest runner.

**Future Considerations:**
- Phase C's Redis exec lock will sit above this (in-process mutex → Redis lock → PG advisory lock). With Phase B in place, accidentally bypassing the Redis lock still cannot corrupt DB state — it only loses the cross-replica coalescing benefit. This matches the plan's "backstop" framing.
- The two pre-existing `toEqual` Buffer/Uint8Array failures in `src/fs/sql-fs/integration/postgres.test.ts` (`updateInode` RETURNING and loadAllPaths file-inode path) remain — cleanup is out-of-scope for B and not caused by the advisory-lock changes.
- Bench baseline was not collected; the single-replica uncontended cost of `pg_advisory_xact_lock` is on the order of microseconds, and the team can collect this with the existing `pnpm bench:sql-fs-cache` harness if a number is required for the PR.

---

## Phase C: Redis Exec Lock

### Phase C: Overview

Add a distributed mutex wrapping `SessionManager.withSession`, `withExistingSession`, and `destroy`. Uses `SET NX PX` with a unique token, Lua-based atomic release, and a heartbeat timer that renews the lease. Makes cross-replica script atomicity a normal-operation guarantee.

**Independent value:** closes the destroy-vs-exec race and the concurrent-exec-across-replicas race. Required before Phase D adds meaningful value.

### Phase C: Files and Changes

#### C.1. Distributed lock helper

**File**: `src/api/distributed-lock.ts` (new)

```ts
/**
 * Redis-backed distributed mutex. SET NX PX with unique token, Lua atomic release,
 * heartbeat renewal during long-running operations.
 */

import type Redis from "ioredis";
import crypto from "node:crypto";

const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
	return redis.call("del", KEYS[1])
else
	return 0
end`;

const RENEW_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
	return redis.call("pexpire", KEYS[1], ARGV[2])
else
	return 0
end`;

export interface DistributedLockOptions {
	readonly leaseMs: number;
	readonly renewMs: number;
	readonly acquireTimeoutMs: number;
	readonly acquireRetryMs: number;
}

const DEFAULTS: DistributedLockOptions = {
	leaseMs: 60_000,
	renewMs: 20_000,
	acquireTimeoutMs: 300_000,
	acquireRetryMs: 50,
};

export class LockAcquireTimeoutError extends Error {
	readonly code = "ELOCKTIMEOUT";
	constructor(key: string) {
		super(`ELOCKTIMEOUT: could not acquire lock ${key} within timeout`);
	}
}

export class LockLostError extends Error {
	readonly code = "ELOCKLOST";
	constructor(key: string) {
		super(`ELOCKLOST: lock ${key} was lost during operation (lease expired or heartbeat failed)`);
	}
}

/**
 * Runs `fn` while holding the distributed lock `key`.
 * Throws LockAcquireTimeoutError if the lock cannot be acquired within the configured timeout.
 * Throws LockLostError if the heartbeat fails to renew during execution.
 */
export async function withDistributedLock<T>(
	redis: Redis,
	key: string,
	fn: () => Promise<T>,
	opts: Partial<DistributedLockOptions> = {},
): Promise<T> {
	const { leaseMs, renewMs, acquireTimeoutMs, acquireRetryMs } = { ...DEFAULTS, ...opts };
	const token = crypto.randomUUID();
	const deadline = Date.now() + acquireTimeoutMs;

	// ── Acquire ──
	while (true) {
		const ok = await redis.set(key, token, "PX", leaseMs, "NX");
		if (ok === "OK") break;
		if (Date.now() >= deadline) throw new LockAcquireTimeoutError(key);
		await new Promise((r) => setTimeout(r, acquireRetryMs));
	}

	// ── Heartbeat ──
	let lost = false;
	const renewer = setInterval(async () => {
		try {
			const res = await redis.eval(RENEW_SCRIPT, 1, key, token, String(leaseMs));
			if (res !== 1) lost = true;
		} catch {
			lost = true;
		}
	}, renewMs);

	// ── Critical section ──
	try {
		const result = await fn();
		if (lost) throw new LockLostError(key);
		return result;
	} finally {
		clearInterval(renewer);
		try {
			await redis.eval(RELEASE_SCRIPT, 1, key, token);
		} catch (err) {
			console.error(JSON.stringify({ event: "lock_release_error", key, error: (err as Error).message }));
		}
	}
}

export function execLockKey(sandboxId: string): string {
	return `vfs:lock:${sandboxId}`;
}
```

#### C.2. Thread Redis client into `SessionManager`

**File**: `src/api/session-manager.ts`

1. Add `redis: Redis | undefined` and lock options to `SessionManagerOptions`.
2. Add private helper `#withExecLock(sandboxId, fn)`:

```ts
// New imports:
import type Redis from "ioredis";
import {
	execLockKey,
	LockAcquireTimeoutError,
	LockLostError,
	withDistributedLock,
	type DistributedLockOptions,
} from "./distributed-lock.js";

// Additions to SessionManagerOptions:
readonly redis?: Redis;
readonly execLockOptions?: Partial<DistributedLockOptions>;

// On the class:
private readonly redis: Redis | undefined;
private readonly execLockOptions: Partial<DistributedLockOptions> | undefined;

// In constructor:
this.redis = opts.redis;
this.execLockOptions = opts.execLockOptions;

// New private helper:
private async withExecLock<T>(sandboxId: string, fn: () => Promise<T>): Promise<T> {
	if (!this.redis) {
		// Single-replica / Redis-disabled mode: proceed without cross-replica lock
		return fn();
	}
	return withDistributedLock(this.redis, execLockKey(sandboxId), fn, this.execLockOptions);
}
```

3. Wrap `withSession`:

```ts
async withSession<T>(
	sandboxId: string,
	fn: (session: Session) => Promise<T>,
	runtimeOptions?: RuntimeOptions,
): Promise<T> {
	return this.withExecLock(sandboxId, async () => {
		const session = await this.getOrCreate(sandboxId, runtimeOptions);
		if (session.state === "closing") {
			throw Object.assign(new Error("ESESSIONCLOSING: session is being destroyed"), { code: "ESESSIONCLOSING" });
		}
		return session.mutex.runExclusive(async () => {
			if (session.state === "closing") {
				throw Object.assign(new Error("ESESSIONCLOSING: session is being destroyed"), { code: "ESESSIONCLOSING" });
			}
			session.inFlight++;
			try {
				return await fn(session);
			} finally {
				session.inFlight--;
				session.pathCacheBytes = this.estimatePathCacheBytes(session.fs);
				session.overBudget = session.pathCacheBytes > this.pathCacheMaxBytes;
			}
		});
	});
}
```

4. Wrap `withExistingSession` symmetrically (same pattern — exec lock outside mutex).

5. Wrap `destroy`:

```ts
async destroy(sandboxId: string): Promise<boolean> {
	return this.withExecLock(sandboxId, async () => {
		const session = this.sessions.get(sandboxId);
		if (session === undefined) {
			await this.destroySandboxFn(this.backend, sandboxId);
			return false;
		}
		if (session.destroyPromise !== undefined) {
			await session.destroyPromise;
			return true;
		}
		session.state = "closing";
		const p = session.mutex.runExclusive(async () => {
			this.sessions.delete(sandboxId);
			await this.destroySandboxFn(this.backend, sandboxId);
		});
		session.destroyPromise = p;
		await p;
		return true;
	});
}
```

Note: `destroy` inside the Redis lock + local mutex — nested is safe because the Redis lock doesn't re-enter (different key granularity than session.mutex).

#### C.3. Wire Redis into server bootstrap

**File**: `src/api/server.ts`

```ts
// Imports:
import { getRedisClient } from "../redis/client.js";

// Replace SessionManager instantiation:
const sessionManager = new SessionManager({
	backend: (process.env.FS_BACKEND as StorageBackend | undefined) ?? "memory",
	redis: getRedisClient(),
	execLockOptions: {
		leaseMs: Number(process.env.REDIS_EXEC_LOCK_LEASE_MS ?? 60_000),
		renewMs: Number(process.env.REDIS_EXEC_LOCK_RENEW_MS ?? 20_000),
		acquireTimeoutMs: Number(process.env.REDIS_EXEC_LOCK_ACQUIRE_TIMEOUT_MS ?? 300_000),
	},
});
```

#### C.4. Error handling in the global error handler

**File**: `src/api/server.ts`

Add `ELOCKTIMEOUT` and `ELOCKLOST` to the known-codes list and map them to HTTP statuses:

```ts
const knownFsCodes = [
	"ENOENT", "EEXIST", "EISDIR", "ENOTDIR", "EPERM", "ENOTEMPTY",
	"ESESSIONCLOSING", "ELOOP", "EINVAL",
	"ELOCKTIMEOUT", "ELOCKLOST",
];
```

**File**: `src/api/errors.ts` (update `mapFsErrorToStatus`):

- `ELOCKTIMEOUT` → 503 (Service Unavailable; ask client to retry)
- `ELOCKLOST` → 500 (Internal Server Error; script atomicity was violated)

### Phase C: Testing

#### Unit tests

**File**: `src/api/distributed-lock.test.ts` (new)

Use a fake Redis implementation (in-memory map with token semantics). Test cases:

1. **Basic acquire + release**: single caller acquires, runs fn, releases; key is absent after return.
2. **Contention**: two concurrent calls on the same key; second one blocks until first releases.
3. **Acquire timeout**: second caller with short `acquireTimeoutMs` throws `LockAcquireTimeoutError`.
4. **Heartbeat extends lease**: long-running fn (longer than initial lease) completes successfully when heartbeat is enabled.
5. **Heartbeat failure → LockLostError**: simulate Redis returning 0 from RENEW_SCRIPT; fn completes but the method throws `LockLostError`.
6. **Release only if token matches**: manually expire the key, have another caller acquire with new token, first caller's release does not delete the new caller's lock.
7. **Exception in fn**: lock is still released (finally branch).

**File**: `src/api/session-manager.exec-lock.test.ts` (new)

With a mocked Redis:
- `withSession` acquires the Redis lock before entering `session.mutex`.
- Two concurrent `withSession` calls on the same sandbox across two `SessionManager` instances (same mocked Redis) serialize.
- `destroy` acquires the Redis lock; concurrent `withSession` waits.
- `ELOCKTIMEOUT` propagates out of `withSession`.

#### Integration tests

**File**: `src/api/__tests__/multi-replica-exec.integration.test.ts` (new)

Skip unless both `DATABASE_URL` and `REDIS_URL` set. Spin up two `SessionManager` instances in the same process, each with its own in-memory `Map<string, Session>` but sharing one Redis instance.

Test cases:
1. **Cross-instance serialization**: instance A runs a 2s exec writing `/a → 1`; instance B concurrently runs an exec writing `/a → 2`. Final state is deterministic (last-writer wins); both scripts saw full atomic state.
2. **Destroy vs exec**: instance A mid-exec; instance B calls `destroy`; destroy waits for A to finish.
3. **Lease expiry recovery**: force-kill instance A's heartbeat timer mid-exec; after `leaseMs`, instance B acquires and proceeds.

### Phase C: Success Criteria

#### Automated verification

- [x] `pnpm typecheck` passes.
- [x] `pnpm lint` passes.
- [x] `pnpm test:unit` passes with new lock + session-manager tests (342 tests green, +13 new).
- [x] `pnpm test:integration` passes with the cross-replica integration test (3/3 Phase C cases green; unrelated pre-existing `concurrency.pg.test.ts` and Buffer/Uint8Array failures confirmed pre-existing by re-running against the stashed baseline).
- [x] Simulated-failure tests (heartbeat failure, acquire timeout) pass deterministically with fake Redis.

#### Manual verification

- [x] Two local API instances against shared Postgres+Redis: concurrent `exec-sync` on the same sandbox serialized. First call finished in 2.05s (the scripted `sleep 2`); second in 3.89s (~2s waiting on the Redis lock + 2s sleep). `vfs:lock:<id>` was observable in Redis during the hold with a ~59s PTTL. Full two-replica HTTP-to-HTTP cross-instance run needs the Phase D session-rehydration work (`withExistingSession` can't warm a pool cold), so cross-replica serialization at the process level is covered by `multi-replica-exec.integration.test.ts` instead.
- [x] Planted a foreign token with 2s TTL into Redis; next `exec-sync` on an otherwise idle replica waited 2011ms and then ran — lease-expiry recovery confirmed manually, matching the integration test.
- [x] Stopped Redis mid-test: mutating `exec-sync` returned HTTP **503** with `code: ELOCKTIMEOUT` (message `ELOCKTIMEOUT: could not acquire lock vfs:lock:<id> within timeout`). Required swallowing `redis.set` rejections inside the acquire loop so connection errors retry to deadline instead of leaking a 500 (see Discoveries).

### Phase C: Rollback

Revert the PR. Any in-flight locks in Redis expire within `leaseMs` (default 60 s). No data migration. Be aware that a mixed-version fleet during a rolling deploy has a short window (1–2 min per replica rolling) where new-code and old-code replicas coexist — for that window, new-code replicas acquire the lock but old-code replicas don't, so cross-replica atomicity is not fully guaranteed. Document this risk window in the release notes.

### Phase C: Discoveries and Notable Information

**Technical Discoveries:**
- `ioredis` named import is required under `module: NodeNext` (confirmed Phase A finding). The plan's draft `import type Redis from "ioredis"` was converted to `import { type Redis } from "ioredis"`/`import type { Redis } from "ioredis"` in `src/api/distributed-lock.ts` and `src/api/session-manager.ts`.
- `readFile` on `IFileSystem` (from `just-bash`'s `Bash.d.ts`) returns `Promise<string>`, not `Promise<Uint8Array>`. Verification readbacks in the integration test use `String(...)` rather than a `TextDecoder`.

**Implementation Adaptations:**
- **`redis.set` throws on a dead Redis** rather than returning `null`. The plan's acquire loop `const ok = await redis.set(...); if (ok === "OK") break;` would then propagate the driver error and the route handler would return a generic 500 instead of the promised 503 `ELOCKTIMEOUT`. Fixed by catching thrown errors inside the acquire loop and treating them identically to a busy lock — retry until the acquire deadline, then throw `LockAcquireTimeoutError`. This makes the external contract (ELOCKTIMEOUT → 503) hold whether the contention is real or infrastructural, at the cost of up to `acquireTimeoutMs` of waiting when Redis is fully down.
- **`destroy` on an unknown sandbox in one replica still hits the distributed lock.** Since the in-memory pool short-circuit (`session === undefined → destroySandboxFn(...)`) now lives inside `withExecLock`, even a no-op-from-this-replica destroy coordinates with other replicas. That matches the plan's intent.
- **HTTP `withExistingSession` routes still hit the "session rehydration gap"** (Phase A discovery): a cold replica cannot service routes for a sandbox that was created on another replica because it has no pool entry. The Phase C lock does not address this — cross-replica HTTP cooperation requires the Phase D rehydration work. The integration tests therefore exercise the lock by instantiating two `SessionManager` instances in the same process, each calling `withSession` (which auto-creates the session). End-to-end HTTP-level two-replica tests are intentionally out of scope for Phase C's success criteria.

**Future Considerations:**
- The four new env vars (`REDIS_EXEC_LOCK_LEASE_MS`, `REDIS_EXEC_LOCK_RENEW_MS`, `REDIS_EXEC_LOCK_ACQUIRE_TIMEOUT_MS`, and the pre-existing blob-cache ones) are still parsed inline at call sites. A consolidated `src/redis/config.ts` would centralize parsing and defaults; deferred to keep Phase C surface minimal. Still flagged from Phase A.
- The manual Redis-down test reached the acquire deadline ~10s later than the configured `acquireTimeoutMs` because each `redis.set` retries up to `maxRetriesPerRequest` (default 3) before rejecting. Tuning the client to `maxRetriesPerRequest: 1` (or lower) shortens the observed user wait, at the cost of less tolerance to transient blips. Not touching it in this phase — the route still surfaces ELOCKTIMEOUT eventually, which is the invariant the success criteria require.
- Two older pre-existing integration failures (Buffer vs Uint8Array in `postgres.test.ts`, plus 11 failures in `concurrency.pg.test.ts`) are unrelated to Phase C — confirmed by re-running the failing suites against the Phase B baseline with `git stash`. They should be tracked in a separate ticket.

---

## Phase D: Version Counter + Reload-on-Handoff

### Phase D: Overview

Add a Redis monotonic version counter per sandbox. Each `Session` carries `lastSeenVersion`. On `withSession` entry (after acquiring the Redis lock), the replica compares its session's version to Redis's current version; mismatch triggers a cache reload. On exit, if writes happened, `INCR` the counter.

**Independent value:** multi-replica cache coherence without pub/sub. Completes the multi-replica correctness story.

### Phase D: Files and Changes

#### D.1. Add dirty tracking to `SqlFs`

**File**: `src/fs/sql-fs/sql-fs.ts`

1. Add private field and public accessors:

```ts
#dirty = false;

_markDirty(): void {
	this.#dirty = true;
}

wasDirty(): boolean {
	return this.#dirty;
}

clearDirty(): void {
	this.#dirty = false;
}
```

2. Call `this.#dirty = true;` at the end of each mutation method:
   - `writeFile`
   - `appendFile`
   - `mkdir` (both recursive and non-recursive branches)
   - `rm` (both recursive and non-recursive branches)
   - `cp` (both single-file and recursive branches)
   - `mv`
   - `chmod`
   - `utimes`
   - `link`
   - `symlink`

   **Audit checklist** (critical — missing one means silent coherence bugs):

   | Method | Line (current file) | Added `#dirty = true` placement |
   |---|---|---|
   | `writeFile` | after `#pathCache.set` (~244) | end of method |
   | `appendFile` | after `#pathCache.set` (~291) | end of method |
   | `mkdir` recursive | end of for-loop (~337) | after loop |
   | `mkdir` non-recursive | after `#pathCache.set` (~356) | end of method |
   | `rm` recursive | after cache delete loop (~414) | end of that branch |
   | `rm` non-recursive | after `#pathCache.delete` (~430) | end of method |
   | `chmod` | after `#pathCache.set` (~441) | end of method |
   | `utimes` | after `#pathCache.set` (~454) | end of method |
   | `cp` recursive | after repopulate (~612) | end of branch |
   | `cp` single file | after `#pathCache.set` (~645) | end of method |
   | `mv` | after reinsert loop (~705) | end of method |
   | `symlink` | after `#pathCache.set` (~744) | end of method |
   | `link` | after `#pathCache.set` (~762) | end of method |

3. Add `reload()` method:

```ts
/**
 * Drops all in-memory caches and repopulates #pathCache from the database.
 * Used on cross-replica cache-version mismatch.
 */
async reload(): Promise<void> {
	this.#pathCache.clear();
	this.#contentCache.clear();
	await this.ready();
	this.#dirty = false;
}
```

(Note: `ready()` already does `this.#pathCache.clear()` at its top, so the explicit clear on line 1 of `reload()` is technically redundant. Keep it for clarity.)

#### D.2. Add version fields to `Session` and plumb through

**File**: `src/api/session-manager.ts`

1. Extend the `Session` interface:

```ts
export interface Session {
	readonly fs: SqlFs; // tightened from IFileSystem if needed — or cast at reload sites
	readonly bash: Bash;
	readonly runtimeOptions: RuntimeOptions;
	lastUsed: number;
	inFlight: number;
	readonly mutex: Mutex;
	state: "active" | "closing";
	owner: string;
	createdAt: string;
	pathCacheBytes: number;
	overBudget: boolean;
	destroyPromise?: Promise<void>;
	/** Last-known version counter for cross-replica cache freshness. 0 = never synced. */
	lastSeenVersion: number;
}
```

Note: `Session.fs` is typed as `IFileSystem`; we'll need to either tighten the type (new interface `CoherentFs extends IFileSystem` with `reload`, `wasDirty`, `clearDirty`) or cast at call sites. Recommended: export a new internal interface from `sql-fs.ts` and use it for `Session.fs` inside `session-manager.ts`:

```ts
// In sql-fs.ts, add named export:
export interface ICoherentFs extends IFileSystem {
	reload(): Promise<void>;
	wasDirty(): boolean;
	clearDirty(): void;
}

// SqlFs already satisfies ICoherentFs after D.1
```

Then `Session.fs: ICoherentFs`. `InMemoryFs` (memory backend) does not satisfy `ICoherentFs` — handle by wrapping it in a no-op adapter in `createSandboxFs` for the memory branch, OR by keeping `Session.fs: IFileSystem` and casting. Pragmatic: cast at call sites, guarded by a runtime `if ("reload" in session.fs)` check, since memory backend is dev-only.

2. Initialize `lastSeenVersion` in `getOrCreate`:

```ts
const session: Session = {
	fs,
	bash,
	runtimeOptions: resolvedRuntime,
	lastUsed: Date.now(),
	inFlight: 0,
	mutex: new Mutex(),
	state: "active",
	owner: "",
	createdAt: new Date().toISOString(),
	pathCacheBytes,
	overBudget: pathCacheBytes > this.pathCacheMaxBytes,
	lastSeenVersion: 0, // Will be stamped by withSession/withExistingSession on first entry
};
```

3. Add version-check logic:

```ts
// New private helper on SessionManager:
private static versionKey(sandboxId: string): string {
	return `vfs:ver:${sandboxId}`;
}

private async ensureFreshCache(sandboxId: string, session: Session): Promise<void> {
	if (!this.redis) return;
	const current = Number(await this.redis.get(SessionManager.versionKey(sandboxId))) || 0;
	if (session.lastSeenVersion !== current) {
		if ("reload" in session.fs && typeof (session.fs as ICoherentFs).reload === "function") {
			await (session.fs as ICoherentFs).reload();
		}
		session.lastSeenVersion = current;
	}
	if ("clearDirty" in session.fs) (session.fs as ICoherentFs).clearDirty();
}

private async publishVersionIfDirty(sandboxId: string, session: Session): Promise<void> {
	if (!this.redis) return;
	if (!("wasDirty" in session.fs) || !(session.fs as ICoherentFs).wasDirty()) return;
	const newVersion = Number(await this.redis.incr(SessionManager.versionKey(sandboxId)));
	session.lastSeenVersion = newVersion;
	(session.fs as ICoherentFs).clearDirty();
}
```

4. Thread into `withSession` and `withExistingSession`:

```ts
async withSession<T>(
	sandboxId: string,
	fn: (session: Session) => Promise<T>,
	runtimeOptions?: RuntimeOptions,
): Promise<T> {
	return this.withExecLock(sandboxId, async () => {
		const session = await this.getOrCreate(sandboxId, runtimeOptions);
		if (session.state === "closing") {
			throw Object.assign(new Error("ESESSIONCLOSING: session is being destroyed"), { code: "ESESSIONCLOSING" });
		}
		await this.ensureFreshCache(sandboxId, session);
		return session.mutex.runExclusive(async () => {
			if (session.state === "closing") {
				throw Object.assign(new Error("ESESSIONCLOSING: session is being destroyed"), { code: "ESESSIONCLOSING" });
			}
			session.inFlight++;
			try {
				const result = await fn(session);
				await this.publishVersionIfDirty(sandboxId, session);
				return result;
			} finally {
				session.inFlight--;
				session.pathCacheBytes = this.estimatePathCacheBytes(session.fs);
				session.overBudget = session.pathCacheBytes > this.pathCacheMaxBytes;
			}
		});
	});
}
```

Apply the same fresh-check + publish pattern to `withExistingSession`.

5. In `destroy`, delete the version counter after destroying:

```ts
// Inside the withExecLock callback in destroy, after destroySandboxFn:
if (this.redis) {
	await this.redis.del(SessionManager.versionKey(sandboxId));
}
```

#### D.3. Cold-start: stamp version at session creation

**File**: `src/api/session-manager.ts`

In `getOrCreate`, after `createFs` returns and before pushing the session into the map, do a one-time version stamp so the first exec doesn't always look "stale":

```ts
const fs = await this.createFs(this.backend, sandboxId);
// ... build Bash ...
const pathCacheBytes = this.estimatePathCacheBytes(fs);

let initialVersion = 0;
if (this.redis) {
	initialVersion = Number(await this.redis.get(SessionManager.versionKey(sandboxId))) || 0;
}

const session: Session = {
	// ... other fields ...
	lastSeenVersion: initialVersion,
};
```

This avoids a spurious `reload()` on the first exec after `getOrCreate` on a cold replica.

### Phase D: Testing

#### Unit tests

**File**: `src/fs/sql-fs/sql-fs.dirty-tracking.test.ts` (new)

For each mutation method, assert:
- `wasDirty()` is `false` before the call.
- `wasDirty()` is `true` after the call.
- `clearDirty()` resets it.

One test per mutation method (14+ tests).

**File**: `src/api/session-manager.version-counter.test.ts` (new)

With mocked Redis:
- `withSession` on a fresh session initializes `lastSeenVersion` to the Redis value.
- On subsequent exec, if Redis version matches `session.lastSeenVersion`, no reload is called.
- On mismatch, `fs.reload()` is called and `lastSeenVersion` updates.
- If `wasDirty()` is true at exit, `INCR vfs:ver:{sandboxId}` fires and updates `lastSeenVersion`.
- If not dirty, no INCR.
- `destroy` deletes the version key.

#### Integration tests

**File**: `src/api/__tests__/multi-replica-coherence.integration.test.ts` (new)

Skip unless both `DATABASE_URL` and `REDIS_URL` are set. Two `SessionManager` instances sharing Postgres + Redis:

1. **Write on A, read on B**: instance A writes `/foo`, INCR version. Instance B does subsequent exec that reads `/foo`; verify `reload()` was called (spy on it) and the read returns the new content.
2. **No reload when versions match**: instance A does two consecutive execs with no intervening B-write; second exec does not call `reload()`.
3. **Destroy clears version**: after destroy, the Redis version key is absent; next `getOrCreate` starts from version 0.
4. **Concurrent writes bump version twice**: A writes (version 1), B writes (version 2). Both replicas converge on version 2 on next exec.

### Phase D: Success Criteria

#### Automated verification

- [x] `pnpm typecheck` passes.
- [x] `pnpm lint` passes.
- [x] `pnpm test:unit` passes, including the per-method dirty-tracking tests (373 tests green, +31 new).
- [x] `pnpm test:integration` passes on new Phase D integration suite (4/4 in `multi-replica-coherence.integration.test.ts`) and does not regress Phase C (3/3 in `multi-replica-exec.integration.test.ts`). Pre-existing failures in `postgres.test.ts` (Buffer vs Uint8Array) and `concurrency.pg.test.ts` (11 cases) match the Phase C baseline — confirmed unchanged.
- [x] **Critical:** `sql-fs.dirty-tracking.test.ts` covers all 14 mutation method branches listed in the audit table (writeFile, appendFile, mkdir non-recursive, mkdir recursive, rm non-recursive, rm recursive, rm force-miss is_NOT dirty, chmod, utimes, cp file, cp recursive, mv, symlink, link) plus read-only-ops-don't-mark-dirty as a negative control.

#### Manual verification

- [x] Two in-process `SessionManager` instances against one real Postgres (local `pg-test` container, `postgres://postgres:test@localhost:5432/postgres`) + one real Redis (local `redis-test` container, `redis://localhost:6379`) via `scripts/manual-verify-phase-d.ts`:
  - Pre-state `vfs:ver:<id>` absent.
  - A `withSession` writes `/greeting.txt` → `vfs:ver:<id>` = 1, A.lastSeenVersion = 1, B.lastSeenVersion still 0.
  - B `withSession` reads `/greeting.txt` → returns `"hello"`, B.lastSeenVersion advances to 1, B.pathCache now includes `/greeting.txt` (was absent before).
- [x] B's subsequent pure-read turn (`ls /`) did NOT bump the counter and did NOT reload — version key stayed at 1, `B.lastSeenVersion` stayed at 1.
- [x] Interleaved writes (A→B→A) converged both replicas on version 3; each replica saw the other's file across the handoff.
- [x] `smA.destroy(id)` removed `vfs:ver:<id>` from Redis (verified with `redis-cli exists`).
- [x] HTTP path sanity: launched `src/api/server.ts` on port 8080 with `FS_BACKEND=postgres`. `POST /v1/sandboxes` → `exec-sync` `echo hello > /foo.txt` bumped `vfs:ver:<id>` to 1 with `TTL ≈ 604800s (7d)` in Redis. A follow-up `ls /` exec kept the counter at 1 (no spurious INCR). `DELETE /v1/sandboxes/:id` → 204 and the version key was gone from Redis.

### Phase D: Rollback

Revert the PR. Stale `vfs:ver:*` keys in Redis age out with 24h TTL (add a TTL to the version keys in the implementation — recommend 7d to match max-realistic-idle). No data corruption. Mixed-fleet is safe: old-code replicas ignore the version counter and behave as today.

### Phase D: Discoveries and Notable Information

**Technical Discoveries:**
- `SqlFs.ready()` previously did `#pathCache.clear()` at its very top before awaiting `loadAllPaths`. The plan warned this is unsafe for `reload()` because a failed load would leave the cache empty and every subsequent read would return ENOENT until the next retry. Refactored into a shared `#loadFreshPathCache()` helper that builds a *new* Map and only swaps it into `#pathCache` after the DB call succeeds. The old `ready()` has been rewritten to delegate to the same helper for consistency. Verified via `reload preserves old cache when the fresh load throws` unit test.
- Biome auto-reformatted the `asCoherentFs` helper to multi-line on `pnpm lint:fix`. No behavior impact; noted so future edits don't fight the formatter.
- `IFileSystem.readFile` returns `Promise<string>` (carried over from Phase C). All integration-test readbacks use `String(...).trim()` rather than `TextDecoder`.

**Implementation Adaptations:**
- **ICoherentFs interface + runtime guard.** Plan recommended either tightening `Session.fs` to `ICoherentFs` or casting. Chose the runtime-guard route via a standalone `asCoherentFs(fs)` helper because `InMemoryFs` (dev-only memory backend) does not implement `reload`/`wasDirty`/`clearDirty`, and tightening the `Session.fs` type would force a no-op adapter or break the memory code path. The guard returns `undefined` for non-coherent fs instances and both `ensureFreshCache` / `publishVersionIfDirty` short-circuit cleanly — keeps the memory backend working without an adapter shim.
- **Single-flight `reload()` lives in `SqlFs`, not `SessionManager`.** The plan sketched a `pendingReloads: Map<string, Promise<void>>` on `SessionManager`, but the existing exec-lock already serializes reloads across same-sandbox turns on a single replica. The remaining concurrency risk is *within* `SqlFs` itself if a future path ever calls `reload` outside the exec lock (e.g., an admin tool). A `#pendingReload` guard on the class is both simpler and more defensive — colocated with the state it protects.
- **Version-key TTL applied via `EXPIRE` after `INCR`, not a Lua script.** Plan mentioned a Lua snippet for the Phase E `INCR`+`SET` case; Phase D only needs `INCR`, and applying `EXPIRE` as a second best-effort call (swallowing errors) is simpler and still correct — the counter is atomic, only the TTL could be briefly missing on a network blip. Manual verification confirmed TTL is ~604800s (7d) after the first `INCR`.
- **Destroy fast-path (unknown sandbox) also deletes the version key.** When `destroy` is called on a replica whose pool doesn't contain the session, it still issues `destroySandboxFn` and now also calls `deleteVersionKey`. Mirrors the Phase C decision to put the fast-path inside `withExecLock` so cross-replica state is always cleaned up, regardless of which replica owns the in-memory entry. Unit test `destroy on an unknown sandbox still deletes stale version key` locks this behavior in.
- **Initial version stamp swallows Redis errors.** If Redis is unreachable during `getOrCreate`, `initialVersion` falls back to 0. That means the very next `ensureFreshCache` call will reload from DB (harmless), but avoids throwing a generic 500 out of a sandbox-create call during a Redis outage. The distributed lock and `redis.get` in `ensureFreshCache` retain their existing behavior (fail open / rethrow respectively), so the Phase C ELOCKTIMEOUT contract is unaffected.

**Future Considerations:**
- `session.lastSeenVersion` starts at 0 on a truly-cold replica. If the Redis version is also 0 (i.e., nobody has ever written), the match happens spuriously — not a bug, but observable. Could be made more precise by stamping `-1` as the sentinel "never synced", but at the cost of a defensive comparison everywhere. Not worth the churn.
- The `ICoherentFs` interface now lives in `sql-fs.ts`. When `InMemoryFs` is ever replaced by a real dev backend, consider having it satisfy `ICoherentFs` (trivial: `reload = async () => {}`, `wasDirty` returning a tracked bit). Current runtime guard tolerates both.
- Env-var consolidation into `src/redis/config.ts` still deferred (flagged by Phases A and C). Phase D added zero new env vars so the pressure is unchanged.
- The full-turn log line `{event:"reload"}` mentioned in the plan's manual-verification section is not emitted today. Our `SqlFs.reload()` is silent; the coherence path is observable via the session's `lastSeenVersion` and Redis. For operational visibility on ACA, consider adding a structured log (`{event:"cache_reload",sandboxId,from,to}`) inside `ensureFreshCache` before the next rollout. Not blocking Phase D success criteria.

---

## Phase E: Redis Path Snapshot (Optional)

### Phase E: Overview

Persist the `#pathCache` as a msgpack-encoded snapshot in Redis. On cold start or reload-on-handoff, try the snapshot before falling back to `loadAllPaths`.

**When to do this:** only after Phase D is live and production metrics show `loadAllPaths` p99 > 100 ms. If p99 stays under 50 ms, skip permanently.

### Phase E: Files and Changes

#### E.1. Add msgpack dependency

**File**: `package.json`

```json
"@msgpack/msgpack": "^3.0.0"
```

#### E.2. Path snapshot module

**File**: `src/fs/sql-fs/redis-path-snapshot.ts` (new)

```ts
import { decode, encode } from "@msgpack/msgpack";
import type Redis from "ioredis";
import type { PathCacheEntry } from "./types.js";

interface EncodedEntry {
	readonly p: string;
	readonly i: string; // inodeId as string (bigint doesn't survive JSON/msgpack directly in some modes)
	readonly k: number;
	readonly m: number;
	readonly s: number;
	readonly t: number; // mtime as ms-since-epoch
	readonly c: Uint8Array | null;
	readonly l: string | null;
}

interface Snapshot {
	readonly version: number;
	readonly entries: readonly EncodedEntry[];
}

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1h

export class RedisPathSnapshot {
	readonly #client: Redis;
	readonly #ttlMs: number;

	constructor(client: Redis, opts: { ttlMs?: number } = {}) {
		this.#client = client;
		this.#ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
	}

	static key(sandboxId: string): string {
		return `vfs:snap:${sandboxId}`;
	}

	async write(sandboxId: string, version: number, pathCache: Map<string, PathCacheEntry>): Promise<void> {
		const entries: EncodedEntry[] = [];
		for (const [path, e] of pathCache) {
			entries.push({
				p: path,
				i: String(e.inodeId),
				k: e.kind,
				m: e.mode,
				s: e.size,
				t: e.mtime.getTime(),
				c: e.contentSha256,
				l: e.symlinkTarget,
			});
		}
		const snap: Snapshot = { version, entries };
		const bytes = Buffer.from(encode(snap));
		try {
			await this.#client.set(RedisPathSnapshot.key(sandboxId), bytes, "PX", this.#ttlMs);
		} catch (err) {
			console.error(JSON.stringify({ event: "snapshot_write_error", sandboxId, error: (err as Error).message }));
		}
	}

	async read(sandboxId: string): Promise<{ version: number; entries: Map<string, PathCacheEntry> } | null> {
		try {
			const buf = await this.#client.getBuffer(RedisPathSnapshot.key(sandboxId));
			if (!buf) return null;
			const snap = decode(buf) as Snapshot;
			const entries = new Map<string, PathCacheEntry>();
			for (const e of snap.entries) {
				entries.set(e.p, {
					inodeId: BigInt(e.i),
					kind: e.k as PathCacheEntry["kind"],
					mode: e.m,
					size: e.s,
					mtime: new Date(e.t),
					contentSha256: e.c,
					symlinkTarget: e.l,
				});
			}
			return { version: snap.version, entries };
		} catch (err) {
			console.error(JSON.stringify({ event: "snapshot_read_error", sandboxId, error: (err as Error).message }));
			return null;
		}
	}

	async delete(sandboxId: string): Promise<void> {
		try {
			await this.#client.del(RedisPathSnapshot.key(sandboxId));
		} catch {
			// best-effort
		}
	}
}
```

#### E.3. Wire into `SqlFs.ready()` and `reload()`

**File**: `src/fs/sql-fs/sql-fs.ts`

1. Accept an optional `pathSnapshot?: RedisPathSnapshot` in the constructor options.
2. In `ready()`, try snapshot first, falling back to `loadAllPaths`. **Use the strict-equality version-check pattern from Edge Cases §3** — compare `snap.version === currentVersion` before trusting the snapshot.
3. In `reload()`, same fallback strategy, and apply the build-before-swap invariant from Edge Cases §6 so a mid-reload failure cannot leave the session with an empty `#pathCache`.

4. In `SessionManager.publishVersionIfDirty`, after INCR, write the snapshot:

```ts
if (this.pathSnapshot) {
	const fs = session.fs as ICoherentFs & { _getPathCache(): Map<string, PathCacheEntry> };
	// Requires exposing a snapshot-writer hook on SqlFs — see below
	await this.pathSnapshot.write(sandboxId, newVersion, fs._getPathCache());
}
```

Add an internal accessor on `SqlFs`:

```ts
/** @internal for Redis path snapshot */
_getPathCache(): Map<string, PathCacheEntry> {
	return this.#pathCache;
}
```

(Returns the live Map; the snapshot writer should treat it as read-only.)

#### E.4. `destroy` deletes the snapshot

**File**: `src/api/session-manager.ts`

In `destroy`, after DEL of the version key:

```ts
if (this.pathSnapshot) {
	await this.pathSnapshot.delete(sandboxId);
}
```

### Phase E: Testing

#### Unit tests

**File**: `src/fs/sql-fs/redis-path-snapshot.test.ts` (new)

- Encode + decode round-trip: snapshot with various entry types (files, dirs, symlinks with non-null `contentSha256`) survives.
- `write` then `read` returns the same entries.
- `read` returns `null` on missing key.
- `read` handles decode errors gracefully (returns `null`).
- Entries with `bigint` inode IDs (large values > Number.MAX_SAFE_INTEGER) round-trip correctly.

#### Integration tests

**File**: `src/fs/sql-fs/integration/path-snapshot.integration.test.ts` (new)

- `SqlFs.ready()` uses the snapshot when present and skips `loadAllPaths`.
- Stale snapshot (version lower than Redis `vfs:ver`) is caught by version check at the `SessionManager` layer and reload proceeds.

### Phase E: Success Criteria

#### Automated verification

- [x] `pnpm typecheck` passes.
- [x] `pnpm lint` passes.
- [x] Round-trip tests pass with `bigint` inode IDs at least up to `2^63 - 1`.

#### Manual verification

- [x] End-to-end via local Docker (Redis 7 + Postgres 16) + dev API: sandbox create → exec (write) publishes `vfs:ver=1` and `vfs:snap` (351 bytes, TTL ~1h); second write bumps to `vfs:ver=3` with `vfs:snap=440` bytes; sandbox destroy clears both keys. Integration test `ready() uses the snapshot when version matches and skips loadAllPaths` confirms the cold-start hit. Large-tree (~10k paths) latency benchmark deferred — the correctness path is exercised.
- [x] **Multi-replica load test** (`scripts/phase-e-load-test.ts`): 3 `SessionManager` instances in one process share one Redis + one Postgres. Replica A seeds a sandbox with 1,000 files (→ `vfs:snap ≈ 92 KB`); replicas B and C cold-start that sandbox; a wrapped `dialect.loadAllPaths` counts recursive-CTE invocations per replica. Results below.

##### Phase E load test results — 1,000 files × 3 replicas

| Scenario | Total recursive-CTE calls | Per-replica breakdown | Cold-start `ready()` on B & C |
|---|---|---|---|
| **Snapshot ON** (`REDIS_PATH_SNAPSHOT_ENABLED=true`) | **1** | A=1 (initial empty load), B=0, C=0 | 2–4 ms (snapshot hit, ~92 KB from Redis) |
| **Snapshot OFF** (default) | **4** | A=1, B=1, C=2 (second CTE on reload-on-handoff) | 10–11 ms (CTE against Postgres) |

Narrative (snapshot ON):

1. Replica A creates sandbox, writes 1,000 files → `vfs:ver=1`, `vfs:snap=92,205 bytes`, TTL ≈ 1 h.
2. Replica B cold-starts → `path_snapshot_hit {version: 1, entries: 1006}` → zero CTE, `ready()` = 4 ms.
3. Replica C cold-starts → same hit pattern → zero CTE, `ready()` = 2 ms.
4. 60 warm follow-up reads across A/B/C → 0 additional CTE anywhere (pathCache-served).
5. B writes a new file → `vfs:ver=2`, snapshot refreshed to 92,295 bytes in one `publishVersionIfDirty` turn.
6. C's next exec detects the version delta, calls `reload()`, which re-enters `#loadFreshPathCache` and hits the freshly refreshed snapshot (version 2) — still zero CTE on C.

Contrast (snapshot OFF): every cold-start and every cross-replica reload ran the recursive CTE against Postgres. `reason="disabled"` on every `path_snapshot_miss` log line.

**Conclusion:** for a multi-replica setup at 1,000 paths, the snapshot eliminated 3 of 4 recursive-CTE executions (75 % reduction) while keeping cold-start `ready()` under 5 ms. Each additional replica joining the cluster amortizes the snapshot write with no further Postgres load.

### Phase E: Rollback

Revert the PR. Snapshot keys age out (1 h TTL). No data loss.

### Phase E: Discoveries and Notable Information

**Technical Discoveries:**
- `@msgpack/msgpack` v3 returns Node `Buffer` instances for binary (bin8/bin16) fields under Node.js. `Buffer` extends `Uint8Array`, so consumers still work, but `toEqual` distinguishes them from plain `Uint8Array`. Normalized in `RedisPathSnapshot.read()` by wrapping each decoded `contentSha256` in `new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)` to keep the in-memory shape consistent with `dialect.loadAllPaths()` output.
- The Redis version key read required by the reader pattern (Edge Case §3) belongs inside `SqlFs` (alongside its existing `redis` client option), not inside `SessionManager.ensureFreshCache`. Reason: `ensureFreshCache` runs *after* session creation, but the first snapshot opportunity is during `createSandboxFs` → `SqlFs.ready()`, which happens before `SessionManager` ever touches the fs. Both `redis` and `pathSnapshot` are therefore threaded into the `SqlFs` constructor so `#loadFreshPathCache` can self-contain the snapshot-first fallback.

**Implementation Adaptations:**
- Added a structural `SnapshotWriterFs = ICoherentFs & { _getPathCache() }` narrowing type in `session-manager.ts` (rather than baking `_getPathCache` into the public `ICoherentFs` interface). Keeps the `@internal` accessor out of the cross-module type contract while still letting `publishVersionIfDirty` call it safely.
- `#loadFreshPathCache` returns the snapshot's `entries` map directly on a hit. Callers (`ready`, `reload`) still apply the build-before-swap invariant: the returned map becomes the new `#pathCache` only after success. If snapshot decode/version-check throws, the caller's existing caches are untouched.
- Feature-flagged via `REDIS_PATH_SNAPSHOT_ENABLED=true` (default off) per plan guidance — snapshot is opt-in pending production latency data. `REDIS_PATH_SNAPSHOT_TTL_MS` tunes the TTL (default 1h).
- Added a structured observability log in `#loadFreshPathCache`: every load emits either `{event: "path_snapshot_hit", sandboxId, version, entries}` (snapshot path taken) or `{event: "path_snapshot_miss", sandboxId, reason}` where `reason ∈ {"disabled", "no_key", "version_mismatch", "error"}`. This makes cache effectiveness directly measurable in production logs and was the basis for the multi-replica load test's hit/miss counters.
- Added `scripts/phase-e-load-test.ts` — an in-process 3-`SessionManager` harness that wraps `dialect.loadAllPaths` with a call counter. The existing HTTP routes (except `POST /v1/sandboxes`) use `withExistingSession`, so cold-starting a specific sandbox on replica B/C over HTTP is impossible — they would all return ENOENT. The in-process harness bypasses that pre-existing architectural gap (noted in Phase A discoveries as "session rehydration gap") so we can observe the snapshot path.

**Future Considerations:**
- The "snapshot write happened; version INCR failed" atomicity gap (Edge Case §2) is still present. Acceptable today thanks to strict-equality on read; revisit if a Lua INCR+SET script is warranted after production data shows stale-snapshot collisions.
- Large-tree (10k paths) latency benchmark not run yet — needs a dedicated perf harness or a synthetic sandbox via `bulkIngest` to be meaningful. Deferred until someone has production `loadAllPaths` p99 numbers to compare against (the plan's explicit entry criterion for Phase E anyway). The 1k-path load test above demonstrates correctness + qualitative speedup; the 10k-path quantitative p99 measurement is the remaining work.
- Session rehydration over HTTP (cold replica servicing `withExistingSession` routes for a sandbox it has never seen) is still a separate limitation. Would require a `withSessionOrRehydrate` wrapper that falls back to `getOrCreate` when the pool is cold. Not in Phase E's scope — filed as future work for whichever phase decides to close that gap.

---

## Global Testing Strategy

### Unit Tests

- **Redis blob cache** — mock ioredis, test fail-open semantics, size cap.
- **Distributed lock** — fake Redis, test acquire/release/heartbeat/expiry/contention.
- **Dirty tracking on SqlFs** — one test per mutation method, plus a guard test iterating method names.
- **Version counter in SessionManager** — mock Redis, test version stamping, reload triggering, INCR on dirty.
- **PG advisory lock** — mock `postgres.TransactionSql`, assert SQL is emitted.

### Integration Tests

Run against real Postgres + Redis. All gated by env vars.

- **Blob cache** — write and read blobs across instances; verify dedup.
- **Advisory lock** — concurrent writers block, different sandboxes parallel, destroy race.
- **Cross-replica exec** — two `SessionManager` instances serialize via Redis lock.
- **Coherence** — writes on one replica visible to another via version counter.
- **Path snapshot** (Phase E) — snapshot hits skip `loadAllPaths`.

### End-to-End Tests

New `src/api/__tests__/multi-replica-e2e.integration.test.ts`:

- Spin up 2 `app` Hono instances (shared SessionManager not possible — different process-local Maps). Use a single Postgres + Redis backing both.
- Simulate LB round-robin by alternating requests between the two instances.
- Assert: create sandbox, write files from instance A, read from instance B, concurrent execs serialize, destroy from B while A is mid-exec is queued.

### Manual Testing Steps

1. Deploy 2 replicas to ACA (or docker-compose locally) sharing one Postgres + one Redis.
2. Use `ab` or `k6` to fire concurrent `/exec-sync` requests for the same sandbox; verify all complete without error and final state is consistent.
3. Kill one replica mid-exec; verify the other replica can take over after `leaseMs`.
4. Stop Redis; verify mutations return 503 within the acquire-timeout; verify service recovers when Redis comes back.

## Performance Considerations

- **Redis round-trip per exec:** adds ~1 RTT (blob cache GET / exec lock acquire / version GET). For exec paths taking seconds, negligible. Monitor via the metrics below.
- **Per-txn advisory lock:** in-memory PG hash-table lookup, sub-millisecond.
- **Heartbeat overhead:** one EVAL per `renewMs` (default 20 s) per concurrent exec. Negligible.
- **Snapshot write overhead (Phase E only):** serialize #pathCache + Redis SET. For a 10k-path sandbox, msgpack encode is ~10–20 ms and serialized size is ~500 KB. Written only when writes happened, so rate is bounded by exec rate.
- **Version-counter keys** have no TTL by default — add one (e.g., 7 days after last update) if key-count growth becomes a concern. Sandboxes that are destroyed have their keys explicitly DEL'd.

## Metrics to Add

Phase C and D should instrument:

- `vfs.exec_lock.acquire_duration_ms` — histogram, tagged by `contended=true|false`.
- `vfs.exec_lock.lost_total` — counter, for heartbeat failures.
- `vfs.version_counter.mismatch_rate` — ratio of `reload()` triggers per exec.
- `vfs.sql_fs.load_all_paths_duration_ms` — histogram (drives Phase E decision).
- `vfs.redis.blob_cache_hit_ratio` — derived from `get` call outcomes.
- `vfs.node.gc_pause_duration_ms` (via `perf_hooks`) — canary for fencing failures.

Alert thresholds:

- GC pause p99 > `REDIS_EXEC_LOCK_LEASE_MS / 3` → warn.
- `exec_lock.lost_total` > 0 over 5-minute window → warn (first occurrence should be investigated).
- `version_counter.mismatch_rate` > 0.1 → may indicate excessive cross-replica handoff; consider LB tuning or accepting it.

## Migration Notes

- **No schema migrations.** All new state is in Redis (lock keys, version counter, blob cache, optional snapshot).
- **Deployment order:** deploy Phase A and B first (safe on single-replica). Deploy Phase C with `REDIS_URL` set before scaling replicas > 1. Never scale out to N replicas with Phase C disabled.
- **Feature flags:** Phases A and B have graceful-degradation semantics (work without Redis). Phase C requires `REDIS_URL` for safe multi-replica operation — document clearly in deploy guide.

## References

- Architecture document: `tasks/arch-redis-caching-and-locking.md`
- Original PRD: `tasks/prd-virtual-fs-api.md` (US-088 and below — prerequisites)
- Existing implementation plan: `tasks/IMPLEMENT.md` (Phase 6 — Deployment, which this work sits alongside)
- Key source files:
  - `src/fs/sql-fs/sql-fs.ts` — `SqlFs` class (Phase D dirty tracking + reload)
  - `src/fs/sql-fs/dialects/postgres.ts` — `PostgresDialect` (Phase A blob cache, Phase B advisory lock)
  - `src/api/session-manager.ts` — `SessionManager` (Phase C exec lock, Phase D version counter)
  - `src/api/server.ts` — Hono bootstrap (Redis client wiring)

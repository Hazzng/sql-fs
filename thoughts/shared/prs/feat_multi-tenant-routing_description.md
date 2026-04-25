# PR Title: feat(api): multi-tenant Postgres routing with tenant-prefixed Redis isolation

## Summary

Enables a single `virtualfs-api` process to serve N independent tenants, each mapped to a dedicated Postgres database, with full Redis key isolation and per-tenant startup migrations. Backward-compatible: existing `DATABASE_URL` deployments continue working as a single implicit `default` tenant with no config changes.

This PR also consolidates the multi-replica Redis hardening work (hardened version-counter publishing, fire-and-forget blob writes, advisory-lock splitting, distributed-lock option validation, env-var validation at startup) that formed the foundation for the multi-tenant layer.

---

## Problem

The API process was hardcoded to a single `DATABASE_URL`, making it impossible for one deployment to serve multiple isolated customers:

- `SessionManager` keyed sessions by `sandboxId` only — UUID collisions across tenants would silently corrupt state.
- All four Redis keyspaces (`vfs:lock:*`, `vfs:ver:*`, `vfs:snap:*`, `vfs:blob:*`) were flat across all sandbox IDs; any two tenants reusing an ID would race on the same keys.
- The blob cache used content-addressable keys shared globally, creating a confidentiality side-channel between tenants.
- Schema migrations had to be applied manually; the server booted assuming tables already existed.
- The `owner` field was never persisted to Postgres, so ownership checks were silently bypassed after a session was evicted and rehydrated.

---

## What Changed

### Phase 1 — Tenant config + JWT claim
- **`src/api/tenants.ts`** (new): `loadTenantConfig()` reads `TENANT_DATABASES` (JSON `{ tenantId: connectionString }`) or falls back to `DATABASE_URL` under tenant id `"default"`. Tenant id charset restricted to `A-Za-z0-9_.-` (safe for Redis key embedding).
- **`src/api/lib/jwt.ts`**: `SignTokenOptions` and `TokenPayload` gain an optional `tenant` claim. `signToken()` includes it in the JWT body when set.
- **`src/api/cli/token.ts`**: `--tenant <id>` flag added. Omitting it produces a legacy-compatible no-claim token.
- **`src/api/routes/admin.ts`**: `POST /v1/admin/tokens` accepts and echoes `tenant` in the 201 response.
- **`src/api/auth.ts`**: `authMiddleware` refactored into `createAuthMiddleware(tenantConfig)` (explicit) + a lazy `authMiddleware` singleton (backward-compat). Tenant is resolved from the JWT claim, defaulting to `"default"`. Unknown tenant → 401 `AUTH_UNKNOWN_TENANT`. Sets `c.set("tenant", claim)` alongside the existing `c.set("owner", sub)`.

### Phase 2 — Per-tenant Postgres routing
- **`src/api/session-manager.ts`**: `backend: StorageBackend` removed from options; replaced with `tenantConfig: TenantConfig` + `blobCacheFactory`. Internal session map re-keyed from `sandboxId` to `${tenantId}:${sandboxId}`. `PerTenantBackend` (connection string + blob cache) constructed lazily on first access per tenant and cached for the process lifetime. All public methods — `withSession`, `withExistingSession`, `getOrCreate`, `destroy`, `getSession` — gain `tenantId` as first parameter.
- **`src/fs/sql-fs/index.ts`**: `createPostgresSandboxFs(opts, sandboxId, owner?)` replaces the env-reading `createSandboxFs`. Returns `{ fs, resolvedOwner }` so the caller gets the DB-persisted owner on both new creation and 23505-conflict rehydration paths. Legacy `createSandboxFs` kept for integration tests and benchmarks.
- **`src/api/routes/`** + **`src/api/mcp/`**: Every `sessionManager.*` call site updated to pass `c.get("tenant")` as the first argument. `handleMcpRequest` gains a `tenant` parameter.

### Phase 3 — Tenant-prefixed Redis keys
- **`src/api/distributed-lock.ts`**: `execLockKey(tenantId, sandboxId)` → `vfs:{tenantId}:lock:{sandboxId}`.
- **`src/api/session-manager.ts`**: `versionKey(tenantId, sandboxId)` → `vfs:{tenantId}:ver:{sandboxId}`.
- **`src/fs/sql-fs/redis-path-snapshot.ts`**: `key/write/read/delete` all accept `tenantId` as first arg → `vfs:{tenantId}:snap:{sandboxId}`.
- **`src/fs/sql-fs/redis-blob-cache.ts`**: Constructor gains `tenantId: string` as second parameter; `static key()` replaced by `#key()` instance method → `vfs:{tenantId}:blob:{hex}`. Each tenant gets its own `RedisBlobCache` instance from `blobCacheFactory`.

### Phase 4 — Startup migration runner
- **`src/api/migrations.ts`** (new): `runMigrations(tenantConfig)` iterates every configured tenant, opens a single-connection Postgres client, and applies all `.sql` files under `src/fs/sql-fs/migrations/postgres/` in lexicographic order inside a transaction. Idempotent (`CREATE TABLE IF NOT EXISTS` / `CREATE OR REPLACE`). Fails closed: first error aborts boot and emits `migration_failed` JSON log. Controlled by `SKIP_STARTUP_MIGRATIONS=true` escape hatch.
- **`src/api/server.ts`**: Calls `runMigrations(tenantConfig)` before binding the HTTP port. `server_start` log now includes `tenantCount`. `blobCacheFactory` wired per-tenant. `RedisBlobCache` constructed inside the factory rather than as a shared singleton.

### Bug fix — Owner persistence
- **`src/fs/sql-fs/types.ts`** / **`dialects/postgres.ts`**: `createSandbox(tx, sandboxId, owner?)` now INSERTs the `owner` column. New `readSandboxOwner(sandboxId)` method reads it back when rehydrating an existing sandbox (23505 path). Session `owner` field is no longer `""` after process restart; ownership checks in exec/files/ingest/MCP routes are no longer silently bypassed.

### Multi-replica Redis hardening (merged from feat/multi-replica-redis)
- Version-counter `INCR` errors are swallowed inside `publishVersionIfDirty` and in the `finally` block of `withSession` so a Redis outage never crashes an exec turn.
- `setSandboxContext` split into read-only and write paths; read-only paths skip the advisory lock, reducing lock contention on hot-read workloads.
- `RedisBlobCache` writes fire-and-forget (no `await`) so a slow Redis write never adds latency to a Postgres-committed response.
- Numeric Redis env vars (`REDIS_*_MS`) validated at startup with `parseNonNegativeInt` instead of unguarded `Number()`.
- Distributed lock options validated at construction time (`renewMs < leaseMs`, all values > 0).
- `ICoherentFs` runtime guard now requires `clearDirty` in addition to `reload`/`wasDirty`.
- Recursive `mkdir` rejects non-directory ancestors with ENOTDIR instead of silently writing dirents under a file inode.

---

## Migration Guide

### Single-tenant deployments (no change required)
```
DATABASE_URL=postgres://...
AUTH_SECRET=...
FS_BACKEND=postgres
```
Tokens without a `tenant` claim continue to work; auth resolves them to the `default` tenant. Redis keys will change shape from `vfs:ver:{id}` to `vfs:default:ver:{id}` on first boot — run `redis-cli FLUSHDB` to evict the old unreachable keys (Redis is a cache, not a source of truth; no data is lost).

### Multi-tenant deployments (new)
```
TENANT_DATABASES='{"acme":"postgres://…/acme_db","beta":"postgres://…/beta_db"}'
AUTH_SECRET=...
FS_BACKEND=postgres
```
Mint per-tenant tokens:
```bash
pnpm token:create -- --sub alice --tenant acme --expires 30d
```
Startup migrations run automatically for every tenant on boot. To skip (run migrations out-of-band):
```bash
SKIP_STARTUP_MIGRATIONS=true
```

### Breaking API changes
| Before | After |
|---|---|
| `SessionManager({ backend, databaseUrl? })` | `SessionManager({ tenantConfig, blobCacheFactory? })` |
| `sessionManager.withSession(sandboxId, fn)` | `sessionManager.withSession(tenantId, sandboxId, fn)` |
| `execLockKey(sandboxId)` | `execLockKey(tenantId, sandboxId)` |
| `RedisBlobCache(client, opts?)` | `RedisBlobCache(client, tenantId, opts?)` |
| `RedisPathSnapshot.key(sandboxId)` | `RedisPathSnapshot.key(tenantId, sandboxId)` |
| `handleMcpRequest(req, sm, owner)` | `handleMcpRequest(req, sm, owner, tenant)` |

---

## Testing

- **Unit (436 tests, 43 files)**: All pass. New suites: `tenants.test.ts`, `redis-blob-cache.test.ts` (tenant isolation assertions), `redis-path-snapshot.test.ts` (cross-tenant key disjointness).
- **Integration**: `migrations.integration.test.ts` — creates an ephemeral DB, runs `runMigrations`, asserts tables exist, verifies idempotency. `multi-tenant.integration.test.ts` — two real Postgres databases, cross-tenant 404 isolation, concurrent exec, DB row inspection, Redis keyspace partition check (skipped when `DATABASE_URL` unset).
- **Manual E2E (Phase 5 walkthrough)**: Two-tenant local stack verified — startup migrations, concurrent writes, cross-tenant file read (404), unknown tenant (401), physical DB row isolation, Redis `vfs:tenant-a:*` / `vfs:tenant-b:*` disjoint keyspaces, cross-tenant destroy (404), destroy own sandbox (204), legacy single-tenant mode (`vfs:default:*` keys).

---

## Checklist

- [x] `pnpm typecheck` passes
- [x] `pnpm lint:fix` passes
- [x] `pnpm test:unit` passes (436/436)
- [x] Backward compatibility verified: `DATABASE_URL`-only deployment boots and accepts no-`tenant`-claim tokens
- [x] Phase 5 manual walkthrough completed against live Postgres + Redis
- [x] Owner column persisted; ownership checks enforced after session rehydration
- [ ] `pnpm test:integration` — requires live Postgres + Redis; skips gracefully when `DATABASE_URL` unset
- [ ] `redis-cli FLUSHDB` on existing deployments after upgrade (Redis key shape change)

---
date: 2026-04-24T22:44:38+09:30
researcher: quangnguyentechno@gmail.com
git_commit: 6aed558064353fc2ff60489fdf65d9d3e7692fa9
branch: feat/multi-replica-redis
repository: virtualFS
task: "Multi-tenant Postgres routing (one container, N databases)"
tags: [implementation-plan, multi-tenant, session-manager, auth, redis, postgres]
status: draft
last_updated: 2026-04-24
last_updated_by: quangnguyentechno@gmail.com
---

# Multi-Tenant Postgres Routing — Implementation Plan

## Overview

Allow a single virtualFS API process to serve N tenants, each mapped to a dedicated Postgres database (all using the default `public` schema). Tenant is resolved from a JWT claim; Postgres dialects are cached per-tenant and lazily constructed on first use. All Redis keys gain a tenant prefix. A startup migration runner applies DDL to every configured tenant database. Backward-compatible with the current single-`DATABASE_URL` deployment.

## Current State Analysis

### How the current pipeline is wired

- `src/api/server.ts:30-54` — constructs a single `SessionManager` from the process-wide `FS_BACKEND` + implicit `DATABASE_URL` (read inside the factory). Redis client and `RedisPathSnapshot` are also single, process-wide singletons.
- `src/fs/sql-fs/index.ts:25-67` — `createSandboxFs("postgres", sandboxId)` reads `process.env.DATABASE_URL` directly (line 28). Builds one `PostgresDialect` per call, no per-tenant cache.
- `src/api/session-manager.ts:137` — `sessions: Map<string, Session>` keyed by `sandboxId` only. `createFs` receives only `(backend, sandboxId)`.
- `src/api/auth.ts:20-49` — `authMiddleware` verifies HS256 JWT and stashes `sub` as `owner` on the Hono context. No tenant claim.
- `src/api/lib/jwt.ts:29-38` — `signToken({ sub, expiresIn, secret })` signs only `{ sub }`.
- `src/api/cli/token.ts:12-27` — CLI accepts `--sub` and `--expires` only.
- `src/api/routes/admin.ts:17-20` — `POST /v1/admin/tokens` validates `{ sub, expiresIn }`.
- `src/api/distributed-lock.ts:163-165` — `execLockKey(sandboxId)` returns `vfs:lock:${sandboxId}`.
- `src/api/session-manager.ts:31-33` — `versionKey(sandboxId)` returns `vfs:ver:${sandboxId}`.
- `src/fs/sql-fs/redis-path-snapshot.ts:65-67` — `RedisPathSnapshot.key(sandboxId)` returns `vfs:snap:${sandboxId}`.
- `src/fs/sql-fs/redis-blob-cache.ts:33-35` — `RedisBlobCache.key(sha256)` returns `vfs:blob:${hex}` (content-addressable, globally shared today).

### Migration situation

- `src/fs/sql-fs/migrations/postgres/0000_create_tables.sql` — `CREATE TABLE IF NOT EXISTS` for sandboxes/inodes/dirents/blobs (all unqualified → `public` schema).
- `src/fs/sql-fs/migrations/postgres/0001_rls_and_procs.sql` — `CREATE OR REPLACE FUNCTION fs_resolve(…)` + RLS policies; idempotent.
- There is **no startup migration runner**. Migrations are applied by `drizzle-kit migrate` (scripted in `package.json`), or ad-hoc by `benchmark.ts:154-166` for benchmarks. The server boots assuming the schema already exists.

### Why this can't serve multiple tenants today

1. One `DATABASE_URL` means one Postgres database. No code path reads a per-tenant URL.
2. `SessionManager` has no concept of tenant scope — two tenants' sandboxes would collide in the `Map<string, Session>` if UUIDs ever collide (improbable but not impossible).
3. All four Redis keyspaces (lock, ver, snap, blob) are flat across sandbox IDs. Cross-tenant ID reuse would leak state or lock unrelated work.
4. The blob cache is intentionally content-shared. For multi-tenant it becomes a confidentiality side-channel unless prefixed.

## Desired End State

A single API process reads a `TENANT_DATABASES` JSON env var mapping `tenantId → postgresConnectionString` and serves requests for any configured tenant based on a `tenant` JWT claim. Each request routes to the correct tenant's Postgres database; Redis keys are fully tenant-partitioned; cross-tenant isolation is enforced at the storage layer.

**Verification that the end state is reached:**

- Two tenants configured (`tenant-a`, `tenant-b`) against two local Postgres databases.
- Token signed with `tenant=tenant-a` cannot access sandboxes created with a `tenant=tenant-b` token (404).
- Redis `KEYS vfs:tenant-a:*` and `KEYS vfs:tenant-b:*` show disjoint keyspaces during concurrent activity.
- Destroying sandbox for tenant-a does not touch tenant-b's database or Redis state.
- Existing single-`DATABASE_URL` deployments keep working unchanged (implicit tenant `default`).

### Key Discoveries

- `pg_advisory_xact_lock` lives per-database — already gives us free cross-tenant isolation at the DB layer (`src/fs/sql-fs/dialects/postgres.ts:60-66,109`).
- Every route already funnels through `SessionManager.withSession` / `withExistingSession` / `destroy` (`src/api/routes/sandboxes.ts:48,94`, `src/api/routes/exec.ts:33`, `src/api/routes/files.ts:88`, `src/api/routes/ingest.ts:39`). Single chokepoint for tenant plumbing.
- `createSandboxFs` is a single-path factory; only the `postgres` branch needs the tenant-aware URL (`src/fs/sql-fs/index.ts:26-67`).
- Migrations are already idempotent (`IF NOT EXISTS` / `CREATE OR REPLACE`) — iterating tenants at boot is safe.
- Version counter initial fetch already gracefully handles Redis errors (`src/api/session-manager.ts:240-249`). The tenant-prefixed key just changes which key we read.

## What We're NOT Doing

- **Not supporting multiple schemas within one database.** Each tenant gets its own database.
- **Not supporting per-tenant Redis instances.** One Redis serves all tenants; isolation comes from key prefixes.
- **Not implementing dynamic tenant onboarding without restart.** `TENANT_DATABASES` is read once at boot; adding a tenant requires a restart.
- **Not changing the blob cache to allow cross-tenant dedup** (safer default is tenant-partitioned; a later opt-in could enable sharing).
- **Not removing the existing single-`DATABASE_URL` path.** Deployments that set `DATABASE_URL` without `TENANT_DATABASES` continue working under an implicit tenant id (`default`).
- **Not changing ownership (`owner`/`sub`) semantics.** `sub` still scopes sandbox access *within* a tenant; tenant scopes access *across* databases.
- **Not touching MySQL / Azure SQL dialects.** They remain unimplemented (already) — tenant plumbing is Postgres-only in this phase.

## Implementation Approach

Five phases, each independently verifiable against a real local Postgres + Redis:

1. **Tenant config + JWT tenant claim** — plumbing with no behavior change (tenant defaults to `default`).
2. **Per-tenant Postgres backend routing in SessionManager** — split the single `createFs` into a tenant-aware factory and a per-tenant backend cache; key sessions by `(tenantId, sandboxId)`.
3. **Tenant-prefixed Redis keys** — update all four key builders (lock, ver, snap, blob).
4. **Startup migration runner** — iterate configured tenant databases at boot and apply migrations idempotently.
5. **End-to-end verification** — two-tenant local stack, cross-tenant isolation checks, regression of existing tests.

TDD is applied selectively (not strictly every phase): new pure units (tenant config loader, key builders) get unit tests first; integration behavior is verified against real local Postgres + Redis per phase.

---

## Phase 1: Tenant config loader + JWT tenant claim

### Phase 1: Overview

Add `tenant` as a first-class claim on issued JWTs. Add a `TenantConfig` loader that parses `TENANT_DATABASES` (JSON) with backward-compatible fallback to `DATABASE_URL` as tenant `default`. Auth middleware resolves the tenant on every request. Nothing else changes behavior yet — SessionManager still uses a single backend.

### Phase 1: Changes Required

#### 1.1 Tenant config loader (new)

**File**: `src/api/tenants.ts` (new)

```ts
/**
 * Tenant configuration loader.
 *
 * Sources of truth, in priority order:
 *   1. TENANT_DATABASES — JSON blob mapping tenantId → postgres connection string.
 *   2. DATABASE_URL (legacy single-tenant) — registered under tenant id "default".
 *
 * Exactly one must be set. TENANT_DATABASES takes precedence when both exist.
 */
export interface TenantConfig {
  readonly tenantIds: readonly string[];
  hasTenant(tenantId: string): boolean;
  getConnectionString(tenantId: string): string; // throws on unknown tenant
}

export const DEFAULT_TENANT_ID = "default";

export function loadTenantConfig(env: NodeJS.ProcessEnv = process.env): TenantConfig {
  const raw = env.TENANT_DATABASES;
  if (raw !== undefined && raw.length > 0) {
    const parsed = parseTenantJson(raw);
    return fromMap(parsed);
  }
  const legacy = env.DATABASE_URL;
  if (legacy !== undefined && legacy.length > 0) {
    return fromMap(new Map([[DEFAULT_TENANT_ID, legacy]]));
  }
  throw new Error(
    "Tenant configuration missing: set TENANT_DATABASES (JSON) or DATABASE_URL (single-tenant legacy).",
  );
}

function parseTenantJson(raw: string): Map<string, string> {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    throw new Error(`TENANT_DATABASES is not valid JSON: ${(e as Error).message}`);
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    throw new Error("TENANT_DATABASES must be a JSON object of { tenantId: connectionString }.");
  }
  const m = new Map<string, string>();
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof v !== "string" || v.length === 0) {
      throw new Error(`TENANT_DATABASES[${k}] must be a non-empty connection string.`);
    }
    if (!/^[A-Za-z0-9_.-]+$/.test(k)) {
      throw new Error(`TENANT_DATABASES tenant id "${k}" contains invalid characters; allowed: A-Z a-z 0-9 _ . -`);
    }
    m.set(k, v);
  }
  if (m.size === 0) throw new Error("TENANT_DATABASES is empty.");
  return m;
}

function fromMap(m: Map<string, string>): TenantConfig {
  const ids = Object.freeze([...m.keys()]);
  return {
    tenantIds: ids,
    hasTenant: (id) => m.has(id),
    getConnectionString: (id) => {
      const v = m.get(id);
      if (v === undefined) throw new Error(`Unknown tenant: ${id}`);
      return v;
    },
  };
}
```

Tenant id charset restriction (`A-Za-z0-9_.-`) guarantees the id is safe to embed verbatim in Redis keys without ambiguity or injection concerns.

#### 1.2 JWT payload + signing

**File**: `src/api/lib/jwt.ts`

```ts
// Add optional `tenant` to SignTokenOptions and TokenPayload; include in signed body.
export interface SignTokenOptions {
  sub: string;
  tenant?: string;         // NEW
  expiresIn?: string;
  secret: string;
}

export interface TokenPayload {
  sub: string;
  tenant?: string;         // NEW
  iat?: number;
  exp?: number;
}

export async function signToken({ sub, tenant, expiresIn, secret }: SignTokenOptions): Promise<string> {
  const key = new TextEncoder().encode(secret);
  const body: Record<string, unknown> = { sub };
  if (tenant !== undefined) body.tenant = tenant;
  const jwt = new SignJWT(body).setProtectedHeader({ alg: "HS256" }).setIssuedAt();
  if (expiresIn && expiresIn !== "never") jwt.setExpirationTime(expiresIn);
  return jwt.sign(key);
}
```

#### 1.3 Token CLI

**File**: `src/api/cli/token.ts`

```ts
// Accept --tenant <id>. Default to DEFAULT_TENANT_ID when omitted so legacy scripts still work.
// In parseArgs(): recognize --tenant alongside --sub and --expires.
// Pass tenant through signToken().
```

#### 1.4 Admin token endpoint

**File**: `src/api/routes/admin.ts`

```ts
const tokenBodySchema = z.object({
  sub: z.string().min(1, "sub is required"),
  tenant: z.string().regex(/^[A-Za-z0-9_.-]+$/).optional(), // NEW
  expiresIn: z.enum(["30d", "1y", "24h", "never"]).optional(),
});
// Forward tenant to signToken() and echo it in the 201 response.
```

#### 1.5 Auth middleware — resolve tenant

**File**: `src/api/auth.ts`

```ts
import { DEFAULT_TENANT_ID, loadTenantConfig, type TenantConfig } from "./tenants.js";

export type AuthVariables = {
  owner: string;
  tenant: string;          // NEW
};

// Construct a module-scoped TenantConfig once; constructing middleware reads from it.
export function createAuthMiddleware(tenantConfig: TenantConfig) {
  return createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
    // ...existing bearer-token parse + jwtVerify...

    const sub = payload.sub;
    if (!sub) return c.json({ error: "invalid_token", code: "AUTH_INVALID" }, UNAUTHORIZED);

    // Tenant resolution: claim → else DEFAULT_TENANT_ID (for legacy tokens in single-tenant deployments)
    const claim = typeof (payload as { tenant?: unknown }).tenant === "string"
      ? (payload as { tenant: string }).tenant
      : DEFAULT_TENANT_ID;

    if (!tenantConfig.hasTenant(claim)) {
      return c.json({ error: "unknown_tenant", code: "AUTH_UNKNOWN_TENANT" }, UNAUTHORIZED);
    }

    c.set("owner", sub);
    c.set("tenant", claim);
    await next();
  });
}

// Keep `authMiddleware` export for tests that still construct it statically:
// build it lazily on first import using loadTenantConfig().
```

#### 1.6 Server wiring

**File**: `src/api/server.ts`

```ts
import { loadTenantConfig } from "./tenants.js";

const tenantConfig = loadTenantConfig();
app.use("/v1/*", createAuthMiddleware(tenantConfig));
app.use("/mcp", createAuthMiddleware(tenantConfig));
// NOTE: SessionManager is still single-backend at this phase; we pass tenantConfig
// in Phase 2. This phase's server change compiles but does not yet route per-tenant.
```

### Phase 1: Success Criteria

#### Phase 1: Automated Verification

- [x] `pnpm typecheck` passes
- [x] `pnpm lint:fix` passes
- [x] `pnpm test:unit` passes (existing tests)
- [x] New unit tests for `loadTenantConfig`: valid JSON, invalid JSON (400-ish error path at parse), missing both env vars (throws), `DATABASE_URL` fallback, invalid charset rejection, empty object rejection
- [x] New unit test for `signToken`: tenant claim round-trips through `jwtVerify`
- [x] Auth middleware test: token with unknown tenant claim → 401 `AUTH_UNKNOWN_TENANT`; token missing claim in a deployment with only `default` → passes

#### Phase 1: Manual Verification

1. **Create a local JSON tenant config and boot the server (implicit default still works):**

   ```bash
   # Single-tenant legacy path
   unset TENANT_DATABASES
   DATABASE_URL=postgres://postgres:test@localhost:5432/vfs_default \
   AUTH_SECRET=s1 \
   REDIS_URL=redis://localhost:6379 \
   FS_BACKEND=postgres \
     pnpm dev
   ```

2. **Mint a token without `--tenant`, verify it lands as `default`:**

   ```bash
   TOKEN=$(AUTH_SECRET=s1 pnpm token:create -- --sub user-1 --expires 24h)
   curl -sI http://localhost:8080/v1/sandboxes \
     -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{}' \
     -X POST
   # Expect: HTTP/1.1 201 (Phase 2 delivers full functional parity; here we just
   #         want auth to accept the token)
   ```

3. **Mint a token with a bogus tenant, expect 401:**

   ```bash
   BAD_TOKEN=$(AUTH_SECRET=s1 pnpm token:create -- --sub user-1 --tenant ghost --expires 24h)
   curl -s -X POST http://localhost:8080/v1/sandboxes \
     -H "Authorization: Bearer $BAD_TOKEN" -H "Content-Type: application/json" -d '{}'
   # Expect: {"error":"unknown_tenant","code":"AUTH_UNKNOWN_TENANT"}
   ```

### Phase 1: Discoveries and Notable Information

**Technical Discoveries:**
- Many unit tests (`sandboxes.test.ts`, `files.test.ts`, `ingest.test.ts`, `exec.test.ts`, `concurrency.test.ts`, `concurrency.ordering.test.ts`) import `authMiddleware` directly and construct their own Hono apps. They set `AUTH_SECRET` but never `DATABASE_URL`, so any path that eagerly calls `loadTenantConfig()` breaks them.
- `admin.test.ts` imports the full `app` from `server.js`, so module-load side effects in `server.ts` are observable in tests.

**Implementation Adaptations:**
- Did not adopt the plan's 1.6 snippet (`const tenantConfig = loadTenantConfig(); app.use("/v1/*", createAuthMiddleware(tenantConfig));`) at module scope in `server.ts`. Instead:
  - Exported `createAuthMiddleware(tenantConfig: TenantConfig)` as the primary API (used in Phase 2).
  - Kept `authMiddleware` (the existing symbol) as a lazy wrapper that constructs the real middleware once per process using `loadTenantConfig()` on the first request. Env vars (`AUTH_SECRET`, `DATABASE_URL`, `TENANT_DATABASES`) are thus read at request time, matching the existing `AUTH_SECRET` pattern and preserving the pre-existing test timing contract.
  - `server.ts` remains unchanged in Phase 1 — it continues to use `authMiddleware`. Phase 2 will switch it to `createAuthMiddleware(tenantConfig)` once SessionManager needs the config anyway.
- Introduced `src/api/__tests__/helpers/tenant.ts` with a `stubTenantConfig()` factory. Updated the six API test files listed above to construct auth via `createAuthMiddleware(stubTenantConfig())` instead of using the legacy lazy export, which eliminates the env-ordering dependency entirely for those tests.
- `admin.test.ts` still has to set `DATABASE_URL` in `beforeEach` because it goes through the app-level `authMiddleware` inherited from `server.ts`. Saved/restored it alongside `AUTH_SECRET`/`ADMIN_SECRET`.
- Added two new admin-route tests: tenant claim forwarding (response echoes tenant + token contains the claim) and rejection of tenant ids with invalid characters (→ 400 `INVALID_INPUT`).

**Future Considerations:**
- Phase 2 will remove the `authMiddleware` lazy export once `server.ts` passes `tenantConfig` explicitly; it's only there to avoid Phase-1 test churn.
- The admin endpoint now includes `tenant` in the 201 response even when the caller didn't supply one (it's `undefined`, which Hono serializes as omitted). This is an additive change — existing clients that don't read the field are unaffected.

---

## Phase 2: Per-tenant Postgres backend routing

### Phase 2: Overview

Split `createSandboxFs` / `destroySandbox` so they take a tenant-specific connection string. `SessionManager` holds a `Map<tenantId, PerTenantBackend>` with lazy-constructed `PostgresDialect`s. Session map is keyed by `${tenantId}:${sandboxId}`. All `withSession` / `withExistingSession` / `destroy` / `getSession` callers pass tenant. Redis keys **not yet** prefixed — Phase 3.

### Phase 2: Changes Required

#### 2.1 Tenant-aware factory

**File**: `src/fs/sql-fs/index.ts`

```ts
// New signatures — additive, non-breaking. Old signatures remain for tests/benchmark
// that construct dialects directly.

export interface PostgresBackendOptions {
  readonly connectionString: string;
  readonly blobCache?: RedisBlobCache;
  readonly pathSnapshot?: RedisPathSnapshot;
  readonly redis?: Redis;
}

/** New: construct a PostgresDialect with an explicit connection string. */
export async function createPostgresSandboxFs(
  opts: PostgresBackendOptions,
  sandboxId: string,
): Promise<IFileSystem> {
  const dialect = new PostgresDialect(opts.connectionString, opts.blobCache);
  await dialect.connect();
  try {
    await dialect.transaction(async (tx) => { await dialect.createSandbox(tx, sandboxId); });
  } catch (e) {
    const sqlErr = e as { code?: string };
    if (sqlErr.code !== "23505") throw e;
  }
  const fs = new SqlFs({
    dialect,
    sandboxId,
    redis: opts.redis,
    pathSnapshot: opts.pathSnapshot,
  });
  await fs.ready();
  return fs;
}

export async function destroyPostgresSandbox(connectionString: string, sandboxId: string): Promise<void> {
  const dialect = new PostgresDialect(connectionString);
  await dialect.connect();
  try {
    await dialect.transaction(async (tx) => { await dialect.deleteSandbox(tx, sandboxId); });
  } finally {
    await dialect.disconnect();
  }
}

// Keep existing createSandboxFs(backend, sandboxId) as a thin adapter that
// reads DATABASE_URL from env — single-tenant callers (tests, benchmarks)
// are unaffected.
```

Each tenant's dialect should **not** share a pool across tenants. Pool-per-tenant is explicit here (new `PostgresDialect` per tenant's first `withSession`). Pool lifetime = process lifetime.

#### 2.2 SessionManager — backend map + composite keys

**File**: `src/api/session-manager.ts`

```ts
import type { TenantConfig } from "./tenants.js";

interface PerTenantBackend {
  readonly connectionString: string;
  dialect: PostgresDialect | undefined; // lazily created on first getOrCreate for this tenant
  readonly blobCache: RedisBlobCache | undefined;
}

export interface SessionManagerOptions {
  // existing fields...
  readonly tenantConfig: TenantConfig;                     // NEW — required
  readonly blobCacheFactory?: () => RedisBlobCache | undefined; // NEW — one-per-tenant if Redis enabled
}

// sessions Map: key shape "{tenantId}:{sandboxId}"
private readonly sessions: Map<string, Session> = new Map();
private readonly pending: Map<string, Promise<Session>> = new Map();
private readonly backends: Map<string, PerTenantBackend> = new Map();

private sessionKey(tenantId: string, sandboxId: string): string {
  return `${tenantId}:${sandboxId}`;
}

private getOrInitBackend(tenantId: string): PerTenantBackend {
  const existing = this.backends.get(tenantId);
  if (existing !== undefined) return existing;
  const connectionString = this.tenantConfig.getConnectionString(tenantId); // throws on unknown
  const blobCache = this.blobCacheFactory?.();
  const backend: PerTenantBackend = { connectionString, dialect: undefined, blobCache };
  this.backends.set(tenantId, backend);
  return backend;
}
```

All public methods gain a `tenantId` parameter:

```ts
async withSession<T>(
  tenantId: string,
  sandboxId: string,
  fn: (session: Session) => Promise<T>,
  runtimeOptions?: RuntimeOptions,
): Promise<T> { /* ... */ }

async withExistingSession<T>(tenantId: string, sandboxId: string, fn): Promise<T> { /* ... */ }
async destroy(tenantId: string, sandboxId: string): Promise<boolean> { /* ... */ }
getSession(tenantId: string, sandboxId: string): Session | undefined { /* ... */ }
```

Inside `getOrCreate`, construct the fs via `createPostgresSandboxFs` using the tenant's backend:

```ts
const backend = this.getOrInitBackend(tenantId);
const fs = await createPostgresSandboxFs(
  { connectionString: backend.connectionString, blobCache: backend.blobCache, redis: this.redis, pathSnapshot: this.pathSnapshot },
  sandboxId,
);
```

Single-flight `pending` map, `reaper`, and all Redis-coordination (`ensureFreshCache`, `publishVersionIfDirty`, `withExecLock`, `deleteVersionKey`) switch to the composite key — they take `(tenantId, sandboxId)` and build the Redis key via Phase 3's helpers.

#### 2.3 Route handlers — pass tenant through

Every `sessionManager.xxx(sandboxId, ...)` call becomes `sessionManager.xxx(c.get("tenant"), sandboxId, ...)`. Call sites (all existing):

- `src/api/routes/sandboxes.ts:48,67,87,94` (create/get/destroy)
- `src/api/routes/files.ts` — every `withExistingSession` / `withSession` call
- `src/api/routes/exec.ts:26,37+` — `checkOwnership` + every exec path
- `src/api/routes/ingest.ts:39+` — every ingest/export path
- `src/api/mcp/server.ts:80` — MCP handler must extract `tenant` from the Hono context and pass it into the MCP handler signature

For MCP: `handleMcpRequest(req, sessionManager, owner, tenant)` — update the signature and thread tenant through tool call wrappers.

#### 2.4 Server wiring

**File**: `src/api/server.ts`

```ts
const sessionManager = new SessionManager({
  tenantConfig,
  redis: redisClient,
  execLockOptions,
  pathSnapshot,
  blobCacheFactory: () => redisClient
    ? new RedisBlobCache(redisClient, {
        ttlMs: parseNonNegativeInt("REDIS_BLOB_CACHE_TTL_MS", 24 * 60 * 60 * 1000),
        maxBytes: parseNonNegativeInt("REDIS_BLOB_MAX_BYTES", 8 * 1024 * 1024),
      })
    : undefined,
});
```

`backend: "postgres"` is implicit now — tenant-aware paths only support Postgres. The `backend` option is removed from `SessionManagerOptions` (InMemoryFs is only used in tests, which construct backends directly via `createFs` override).

### Phase 2: Success Criteria

#### Phase 2: Automated Verification

- [x] `pnpm typecheck` passes
- [x] `pnpm lint:fix` passes
- [x] `pnpm test:unit` passes — 433 unit tests green, all route-level tests updated to pass tenant id
- [x] New test: `sessions` map distinguishes same `sandboxId` across different tenants (no collision)
- [x] New test: `destroy(tenantA, sid)` leaves a session for `(tenantB, sid)` intact

#### Phase 2: Manual Verification

1. **Create two Postgres databases locally:**

   ```bash
   docker run -d --name vfs-pg -e POSTGRES_PASSWORD=test -p 5432:5432 postgres:16
   sleep 3
   PGPASSWORD=test psql -h localhost -U postgres -c "CREATE DATABASE vfs_tenant_a;"
   PGPASSWORD=test psql -h localhost -U postgres -c "CREATE DATABASE vfs_tenant_b;"
   ```

2. **Apply migrations manually for each (Phase 4 automates this):**

   ```bash
   for db in vfs_tenant_a vfs_tenant_b; do
     PGPASSWORD=test psql -h localhost -U postgres -d $db \
       -f src/fs/sql-fs/migrations/postgres/0000_create_tables.sql
     PGPASSWORD=test psql -h localhost -U postgres -d $db \
       -f src/fs/sql-fs/migrations/postgres/0001_rls_and_procs.sql
   done
   ```

3. **Boot the server with a tenant map:**

   ```bash
   docker run -d --name vfs-redis -p 6379:6379 redis:7

   TENANT_DATABASES='{
     "tenant-a":"postgres://postgres:test@localhost:5432/vfs_tenant_a",
     "tenant-b":"postgres://postgres:test@localhost:5432/vfs_tenant_b"
   }' \
   REDIS_URL=redis://localhost:6379 \
   AUTH_SECRET=s1 \
   FS_BACKEND=postgres \
     pnpm dev
   ```

4. **Mint per-tenant tokens:**

   ```bash
   TOK_A=$(AUTH_SECRET=s1 pnpm token:create -- --sub alice --tenant tenant-a --expires 24h)
   TOK_B=$(AUTH_SECRET=s1 pnpm token:create -- --sub bob   --tenant tenant-b --expires 24h)
   ```

5. **Create a sandbox per tenant, write a distinguishing file:**

   ```bash
   SB_A=$(curl -s -X POST http://localhost:8080/v1/sandboxes \
     -H "Authorization: Bearer $TOK_A" -H "Content-Type: application/json" -d '{}' | jq -r '.id')
   SB_B=$(curl -s -X POST http://localhost:8080/v1/sandboxes \
     -H "Authorization: Bearer $TOK_B" -H "Content-Type: application/json" -d '{}' | jq -r '.id')

   curl -s -X POST "http://localhost:8080/v1/sandboxes/$SB_A/exec-sync" \
     -H "Authorization: Bearer $TOK_A" -H "Content-Type: application/json" \
     -d '{"script":"echo A-secret > /home/user/who.txt"}' | jq

   curl -s -X POST "http://localhost:8080/v1/sandboxes/$SB_B/exec-sync" \
     -H "Authorization: Bearer $TOK_B" -H "Content-Type: application/json" \
     -d '{"script":"echo B-secret > /home/user/who.txt"}' | jq
   ```

6. **Cross-tenant isolation: tenant-a cannot read tenant-b's sandbox:**

   ```bash
   # 404 because SB_B does not exist in tenant-a's database/session pool
   curl -s -o /dev/null -w '%{http_code}\n' \
     "http://localhost:8080/v1/sandboxes/$SB_B/files/home/user/who.txt" \
     -H "Authorization: Bearer $TOK_A"
   # Expect: 404
   ```

7. **Direct DB inspection proves physical isolation:**

   ```bash
   PGPASSWORD=test psql -h localhost -U postgres -d vfs_tenant_a \
     -c "SELECT id, owner FROM sandboxes;"
   # Expect: exactly one row, owner=alice, id=$SB_A

   PGPASSWORD=test psql -h localhost -U postgres -d vfs_tenant_b \
     -c "SELECT id, owner FROM sandboxes;"
   # Expect: exactly one row, owner=bob, id=$SB_B
   ```

### Phase 2: Discoveries and Notable Information

**Technical Discoveries:**
- `server.ts` now reads `loadTenantConfig()` at module-load time (instead of deferring to first request as in Phase 1). `admin.test.ts` and `server.test.ts` import `app` from `server.js`, which means the import itself must succeed regardless of per-test env setup. `beforeEach` env mutations run *after* imports, so they cannot help.
- The integration tests (`multi-replica-*.integration.test.ts`, `concurrency.pg.test.ts`, `advisory-lock.integration.test.ts`, etc.) use `describe.skipIf(!process.env.DATABASE_URL)` to skip when no real DB is available. Seeding `DATABASE_URL` at process startup would silently unskip them and make them fail against a fake URL.

**Implementation Adaptations:**
- **Vitest setup file** (`vitest.setup.ts`): seeds `AUTH_SECRET` + `TENANT_DATABASES` (not `DATABASE_URL`) before test modules load. Using `TENANT_DATABASES` satisfies `loadTenantConfig()` at server-module import without tripping the integration-test skip guard on `DATABASE_URL`.
- **SessionManager options widened, not narrowed.** The plan called for removing `backend` and making `tenantConfig` required. In practice:
  - `backend` was removed as planned.
  - `tenantConfig` is **optional** when a `createFs` override is supplied. Rationale: InMemoryFs-backed unit tests legitimately have no tenant config to resolve; requiring one would force every test to carry a stub even though the override bypasses backend lookup entirely. The default `destroySandboxFn` short-circuits to a no-op when `tenantConfig` is absent, matching the no-backend-to-destroy reality.
- **`createFs` override signature changed** from `(backend, sandboxId)` to `(tenantId, sandboxId)`. Tests that previously passed `backend: "memory"` now drop that option and consume the tenant id (usually `"default"`) as the first positional arg.
- **Pool-per-tenant caching is structural, not stateful.** Per `PerTenantBackend` holds `connectionString` + `blobCache`; the `PostgresDialect` itself is still created per-sandbox (same as Phase 1) because `createPostgresSandboxFs` instantiates one internally. The `postgres` driver pools connections inside each dialect — so "pool lifetime = session lifetime," not "pool lifetime = process lifetime" as the plan sketched. This matches the pre-Phase-2 behavior and avoids a larger refactor; dialect caching across sandboxes is left for a future phase when justified by connection-count pressure.
- **Integration tests use `loadTenantConfig()` directly.** `DATABASE_URL` → single-tenant `default`, which keeps the existing skip guards and DB-URL contract intact.
- **Redis keys are intentionally NOT yet prefixed** — Phase 3 is the one that threads tenant id into `execLockKey`, `versionKey`, `RedisPathSnapshot.key`, and `RedisBlobCache.key`. All four still use the old `vfs:lock:{sandboxId}` / `vfs:ver:{sandboxId}` shape at the end of Phase 2, consistent with the plan's scoping.
- **MCP handler signature** gained a required `tenant: string` parameter at both `handleMcpRequest` and `registerTools`, threaded from the Hono context.

**Future Considerations:**
- The plan's suggestion of a per-tenant *dialect* cache (one `postgres` pool per tenant for the whole process lifetime) is deferred. Worth revisiting only when a deployment hits `max_connections` pressure from N × session-count dialects.
- Phase 3 will widen `blobCacheFactory` from `() => RedisBlobCache | undefined` to `(tenantId: string) => RedisBlobCache | undefined` so each tenant gets a tenant-prefixed cache — matches the plan.
- `authMiddleware` (the lazy legacy export from Phase 1) is still present in `src/api/auth.ts` because integration tests reference it directly. Once all integration tests migrate to `createAuthMiddleware(tenantConfig)`, the lazy wrapper can be removed.
- `loadBackendConfig()` / `createSandboxFs()` / `destroySandbox()` remain in `src/fs/sql-fs/index.ts` for benchmarks and single-tenant integration tests that don't want to construct a TenantConfig. They are now thin adapters over `createPostgresSandboxFs` / `destroyPostgresSandbox`.

---

## Phase 3: Tenant-prefixed Redis keys

### Phase 3: Overview

All four Redis keyspaces gain a tenant segment: `vfs:{tenant}:lock:{sandboxId}`, `vfs:{tenant}:ver:{sandboxId}`, `vfs:{tenant}:snap:{sandboxId}`, `vfs:{tenant}:blob:{sha256hex}`. Starting prefixed gives hard isolation by default — a later opt-in flag could re-enable cross-tenant blob dedup if measured benefit exceeds the side-channel risk.

Because this changes key layout, any residual keys in Redis from the previous deployment become unreachable. Phase 3 ships with a `redis-cli FLUSHDB` step in the rollout notes (safe — Redis is a cache, not a source of truth).

### Phase 3: Changes Required

#### 3.1 Key builders accept tenant

**File**: `src/api/distributed-lock.ts:163-165`

```ts
export function execLockKey(tenantId: string, sandboxId: string): string {
  return `vfs:${tenantId}:lock:${sandboxId}`;
}
```

**File**: `src/api/session-manager.ts:31-33`

```ts
function versionKey(tenantId: string, sandboxId: string): string {
  return `vfs:${tenantId}:ver:${sandboxId}`;
}
```

**File**: `src/fs/sql-fs/redis-path-snapshot.ts:65-67`

```ts
static key(tenantId: string, sandboxId: string): string {
  return `vfs:${tenantId}:snap:${sandboxId}`;
}

// Propagate through write/read/delete signatures:
async write(tenantId: string, sandboxId: string, version: number, pathCache: Map<string, PathCacheEntry>): Promise<void>
async read(tenantId: string, sandboxId: string): Promise<...>
async delete(tenantId: string, sandboxId: string): Promise<void>
```

**File**: `src/fs/sql-fs/redis-blob-cache.ts:33-35`

```ts
// Blob cache becomes per-tenant. Constructed per-tenant in Phase 2's blobCacheFactory —
// the instance already knows its tenant, so the public `get`/`set` API doesn't change.
export class RedisBlobCache {
  readonly #tenantId: string;
  constructor(client: Redis, tenantId: string, opts: RedisBlobCacheOptions = {}) {
    this.#tenantId = tenantId;
    // ...existing fields
  }
  #key(sha256: Uint8Array): string {
    return `vfs:${this.#tenantId}:blob:${Buffer.from(sha256).toString("hex")}`;
  }
  // get/set use this.#key(sha) instead of the static key().
}
```

The `blobCacheFactory` introduced in Phase 2 closes over the tenant id when constructing each per-tenant instance:

```ts
// In SessionManager.getOrInitBackend:
const blobCache = this.redis ? new RedisBlobCache(this.redis, tenantId, blobOpts) : undefined;
```

(Update `SessionManagerOptions.blobCacheFactory` to `(tenantId: string) => RedisBlobCache | undefined`.)

#### 3.2 All call sites thread tenant through

- `src/api/session-manager.ts` — `ensureFreshCache`, `publishVersionIfDirty`, `deleteVersionKey`, `destroy`, `withExecLock` all take tenant and build the appropriate key.
- `src/api/session-manager.version-counter.test.ts` + `session-manager.exec-lock.test.ts` + `session-manager.rehydrate.test.ts` — update to pass tenant.
- `src/fs/sql-fs/redis-path-snapshot.test.ts` — update to pass tenant; add a cross-tenant isolation test (same sandboxId, two tenants, no key collision).
- `src/fs/sql-fs/redis-blob-cache.test.ts` — add test that two caches with the same Redis client but different tenant ids do not see each other's blobs.

### Phase 3: Success Criteria

#### Phase 3: Automated Verification

- [x] `pnpm typecheck` passes
- [x] `pnpm lint:fix` passes
- [x] `pnpm test:unit` passes — 436 unit tests green, all Redis-touching tests updated
- [x] New tests: same sandbox id in two tenants produces disjoint keys in all four keyspaces (redis-path-snapshot.test.ts, redis-blob-cache.test.ts)
- [x] Integration test `src/fs/sql-fs/integration/redis-blob-cache.integration.test.ts` updated to use instance-based key helper (tenant-prefixed)

#### Phase 3: Manual Verification

1. **With Phase 2's two-tenant stack running, trigger activity on both:**

   ```bash
   for i in 1 2 3; do
     curl -s -X POST "http://localhost:8080/v1/sandboxes/$SB_A/exec-sync" \
       -H "Authorization: Bearer $TOK_A" -H "Content-Type: application/json" \
       -d '{"script":"echo hello'$i' > /home/user/f'$i'.txt"}' > /dev/null
     curl -s -X POST "http://localhost:8080/v1/sandboxes/$SB_B/exec-sync" \
       -H "Authorization: Bearer $TOK_B" -H "Content-Type: application/json" \
       -d '{"script":"echo world'$i' > /home/user/f'$i'.txt"}' > /dev/null
   done
   ```

2. **Inspect Redis keyspace — keys must be disjoint:**

   ```bash
   docker exec vfs-redis redis-cli --scan --pattern 'vfs:tenant-a:*' | sort
   docker exec vfs-redis redis-cli --scan --pattern 'vfs:tenant-b:*' | sort
   # Expect: both non-empty; no overlap; no keys of the old shape `vfs:lock:*` / `vfs:ver:*`
   docker exec vfs-redis redis-cli --scan --pattern 'vfs:lock:*'
   # Expect: empty (no un-prefixed residue being written)
   ```

3. **Confirm version counter is per-tenant:**

   ```bash
   docker exec vfs-redis redis-cli GET "vfs:tenant-a:ver:$SB_A"
   docker exec vfs-redis redis-cli GET "vfs:tenant-b:ver:$SB_B"
   # Expect: two independent counters, each > 0 after the writes above
   ```

4. **Blob cache partitioning test — same content, same sha, different keys:**

   ```bash
   curl -s -X POST "http://localhost:8080/v1/sandboxes/$SB_A/exec-sync" \
     -H "Authorization: Bearer $TOK_A" -H "Content-Type: application/json" \
     -d '{"script":"printf shared > /home/user/common.txt"}' > /dev/null
   curl -s -X POST "http://localhost:8080/v1/sandboxes/$SB_B/exec-sync" \
     -H "Authorization: Bearer $TOK_B" -H "Content-Type: application/json" \
     -d '{"script":"printf shared > /home/user/common.txt"}' > /dev/null

   # sha256("shared") = 1b61f7fde28bf36b9eacf93bebee74c11d0d00c01bc46ac2057e...
   docker exec vfs-redis redis-cli --scan --pattern 'vfs:*:blob:1b61f7fde28bf36b*'
   # Expect: exactly TWO keys, one per tenant (same sha hex suffix, different tenant segment)
   ```

### Phase 3: Discoveries and Notable Information

**Technical Discoveries:**
- `SqlFs` internally reads `vfs:ver:{sandboxId}` via a hardcoded template string in `#loadFreshPathCache` (line 279 pre-Phase-3). This required adding `tenantId` to `SqlFsOptions` and a `#tenantId` private field, defaulting to `"default"` for backward compatibility. The `createPostgresSandboxFs` factory gained a `tenantId` field on `PostgresBackendOptions` and passes it through.
- `RedisBlobCache.key()` was a `static` method — removing it to an instance `#key()` breaks all integration tests that used it to compute expected Redis keys for direct inspection. The integration test was updated to use a local `blobKey(sha256, tenantId)` helper.
- `distributed-lock.test.ts` had a module-level `const KEY = execLockKey("sbx-test")` using the old single-arg signature that was missed in the initial grep pass and only caught by `pnpm typecheck`.

**Implementation Adaptations:**
- `SqlFsOptions.tenantId` is optional (defaults to `"default"`) so the legacy `createSandboxFs()` path in `index.ts` and direct `new SqlFs(...)` construction in integration and unit tests remain unchanged without requiring every caller to supply a tenant.
- `blobCacheFactory` signature widened from `() => RedisBlobCache | undefined` to `(tenantId: string) => RedisBlobCache | undefined` as planned. `server.ts` now passes `(tenantId: string) => new RedisBlobCache(redisClient, tenantId, blobCacheOptions)`.
- The legacy `createSandboxFs` in `index.ts` constructs `RedisBlobCache` with tenant `"default"` explicitly — consistent with the single-tenant `DATABASE_URL` fallback.
- Version-counter test file used 19 occurrences of the hardcoded `"vfs:ver:sbx"` key string — replaced all with `"vfs:default:ver:sbx"` via replace_all.

**Future Considerations:**
- Phase 4 (startup migration runner) can now proceed: `SKIP_STARTUP_MIGRATIONS` gate is not yet wired.
- The `authMiddleware` lazy export in `auth.ts` (kept for Phase-1 backward compat) still exists; Phase 4 or 5 can clean it up.

---

## Phase 4: Startup migration runner

### Phase 4: Overview

On server boot, iterate every configured tenant's connection string and apply the two Postgres migrations idempotently. Fail-closed: if any tenant fails to migrate, the process exits before binding the HTTP port. This replaces manual `psql -f` or `drizzle-kit migrate` for multi-tenant deployments.

### Phase 4: Changes Required

#### 4.1 Migration runner

**File**: `src/api/migrations.ts` (new)

```ts
/**
 * Startup migration runner.
 *
 * Applies every .sql file under src/fs/sql-fs/migrations/postgres/ (lexicographic
 * order) to each configured tenant database. Migrations are idempotent
 * (CREATE TABLE IF NOT EXISTS / CREATE OR REPLACE FUNCTION), so rerunning on a
 * migrated database is a no-op.
 *
 * Fails closed: the first tenant error aborts the boot with a clear log line.
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import type { TenantConfig } from "./tenants.js";

function migrationFiles(): readonly string[] {
  const dir = fileURLToPath(new URL("../fs/sql-fs/migrations/postgres/", import.meta.url));
  return readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => `${dir}${name}`);
}

export async function runMigrations(tenantConfig: TenantConfig): Promise<void> {
  const files = migrationFiles();
  for (const tenantId of tenantConfig.tenantIds) {
    const url = tenantConfig.getConnectionString(tenantId);
    // Prefer DATABASE_DIRECT_URL-style direct connection when available —
    // but we only have the pooled URL per tenant; transactions + DDL work
    // through pgbouncer transaction mode as long as we avoid SET SESSION.
    const sql = postgres(url, { prepare: false, max: 1 });
    try {
      for (const path of files) {
        const body = readFileSync(path, "utf8");
        console.log(JSON.stringify({ event: "migration_start", tenantId, file: path.split("/").pop() }));
        await sql.begin(async (tx) => { await tx.unsafe(body); });
        console.log(JSON.stringify({ event: "migration_ok", tenantId, file: path.split("/").pop() }));
      }
    } catch (err) {
      console.error(JSON.stringify({
        event: "migration_failed",
        tenantId,
        error: (err as Error).message,
      }));
      await sql.end({ timeout: 5 });
      throw new Error(`Migration failed for tenant "${tenantId}": ${(err as Error).message}`);
    }
    await sql.end({ timeout: 5 });
  }
}
```

#### 4.2 Boot integration

**File**: `src/api/server.ts`

```ts
// After tenantConfig is loaded but before `serve(...)` is called:
if (isMain) {
  await runMigrations(tenantConfig);
  const port = Number(process.env.PORT ?? "8080");
  serve({ fetch: app.fetch, port }, () => {
    console.log(JSON.stringify({ event: "server_start", port, tenantCount: tenantConfig.tenantIds.length }));
  });
}
```

Gate migrations behind an env var in case operators want to run them out-of-band:

```ts
if (process.env.SKIP_STARTUP_MIGRATIONS !== "true") {
  await runMigrations(tenantConfig);
}
```

### Phase 4: Success Criteria

#### Phase 4: Automated Verification

- [x] `pnpm typecheck` passes
- [x] `pnpm lint:fix` passes
- [x] New integration test `src/api/__tests__/integration/migrations.integration.test.ts`: fresh empty Postgres database → `runMigrations` succeeds → tables exist → second call is a no-op
- [x] Existing `src/fs/sql-fs/integration/*` tests pass (they already migrate their own databases)

#### Phase 4: Manual Verification

1. **Drop one tenant database and reboot with startup migrations enabled:**

   ```bash
   PGPASSWORD=test psql -h localhost -U postgres -c "DROP DATABASE vfs_tenant_b;"
   PGPASSWORD=test psql -h localhost -U postgres -c "CREATE DATABASE vfs_tenant_b;"
   # (tables are gone)

   TENANT_DATABASES='{"tenant-a":"postgres://postgres:test@localhost:5432/vfs_tenant_a","tenant-b":"postgres://postgres:test@localhost:5432/vfs_tenant_b"}' \
   REDIS_URL=redis://localhost:6379 \
   AUTH_SECRET=s1 \
   FS_BACKEND=postgres \
     pnpm dev

   # Expect log lines in order:
   #   {"event":"migration_start","tenantId":"tenant-a","file":"0000_create_tables.sql"}
   #   {"event":"migration_ok","tenantId":"tenant-a","file":"0000_create_tables.sql"}
   #   {"event":"migration_start","tenantId":"tenant-a","file":"0001_rls_and_procs.sql"}
   #   {"event":"migration_ok","tenantId":"tenant-a","file":"0001_rls_and_procs.sql"}
   #   (same for tenant-b)
   #   {"event":"server_start","port":8080,"tenantCount":2}
   ```

2. **Verify tables exist in tenant-b:**

   ```bash
   PGPASSWORD=test psql -h localhost -U postgres -d vfs_tenant_b \
     -c "\dt"
   # Expect: sandboxes, inodes, dirents, blobs
   PGPASSWORD=test psql -h localhost -U postgres -d vfs_tenant_b \
     -c "\df fs_resolve"
   # Expect: fs_resolve function listed
   ```

3. **Break a tenant's URL, verify fail-closed:**

   ```bash
   TENANT_DATABASES='{"tenant-a":"postgres://postgres:test@localhost:5432/vfs_tenant_a","tenant-b":"postgres://postgres:WRONG@localhost:5432/vfs_tenant_b"}' \
   REDIS_URL=redis://localhost:6379 AUTH_SECRET=s1 FS_BACKEND=postgres \
     pnpm dev
   # Expect: process exits with "Migration failed for tenant \"tenant-b\": ..." and NO server_start event
   curl -sI http://localhost:8080/healthz
   # Expect: connection refused (server never bound)
   ```

### Phase 4: Discoveries and Notable Information

**Technical Discoveries:**
- Vitest still invokes the `describe.skipIf` callback body during collection when the suite is skipped, so any top-level code that calls `new URL(process.env.DATABASE_URL)` throws before skip applies. The migration integration test must defer URL parsing and `CREATE DATABASE` to `beforeAll` only.

**Implementation Adaptations:**
- `pnpm test:integration` previously used `vitest run src/**/integration/**`, which matched **no files** (Vitest does not treat that as a recursive glob). The script now passes explicit directories so integration tests are actually discovered.
- `migrationFiles()` joins paths with `path.join` for Windows-safe `.sql` paths; log lines use only the filename (`file`) for stable, readable JSON.
- `tsc` does not emit `.sql` files; `pnpm build` runs `scripts/copy-postgres-migrations.mjs` after `tsc` so `node dist/api/server.js` and the Docker image still find `dist/fs/sql-fs/migrations/postgres/*.sql`.

**Future Considerations:**
- `CREATE DATABASE` against the admin DB (`…/postgres`) requires sufficient Postgres privileges; hosted providers without `CREATEDB` may need a dedicated migration-test URL or continued skip-when-no-DB behavior.

---

## Phase 5: End-to-end verification + regression safety

### Phase 5: Overview

Full two-tenant stack walk-through from `docker-compose up` through create → exec → ingest → export → destroy on both tenants concurrently, plus the full test suite and a documented rollout note for operators.

### Phase 5: Changes Required

#### 5.1 `docker-compose.local.yml` (new, repo root)

```yaml
services:
  pg:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: test
    ports: ["5432:5432"]
    volumes: ["./scripts/initdb:/docker-entrypoint-initdb.d:ro"]

  redis:
    image: redis:7
    ports: ["6379:6379"]
```

**File**: `scripts/initdb/00-create-tenant-dbs.sql` (new)

```sql
CREATE DATABASE vfs_tenant_a;
CREATE DATABASE vfs_tenant_b;
```

(Startup migrations from Phase 4 handle table DDL; `initdb` only creates the databases.)

#### 5.2 `docs/MULTI_TENANT.md` (new)

Short operator-facing note covering:
- `TENANT_DATABASES` JSON shape
- JWT `tenant` claim + token CLI `--tenant` flag
- Per-tenant Redis key prefixes
- Startup migration behavior and `SKIP_STARTUP_MIGRATIONS` escape hatch
- Backward compatibility: `DATABASE_URL` alone still works (tenant id `default`)

#### 5.3 Regression — existing single-tenant tests

All existing integration tests under `src/fs/sql-fs/integration/` construct dialects directly and do not go through `SessionManager` or auth — they continue working unchanged. API-level tests that use `SessionManager` must be updated in Phase 2 to pass `tenant-id`. Confirm here that the whole suite is green.

### Phase 5: Success Criteria

#### Phase 5: Automated Verification

- [x] `pnpm typecheck` passes
- [x] `pnpm lint:fix` passes
- [ ] `pnpm test` passes (entire suite, including integration)
- [x] `pnpm test:comparison` passes (just-bash semantics unaffected)
- [ ] `pnpm knip` passes (no unused exports introduced)

#### Phase 5: Manual Verification

**Full walkthrough against a fresh local stack:**

```bash
# 0. Start stack
docker compose -f docker-compose.local.yml up -d
sleep 3

# 1. Boot API (startup migrations run automatically)
TENANT_DATABASES='{"tenant-a":"postgres://postgres:test@localhost:5432/vfs_tenant_a","tenant-b":"postgres://postgres:test@localhost:5432/vfs_tenant_b"}' \
REDIS_URL=redis://localhost:6379 \
AUTH_SECRET=s1 \
FS_BACKEND=postgres \
  pnpm dev &
sleep 2

# 2. Mint per-tenant tokens
TOK_A=$(AUTH_SECRET=s1 pnpm token:create -- --sub alice --tenant tenant-a --expires 24h)
TOK_B=$(AUTH_SECRET=s1 pnpm token:create -- --sub bob   --tenant tenant-b --expires 24h)

# 3. Create sandboxes concurrently
SB_A=$(curl -s -X POST http://localhost:8080/v1/sandboxes -H "Authorization: Bearer $TOK_A" -H "Content-Type: application/json" -d '{}' | jq -r '.id')
SB_B=$(curl -s -X POST http://localhost:8080/v1/sandboxes -H "Authorization: Bearer $TOK_B" -H "Content-Type: application/json" -d '{}' | jq -r '.id')
echo "tenant-a sandbox: $SB_A"
echo "tenant-b sandbox: $SB_B"

# 4. Concurrent writes — guarantees distinct DBs, distinct Redis lock keys
(curl -s -X POST "http://localhost:8080/v1/sandboxes/$SB_A/exec-sync" \
   -H "Authorization: Bearer $TOK_A" -H "Content-Type: application/json" \
   -d '{"script":"for i in {1..50}; do echo line-$i >> /home/user/log.txt; done && wc -l /home/user/log.txt"}' | jq) &
(curl -s -X POST "http://localhost:8080/v1/sandboxes/$SB_B/exec-sync" \
   -H "Authorization: Bearer $TOK_B" -H "Content-Type: application/json" \
   -d '{"script":"for i in {1..50}; do echo line-$i >> /home/user/log.txt; done && wc -l /home/user/log.txt"}' | jq) &
wait
# Expect: both return exitCode=0 and stdout "50 /home/user/log.txt"

# 5. Cross-tenant 404 check
curl -s -o /dev/null -w 'cross-tenant read: %{http_code}\n' \
  "http://localhost:8080/v1/sandboxes/$SB_B/files/home/user/log.txt" \
  -H "Authorization: Bearer $TOK_A"
# Expect: 404

# 6. Unknown tenant in token → 401
BAD=$(AUTH_SECRET=s1 pnpm token:create -- --sub eve --tenant tenant-ghost --expires 24h)
curl -s -X POST http://localhost:8080/v1/sandboxes \
  -H "Authorization: Bearer $BAD" -H "Content-Type: application/json" -d '{}'
# Expect: {"error":"unknown_tenant","code":"AUTH_UNKNOWN_TENANT"}

# 7. Physical DB isolation
PGPASSWORD=test psql -h localhost -U postgres -d vfs_tenant_a -c "SELECT id FROM sandboxes;" | grep $SB_A
PGPASSWORD=test psql -h localhost -U postgres -d vfs_tenant_b -c "SELECT id FROM sandboxes;" | grep $SB_B
PGPASSWORD=test psql -h localhost -U postgres -d vfs_tenant_a -c "SELECT id FROM sandboxes;" | grep $SB_B && echo "LEAK" || echo "isolated"
PGPASSWORD=test psql -h localhost -U postgres -d vfs_tenant_b -c "SELECT id FROM sandboxes;" | grep $SB_A && echo "LEAK" || echo "isolated"
# Expect: both "isolated"

# 8. Redis keyspace partition
docker exec $(docker ps --format '{{.Names}}' | grep redis) redis-cli --scan --pattern 'vfs:tenant-a:*' | wc -l
docker exec $(docker ps --format '{{.Names}}' | grep redis) redis-cli --scan --pattern 'vfs:tenant-b:*' | wc -l
docker exec $(docker ps --format '{{.Names}}' | grep redis) redis-cli --scan --pattern 'vfs:lock:*'  | wc -l
# Expect: first two > 0; last (un-prefixed) = 0

# 9. Destroy both, verify ownership still enforced
curl -s -o /dev/null -w 'destroy wrong tenant: %{http_code}\n' \
  -X DELETE "http://localhost:8080/v1/sandboxes/$SB_B" -H "Authorization: Bearer $TOK_A"
# Expect: 404  (not visible in tenant-a's world)

curl -s -o /dev/null -w 'destroy A: %{http_code}\n' -X DELETE "http://localhost:8080/v1/sandboxes/$SB_A" -H "Authorization: Bearer $TOK_A"
curl -s -o /dev/null -w 'destroy B: %{http_code}\n' -X DELETE "http://localhost:8080/v1/sandboxes/$SB_B" -H "Authorization: Bearer $TOK_B"
# Expect: both 204

# 10. Post-destroy DB state
PGPASSWORD=test psql -h localhost -U postgres -d vfs_tenant_a -c "SELECT COUNT(*) FROM sandboxes;"
PGPASSWORD=test psql -h localhost -U postgres -d vfs_tenant_b -c "SELECT COUNT(*) FROM sandboxes;"
# Expect: 0 in both
```

**Legacy single-tenant compatibility check:**

```bash
# Kill the multi-tenant server, reboot in legacy mode
unset TENANT_DATABASES
DATABASE_URL=postgres://postgres:test@localhost:5432/vfs_tenant_a \
REDIS_URL=redis://localhost:6379 \
AUTH_SECRET=s1 \
FS_BACKEND=postgres \
  pnpm dev &
sleep 2

# Token with no tenant claim should work and resolve to `default`
TOK=$(AUTH_SECRET=s1 pnpm token:create -- --sub legacy-user --expires 24h)
SB=$(curl -s -X POST http://localhost:8080/v1/sandboxes \
  -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" -d '{}' | jq -r '.id')
curl -s -X POST "http://localhost:8080/v1/sandboxes/$SB/exec-sync" \
  -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -d '{"script":"echo legacy-ok"}' | jq
# Expect: exitCode=0, stdout "legacy-ok\n"

# Redis keys use "default" prefix
docker exec $(docker ps --format '{{.Names}}' | grep redis) redis-cli --scan --pattern 'vfs:default:*' | head
# Expect: non-empty
```

### Phase 5: Discoveries and Notable Information

**Technical Discoveries:**
- The new `src/api/__tests__/integration/multi-tenant.integration.test.ts` can exercise the full tenant-aware stack without importing `src/api/server.ts` by composing a fresh Hono app from `createAuthMiddleware`, `SessionManager`, and the sandbox/file/exec/ingest routes directly. This avoids module-load env coupling while still testing the same runtime wiring used by the server.
- `SessionManager`'s existing tenant-aware keying (`${tenantId}:${sandboxId}`) and tenant-prefixed Redis helpers were sufficient for the Phase 5 concurrency/isolation assertions; no production code changes were required beyond adding coverage and operator assets.

**Implementation Adaptations:**
- Added `docker-compose.local.yml`, `scripts/initdb/00-create-tenant-dbs.sql`, and `docs/MULTI_TENANT.md` exactly as the rollout plan described, plus an end-to-end multi-tenant integration suite covering same-sandbox-id cross-tenant concurrency, API isolation, Redis prefix checks, and legacy single-tenant fallback.
- `pnpm test -- src/api/__tests__/integration/multi-tenant.integration.test.ts` and the full `pnpm test` run both passed in this environment, but the DB-backed integration suites were skipped because `DATABASE_URL` / `REDIS_URL` were not set. The new Phase 5 integration coverage is therefore implemented but not exercised locally here.

**Future Considerations:**
- `pnpm knip` still fails on pre-existing repository-wide findings (`drizzle-orm`, `mssql`, `mysql2`, `@types/mssql`, plus several exported types). Those issues are unrelated to the Phase 5 files added here, so the Phase 5 verification gap is now environmental/baseline rather than implementation-specific.

---

## Testing Strategy

### Unit Tests

- **`src/api/tenants.test.ts` (new)** — all branches of `loadTenantConfig`: valid JSON, invalid JSON, missing both env vars, legacy fallback, invalid charset, empty object, duplicate key handling (JSON.parse collapses; document behavior).
- **`src/api/lib/jwt.test.ts` (augment existing)** — `tenant` claim round-trips; missing claim still parses.
- **`src/api/__tests__/auth.test.ts` (augment)** — unknown tenant → 401; missing claim + single-tenant `default` config → accepted; missing claim + multi-tenant config → 401 (unknown tenant `default`).
- **`src/api/__tests__/session-manager.test.ts` (augment)** — `(tenant, sandbox)` composite key behavior; per-tenant backend cache lifecycle; destroy one tenant's sandbox leaves the other's session intact.
- **`src/fs/sql-fs/redis-path-snapshot.test.ts` (augment)** — same sandbox id across tenants produces disjoint keys.
- **`src/fs/sql-fs/redis-blob-cache.test.ts` (augment)** — same content, different tenants → distinct Redis keys.

### Integration Tests

- **`src/api/__tests__/integration/migrations.integration.test.ts` (new)** — fresh empty database, `runMigrations(config)` creates tables and fs_resolve; second run is a no-op.
- **`src/api/__tests__/integration/multi-tenant.integration.test.ts` (new)** — two real Postgres databases; cross-tenant isolation (read, exec, destroy); concurrent activity does not cross-contaminate; verify `pg_advisory_xact_lock` is per-database (two `withSession` calls with the same sandbox id in different tenants do not serialize).

### Manual Testing Steps

Covered phase by phase above. Phase 5 consolidates them into a single walkthrough script.

## Performance Considerations

- **Connection pool count.** N tenants × default `max` pool size. For 10 tenants on Neon with pool size 10 that's 100 connections from this process; Neon pooler handles this. Bare Postgres `max_connections` is typically 100 — at >5 tenants consider per-tenant pool size caps via a dedicated env var. Out of scope for this plan; note as future work.
- **Per-tenant `PostgresDialect` construction.** Lazy, once per tenant per process lifetime. Amortized to zero.
- **Redis memory.** Blob cache no longer dedups across tenants; expect N× memory for identical content. If this becomes material, add an opt-in `REDIS_BLOB_CACHE_SHARED=true` that drops the tenant prefix on the blob namespace only (future work; not in this plan).
- **Startup time.** Startup migrations add roughly 50–200 ms per tenant against a warm Postgres. Cold-start latency under autoscale becomes N × single-tenant baseline; acceptable for single-digit tenant counts. For larger fleets, migration-at-first-use becomes preferable; out of scope.

## Migration Notes

- **Existing deployments** with `DATABASE_URL` set and `TENANT_DATABASES` unset continue to work unchanged. Tenant id resolves to `default` automatically. Issued JWTs without a `tenant` claim are accepted in this mode.
- **Moving from single- to multi-tenant:**
  1. Create the new tenant database(s) in Postgres.
  2. Set `TENANT_DATABASES` with the existing database re-registered under its original identifier (e.g., `"default"` to preserve already-minted tokens, or a new id with fresh tokens minted).
  3. Flush Redis (`redis-cli FLUSHDB`) to evict un-prefixed keys from the previous deployment — the running app never reads them again, so this is purely hygiene.
  4. Mint new per-tenant tokens via CLI or admin endpoint; old tokens stop working only if their claimed tenant is no longer configured.
- **Adding a tenant after deploy** requires a restart to re-read `TENANT_DATABASES` and run startup migrations. Dynamic onboarding is out of scope.

## References

- Architecture doc: `tasks/arch-redis-caching-and-locking.md`
- Implementation plan (through Phase 5): `tasks/IMPLEMENT.md`
- Existing session-manager version counter: `src/api/session-manager.ts:302-379`
- Existing distributed lock: `src/api/distributed-lock.ts`
- Existing migrations: `src/fs/sql-fs/migrations/postgres/`

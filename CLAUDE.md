# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

sql-fs-api is a persistent filesystem backend + HTTP/MCP API for [just-bash](https://github.com/nicholasgasior/just-bash) sandboxes. It lets AI agents create isolated bash environments over the network, backed by SQL databases (Postgres, MySQL, Azure SQL) or Azure FileShare. `just-bash` is consumed as an npm dependency — we do NOT modify its source.

**Architecture:**
```
HTTP/MCP Client → Hono API → Session Manager → Bash (just-bash) → IFileSystem → SqlFs → Postgres/MySQL/Azure SQL
                                                                              → ReadWriteFs → Azure FileShare
```

## Commands

```bash
# Development
pnpm dev                    # Start dev server with hot reload (tsx watch) on a fixed port (PORT, default 8080)
pnpm dev:portless           # Preferred: run the dev server on a dynamic port behind a stable https://sql-fs.localhost URL (portless)
pnpm build                  # Compile TypeScript to dist/
pnpm start                  # Run production server from dist/

# Quality
pnpm typecheck              # Type check (tsc --noEmit)
pnpm lint:fix               # Fix lint errors (biome)

# Testing
pnpm test                   # Run ALL tests
pnpm test:unit              # Unit tests only (no DB required)
pnpm test:integration       # Integration tests (requires DB — skips if unavailable)
pnpm test -- src/sql-fs/sql-fs.cache.test.ts   # Run specific test file

# Database
pnpm db:generate            # Scaffold a new migration SQL from schema changes (drizzle-kit)
                            # Migrations are APPLIED automatically on server boot (src/api/migrations.ts), not by a CLI
pnpm db:gc                  # Run multi-tenant orphan-blob GC (external scheduler; see BLOB_GC_MIN_AGE_MS)

# Docker
docker build -t sql-fs-api .
docker run -p 8080:8080 -e FS_BACKEND=postgres -e DATABASE_URL=... sql-fs-api
```

## Architecture

### Core Pipeline

```
HTTP Request → Auth Middleware → Route Handler → Session Manager → Bash.exec(script)
                                                      ↓
                                                 IFileSystem (from just-bash)
                                                      ↓
                                              SqlFs (our implementation)
                                               ↓           ↓
                                          pathCache    contentCache (LRU)
                                               ↓
                                          SqlDialect
                                        ↓      ↓      ↓
                                    Postgres  MySQL  Azure SQL
```

### Key Modules

**SqlFs** (`src/sql-fs/`): The core — implements `IFileSystem` from just-bash using SQL.

- `types.ts` — `SqlDialect` interface, shared types (`InodeRow`, `DirentRow`, `PathCacheEntry`)
- `sql-fs.ts` — Main class: implements all 20+ `IFileSystem` methods, manages pathCache (Map) and contentCache (LRU)
- `errors.ts` — FS error constructors (ENOENT, EEXIST, etc.) and SQL error translation
- `schema.ts` — Drizzle ORM schema (blobs, inodes, dirents, sandboxes tables)
- `index.ts` — Factory: `createSandboxFs()` and `destroySandbox()`
- `dialects/postgres.ts` — Postgres/Neon dialect (uses `postgres` driver)
- `dialects/mysql.ts` — MySQL 8+ dialect (uses `mysql2` driver)
- `dialects/azure-sql.ts` — Azure SQL dialect (uses `mssql`/tedious driver)
- `migrations/` — SQL migration files per dialect

**API** (`src/api/`): HTTP + MCP server wrapping just-bash Sandbox.

- `server.ts` — Hono app entry point, migration runner, health checks
- `auth.ts` — Bearer token auth middleware
- `validation.ts` — Zod request validation middleware
- `session-manager.ts` — Keeps Bash instances warm in memory per sandbox, idle eviction
- `routes/sandboxes.ts` — CRUD: create, get, delete sandboxes
- `routes/files.ts` — File ops: read, write, delete, mkdir, bulk write, tree listing
- `routes/exec.ts` — Bash execution: sync (JSON) and streaming (SSE)
- `routes/ingest.ts` — Ingest (tar.gz / JSON manifest) and export (tar.gz download)
- `blob-gc.ts` — Multi-tenant orphan-blob GC orchestrator (`runBlobGc`); invoked by `cli/gc.ts`
- `cli/gc.ts` — Blob GC CLI (`pnpm db:gc`), for an external cron / k8s CronJob
- `mcp/server.ts` — MCP server setup with streamable HTTP transport
- `mcp/tools.ts` — 10 MCP tool definitions and handlers

### Database Schema (Adjacency List + CAS Blobs)

```
sandboxes (id, root_inode, owner, created_at)
    ↓
inodes (id, sandbox_id, kind[file|dir|symlink], mode, size, mtime, nlink, content_sha256, symlink_target)
    ↓
dirents (parent_inode_id, name, inode_id, sandbox_id)  — PK: (parent_inode_id, name)
    ↓
blobs (sha256, data, size)  — content-addressable, global dedup
```

### Caching Strategy

- **pathCache** (Map<string, CacheEntry>): Loaded once at session start via recursive CTE. Serves `stat()`, `exists()`, `readdir()`, `getAllPaths()` with zero DB calls. Updated synchronously on every write.
- **contentCache** (LRU<bigint, Uint8Array>): Fills lazily on first `readFile()`. Capped at 50MB per session. Evicted LRU when full. Invalidated on write/delete.
- **Rule:** Reads hit cache first. Writes always go to DB first, then update caches. Cache is ephemeral — DB is the source of truth.

## Coding Standards

### TypeScript

- Target: `ES2022`, module: `NodeNext`
- Strict mode: all strict flags enabled, `noUncheckedIndexedAccess: true`
- No `any`. Use `unknown` and narrow. Exception: when wrapping third-party libraries that genuinely return `any`.
- Prefer `interface` over `type` for object shapes that may be extended.
- Use `readonly` on properties that should not be mutated after construction.
- Always specify return types on exported functions. Inferred return types are fine for private/local functions.
- Use `satisfies` over type assertion (`as`) when verifying a value matches a type without widening.

### Error Handling

- Never throw raw strings. Always throw `Error` instances with a `code` property (e.g., `ENOENT`, `EEXIST`).
- SQL errors must be translated to FS error codes via `translateSqlError()` in `errors.ts`. Never let raw SQL errors (with connection strings, table names) bubble up to the API response.
- HTTP errors use `{ error: string, code: string }` shape. Map FS errors: ENOENT→404, EEXIST→409, EISDIR/ENOTDIR→400, EPERM→403.
- Use early returns over nested if/else. Guard clauses at the top of functions.

### Async / Concurrency

- Every `IFileSystem` method is async (returns Promise). Even cache-only methods wrap in `Promise.resolve()` to match the interface.
- SQL operations must run inside explicit transactions via `dialect.transaction(async (tx) => { ... })`.
- Always use `SET LOCAL` (not `SET SESSION`) for sandbox context — required for transaction-mode connection pooling.
- Never use `SELECT ... FOR UPDATE` unless specifically needed for write serialization. Prefer `INSERT ... ON CONFLICT` for TOCTOU elimination.
- Use `AbortController` + `signal` for cancellation (exec timeout, client disconnect).

### Security

- **Sandbox isolation:** RLS on Postgres/Azure SQL, app-level WHERE on MySQL. Every query must be scoped to `sandbox_id`.
- **Symlinks:** Default-deny (`allowSymlinks: false`). Throw EPERM on `symlink()` unless explicitly enabled.
- **Path validation:** All paths must be normalized via `resolvePath` from just-bash's `path-utils`. Reject null bytes.
- **Error sanitization:** All errors pass through `sanitizeFsError` before reaching the API layer. No connection strings, host paths, or internal table names in responses.
- **Auth:** Every `/v1/*` route requires Bearer token. Validate before any DB access.
- **SQL injection:** Use parameterized queries only. Never interpolate user input into SQL strings. The `postgres` driver's tagged templates and Drizzle's query builder handle this automatically — do not bypass them with raw string concatenation.
- **Prototype pollution:** Use `Object.create(null)` for objects with user-controlled keys. Use `Map` where possible.
- **Defense-in-depth:** Opt-in via `JUST_BASH_DEFENSE_IN_DEPTH=true`. When enabled, just-bash monkey-patches host globals (`setTimeout`, `eval`, `Function`, dynamic `import`) during `bash.exec`. All Postgres I/O chokepoints (`#withTx`, `#withReadTx`, `#withBareTx`, `getBlobNoTx`) are wrapped in `DefenseInDepthBox.runTrustedAsync` to bypass the patch. When adding new dialects (MySQL, Azure SQL), this wrapping must be preserved — omitting it will throw `WorkerSecurityViolationError` at runtime.

### Null Prototype Objects

Following just-bash convention: all `Record<string, T>` objects with user-controlled keys must use null prototypes.

```typescript
// BAD
const obj: Record<string, string> = {};

// GOOD
const obj: Record<string, string> = Object.create(null);

// GOOD — for static lookup tables
const TABLE = Object.assign(Object.create(null) as Record<string, string>, {
  key: "value",
});
```

### Testing

- **Framework:** Vitest
- **File naming:** `*.test.ts` files live in a `tests/` subdirectory next to the source they cover (e.g., `src/sql-fs/tests/`); integration tests live under `tests/integration/` or a sibling `integration/` directory.
- **Unit tests:** Mock the `SqlDialect` interface. Test SqlFs methods in isolation. No real DB needed.
- **Integration tests:** Run against real databases. Skip gracefully if DB URL env var is not set: `describe.skipIf(!process.env.DATABASE_URL)(...)`
- **Assert full output:** Prefer exact match (`toBe`, `toEqual`) over partial (`toContain`). Assert both success and error cases.
- **One concern per test:** Each `it()` tests one behavior. Name it `"throws ENOENT when file does not exist"`, not `"error handling"`.
- **Test file size:** Keep under 300 lines. Split into separate files by concern (e.g., `sql-fs.read.test.ts`, `sql-fs.write.test.ts`).
- **Cleanup:** Every test that creates a sandbox must delete it in `afterEach`. Use `try/finally` in integration tests.

### Comments

- **Keep comments lean.** Explain *why*, not *what* — the code already says what it does.
- Prefer one dense sentence over a paragraph. No restating the function signature, no narrating each step.
- A doc comment earns its length only when it records a non-obvious constraint: a failure mode, an
  ordering requirement, a security decision, or an upstream quirk. Cite the audit/issue id when there is one.
- Delete commented-out code rather than leaving it in place.

### Formatting & Linting

- **Biome** for both formatting and linting. Run `pnpm lint:fix` before committing.
- Indent: tabs (configured in biome.json)
- Line width: 120
- No unused imports or variables (enforced by biome)
- Import order: auto-organized by biome

### Dependencies

- `just-bash` is the only runtime dependency that provides the `IFileSystem` interface — import types from `just-bash` directly.
- SQL drivers (`postgres`, `mysql2`, `mssql`) are direct dependencies but only one is loaded at runtime based on `FS_BACKEND`.
- No WASM dependencies (inherited constraint from just-bash).
- Prefer standard library over new dependencies. Only add a dependency if it saves significant complexity (e.g., `lru-cache` for a correct LRU, `zod` for validation).

### Git Conventions

- Branch from `main`
- Commit messages: imperative mood, 1-2 sentences, reference user story (e.g., `US-004: implement Postgres dialect connection and sandbox context`)
- One user story per commit when practical
- Run `pnpm typecheck && pnpm lint:fix && pnpm test:unit` before committing

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `FS_BACKEND` | Yes | `postgres` | `memory` |
| `DATABASE_URL` | SQL backends | Connection string (use pooler endpoint for Neon) |
| `DATABASE_DIRECT_URL` | No | Direct (non-pooler) connection used **only** by drizzle-kit (`pnpm db:generate`). The boot-time migration runner uses `DATABASE_URL` and is pooler-safe. Falls back to `DATABASE_URL`. |
| `FS_MOUNT_PATH` | FileShare backend | Mount path for Azure FileShare |
| `PORT` | No (default: 8080) | HTTP server port |
| `AUTH_SECRET` | Yes | Secret for Bearer token validation |
| `SESSION_IDLE_MS` | No (default: 600000) | Idle timeout before session eviction (ms) |
| `MAX_CONCURRENT_PYTHON` | No (default: 5) | Max concurrent Python executions across all sessions. CPython WASM workers cost ~80MB each (EXIT_RUNTIME per invocation); the semaphore caps concurrency to prevent OOM. Excess scripts queue FIFO. |
| `MAX_CONCURRENT_JS` | No (default: 5) | Max concurrent JavaScript (`js-exec`/`node`) executions across all sessions. QuickJS executions cap at 64MB each. Excess scripts queue FIFO. Note: just-bash currently serializes `js-exec` internally through a single worker, so this cap is an upper bound that may not be binding today. |
| `GITHUB_TOKEN` | No | Optional shared GitHub token. When set, exported into `network:true` sandbox shell env as `GITHUB_TOKEN` for `curl` GitHub API calls, plus `GIT_HTTP_USER=x-access-token` and `GIT_HTTP_PASSWORD=<token>` for GitHub-compatible `git` HTTPS auth. This is a deployment-wide identity readable by network-enabled sandbox code; use only with trusted agents. Per-request `env` overrides it. |
| `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL` | No | Optional git identity values to export into every sandbox shell env so `git commit` has defaults. Per-request `env` overrides them. |
| `REDIS_URL` | No | Redis connection string. Required for multi-replica deployments. When absent, distributed exec lock and all Redis caches are disabled — only in-process `session.mutex` protects execution. Carries the **control plane**: exec/RW locks, version counter, session state. The instance must evict under memory pressure — see **Redis eviction policy** below. |
| `REDIS_DATA_URL` | No (default: `REDIS_URL`) | Connection string for the **data plane** (blob cache, path snapshot). #167: roles always get separate ioredis connections even when this resolves to the same URL, because ioredis pipelines over one socket and a queue of multi-MiB blob `SET`s head-of-line blocks the latency-critical `INCR`/`EVAL` behind them (measured: `INCR` timed out at 2043 ms on the shared connection vs 44 ms on a separate one). Set it to a different Redis only when you also want physical separation. This instance carries the blob cache, so it is the one that must run `maxmemory-policy allkeys-lru` — see **Redis eviction policy** below. |
| `REDIS_EXEC_LOCK_LEASE_MS` | No (default: 60000) | Distributed exec lock lease duration (ms). Lock auto-expires if the holder dies. Must be > `REDIS_EXEC_LOCK_RENEW_MS`. |
| `REDIS_EXEC_LOCK_RENEW_MS` | No (default: 20000) | Heartbeat interval for exec lock renewal (ms). Must be strictly less than `REDIS_EXEC_LOCK_LEASE_MS` to guarantee renewal fires before expiry. |
| `REDIS_EXEC_LOCK_ACQUIRE_TIMEOUT_MS` | No (default: 75000) | Max time to wait to acquire the exec lock before returning 503 (ms). Asserted at startup to be strictly greater than both `REDIS_EXEC_LOCK_LEASE_MS` and `REDIS_RWLOCK_READER_LEASE_MS` — a crashed holder's lock is only reaped when its lease expires, so a shorter window turns crashed-holder recovery into a 503. The default (lease + ~15s reap margin) also keeps the reply inside typical ingress timeouts (commonly 60-240s); the previous 300s sat above them, so the connection was severed and the 503 never reached the client. A caller that must queue behind a full-length 300s exec is expected to retry on the 503. |
| `REDIS_EXEC_LOCK_ACQUIRE_RETRY_MS` | No (default: 50) | Base poll interval (ms) for the distributed acquire/drain retry loops. Each sleep is jittered to `[retryMs/2, retryMs]` to de-synchronize competing replicas and reduce cross-replica writer starvation (F9d). Must be > 0. |
| `REDIS_BLOB_CACHE_ENABLED` | No (default: true) | Set to `false` to disable the Redis blob cache. Blob reads always fall through to Postgres when disabled. |
| `REDIS_BLOB_CACHE_TTL_MS` | No (default: 86400000) | TTL for blob cache entries (ms, default 24h). |
| `REDIS_BLOB_MAX_BYTES` | No (default: 8388608) | Max blob size cached in Redis (bytes, default 8 MB). Blobs larger than this bypass Redis entirely. |
| `REDIS_BLOB_SET_MAX_IN_FLIGHT` | No (default: 32) | Max concurrent `RedisBlobCache.set` backfills. The dialect calls `set` fire-and-forget, so over this cap the write is DROPPED (logged as `redis_blob_set_dropped`), never queued — the cache is fail-open, so the cost is one later Postgres read. |
| `REDIS_BLOB_SET_MAX_IN_FLIGHT_BYTES` | No (default: 33554432) | Max total bytes of concurrent `RedisBlobCache.set` backfills (32 MB). Same drop-not-queue rule. |
| `REDIS_RWLOCK_ENABLED` | No (default: true) | Feature flag for the distributed RW lock keyspace. Set to `false` during rolling deploys when some replicas still run the old exclusive-only lock. When `false`, both writers and readers take the legacy single-key SET-NX lock (`vfs:{tenant}:lock:{sandbox}`) — so flag-off **serializes reads against writers** (no reader/writer parallelism) cross-replica and same-replica. This prevents a reader's cache reload from clobbering a writer's in-memory cache mid-script (F4). Remove after all replicas are on the new code to restore parallel reads. |
| `REDIS_RWLOCK_READER_LEASE_MS` | No (default: 60000) | TTL (ms) for reader entries in the distributed RW lock ZSET. Bounds the time a writer must wait for a crashed reader to be reaped. |
| `REDIS_PATH_SNAPSHOT_ENABLED` | No (default: false) | Set to `true` to enable the Redis path snapshot cache. When enabled, cold-start pathCache is loaded from Redis instead of a full Postgres `loadAllPaths` scan. Requires `REDIS_URL`. |
| `REDIS_PATH_SNAPSHOT_TTL_MS` | No (default: 3600000) | TTL for path snapshot entries (ms, default 1h). |
| `MAX_FILE_WRITE_BYTES` | No (default: contentCache cap, 50 MiB) | Largest single file body any write surface accepts (PUT, PATCH, MCP `file_write`). Raising it past the contentCache cap costs ~4x the memory per file for the whole `SESSION_IDLE_MS`. |
| `MAX_BULK_WRITE_BYTES` | No (default: `MAX_FILE_WRITE_BYTES`) | Largest total decoded byte count one `POST /writeFiles` batch may carry. Defaults to the per-file cap so the bulk route is not a wider door than the single write it batches (#168 — it used to default to 128 MiB against a 50 MiB per-file cap). The request body is separately capped at twice this, counted off the stream before the JSON parse, to leave headroom for JSON string escaping. |
| `MAX_BULK_WRITE_FILES` | No (default: 1000) | Max number of entries in one `POST /writeFiles` batch. |
| `EVENT_LOOP_MONITOR_INTERVAL_MS` | No (default: 10000) | Sampling interval (ms) for the F8 event-loop lag monitor. Each window logs `event:"event_loop_lag"` (`p50Ms`/`p99Ms`/`p999Ms`/`maxMs`/`meanMs`) then resets the histogram. Purely observational; pairs with per-heartbeat `event:"heartbeat_gap"` warn/critical events that flag a stall eating into a Redis lease (see DEVELOPER.md "Lock observability"). The live histogram is also on `GET /readyz` as `eventLoop`. |
| `EVENT_LOOP_STALL_THRESHOLD_MS` | No (default: 2000) | Window `maxMs` above which the sampler also emits `event:"event_loop_stall"` at severity `critical`. Defaults to the Redis client's `commandTimeout` — past it a stall starts timing out in-flight commands belonging to *other* tenants' sandboxes, so it is the point worth paging on (#168). A lone stall does not move `p50Ms`/`p99Ms`; see DEVELOPER.md "Reading the percentiles". |
| `PG_DRIVER_FAULT_GUARD` | No (default: `true`) | Keeps the process alive when `postgres.js` throws out of its own socket-write path (#169): a backend reaped mid-transaction leaves the driver flushing a buffered write to a nulled socket from a bare `setImmediate`, a fatal uncaught exception that takes every other in-flight request on the replica with it. The guard recognises only that frame (`nextWrite` in `postgres/src/connection.js`, on a `TypeError`), logs `event:"driver_socket_fault"`, and fails the stuck DB awaits with `EDRIVERFAULT` → 503; every other uncaught exception and unhandled rejection keeps Node's default crash. Set `false` to restore crash-and-restart. |
| `PG_DRIVER_FAULT_GRACE_MS` | No (default: 5000) | Grace window (ms) a DB await gets after a driver fault before it is failed with `EDRIVERFAULT`. The handler cannot attribute a fault to a connection, so the window spares healthy concurrent statements and bounds only the ones the driver dropped. |
| `JUST_BASH_DEFENSE_IN_DEPTH` | No (default: `false`) | Enables just-bash's defense-in-depth security layer (monkey-patches `setTimeout`, `eval`, `Function`, dynamic `import`, etc. for the duration of `bash.exec`). All Postgres I/O is wrapped in `DefenseInDepthBox.runTrustedAsync` to remain compatible. |
| `JUST_BASH_DEFENSE_AUDIT_MODE` | No (default: `true`) | When `JUST_BASH_DEFENSE_IN_DEPTH=true`, controls whether violations throw (`false`) or are logged only (`true`). Recommended `true` for initial rollout, then flip to `false` once logs are clean. |
| `BLOB_GC_MIN_AGE_MS` | No (default: 10800000) | Grace window (ms, default 3h) before an orphan blob becomes collectible by `pnpm db:gc`. Orphans whose `last_referenced_at` is newer than this are kept; the `ON CONFLICT DO UPDATE` row lock on blob writes is the actual dedup re-adoption race guard — this window is churn/margin control. Rows with NULL `last_referenced_at` (legacy, pre-migration-0006) are treated as ancient and always collectible. Override per-run with `--min-age-ms`. |

### Redis eviction policy

**The Redis carrying the data plane (`REDIS_DATA_URL`, defaulting to `REDIS_URL`) must run `maxmemory-policy allkeys-lru`** — any `allkeys-*` policy works.

Redis defaults to `noeviction`, under which an instance that reaches `maxmemory` refuses every write and **never recovers on its own**: blob cache entries carry a 24h TTL (`REDIS_BLOB_CACHE_TTL_MS`), so waiting it out is not a strategy and a human has to flush keys or raise the limit. The load harness measured 97.6% 5xx with no recovery, against a `CLIENT PAUSE` that recovered the moment the pause lifted (#188). With `allkeys-lru` the same pressure evicts cold blobs, which costs a Postgres read.

`volatile-*` is not sufficient: it evicts only keys carrying a TTL, and on the default single-instance setup the exec-lock leases and version counters carry one too, so it can reap a live lease to cache a blob.

```bash
redis-cli CONFIG SET maxmemory-policy allkeys-lru   # and persist it in redis.conf
```

Checked at boot via `CONFIG GET maxmemory-policy` (`src/redis/eviction-policy.ts`, wired in `server.ts`):

| Outcome | Log line |
|---|---|
| `allkeys-*` | `event:"redis_eviction_policy"` |
| anything else | `event:"redis_eviction_policy_unsafe"`, `severity:"critical"` |
| `CONFIG GET` refused (`NOPERM`, unknown command) | `event:"redis_eviction_policy_unknown"`, `reason:"config_get_denied"` |
| `CONFIG GET` failed or unparseable | `event:"redis_eviction_policy_unknown"`, `reason:"config_get_failed"` |

**It is a warning and never a startup failure**, and it is never awaited — managed providers routinely forbid `CONFIG GET`, and a Redis that answers slowly must not delay `listen`.

## File Layout

```
src/
  sql-fs/                     ← Core: IFileSystem backed by SQL
    types.ts                     ← SqlDialect interface + shared types
    sql-fs.ts                    ← SqlFs class (IFileSystem + caching)
    errors.ts                    ← Error constructors + translation
    schema.ts                    ← Drizzle schema
    index.ts                     ← Factory + destroy
    dialects/
      postgres.ts                ← Postgres/Neon dialect
      mysql.ts                   ← MySQL 8+ dialect
      azure-sql.ts               ← Azure SQL dialect
    migrations/
      postgres/                  ← Postgres DDL + RLS + stored procs
      mysql/                     ← MySQL DDL + stored procs
      azure-sql/                 ← T-SQL DDL + RLS + stored procs
    integration/                 ← DB integration tests (skippable)
  redis/                         ← Role-split clients, breaker, boot-time config checks
    client.ts                    ← control/data ioredis clients
    circuit-breaker.ts           ← per-role breaker
    eviction-policy.ts           ← boot maxmemory-policy check (warn-only)
  api/                           ← HTTP + MCP server
    server.ts                    ← Hono entry + migration runner
    auth.ts                      ← Bearer token middleware
    validation.ts                ← Zod middleware
    session-manager.ts           ← Warm Bash instance pool
    errors.ts                    ← HTTP error helpers
    blob-gc.ts                   ← Orphan-blob GC orchestrator (runBlobGc)
    routes/
      sandboxes.ts               ← CRUD
      files.ts                   ← File operations
      exec.ts                    ← Bash execution (sync + SSE)
      ingest.ts                  ← Ingest/export
    mcp/
      server.ts                  ← MCP server
      tools.ts                   ← Tool definitions + handlers
    cli/
      gc.ts                      ← Blob GC CLI (pnpm db:gc)
    tests/                       ← API unit + e2e tests (integration/ inside)
```

## Changelog & Version Bump Requirement

This project uses **Changesets** (`@changesets/cli`) to manage versions and changelogs. Do not manually edit `CHANGELOG.md` or bump versions in `package.json` / `openapi-spec.ts`.

**Per-PR workflow (every feature/fix PR):**

1. After making changes on a branch, run `pnpm changeset` and describe what changed. This creates a `.changeset/*.md` file — commit it with the rest of the PR.
2. Merge the PR into `main` with the `.changeset/*.md` file included. Do NOT bump the version or edit `CHANGELOG.md` in feature PRs.

**Release workflow (manual `chore: release` PR):**

Release PRs are opened manually — there is no automation that opens them. When you're ready to cut a release, batch all pending changesets on `main` into a single release PR:

```bash
# 1. Start from a clean main
git checkout main && git pull

# 2. Cut a release branch
git checkout -b chore/release

# 3. Consume all pending .changeset/*.md files. This will:
#    - Bump the version in package.json (patch / minor / major from the changeset kinds)
#    - Write CHANGELOG.md entries from the changeset descriptions
#    - Sync src/api/openapi-spec.ts info.version via scripts/sync-openapi-version.mjs
#    - Regenerate pnpm-lock.yaml
#    - Delete the consumed .changeset/*.md files
pnpm changeset:version

# 4. Sanity-check the diff (version bump, CHANGELOG entries, openapi spec, deleted changesets)
git diff

# 5. Commit and push
git add -A
git commit -m "chore: release vX.Y.Z"
git push -u origin chore/release

# 6. Open the PR
gh pr create --title "chore: release vX.Y.Z" --body "Consumes pending changesets and bumps to vX.Y.Z."
```

After the release PR merges to `main`, the release pipeline cuts a GitHub Release automatically because the version in `package.json` changed.

## Implementation Guidance

- Use the current source, tests, and `thoughts/shared/` design records as the authoritative implementation context.
- Write focused tests for each behavioral change.
- Run `pnpm typecheck && pnpm lint:fix && pnpm test:unit` before completing substantial work.

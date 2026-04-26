# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

virtualfs-api is a persistent filesystem backend + HTTP/MCP API for [just-bash](https://github.com/nicholasgasior/just-bash) sandboxes. It lets AI agents create isolated bash environments over the network, backed by SQL databases (Postgres, MySQL, Azure SQL) or Azure FileShare. `just-bash` is consumed as an npm dependency — we do NOT modify its source.

**Architecture:**
```
HTTP/MCP Client → Hono API → Session Manager → Bash (just-bash) → IFileSystem → SqlFs → Postgres/MySQL/Azure SQL
                                                                              → ReadWriteFs → Azure FileShare
```

## Commands

```bash
# Development
pnpm dev                    # Start dev server with hot reload (tsx watch)
pnpm build                  # Compile TypeScript to dist/
pnpm start                  # Run production server from dist/

# Quality
pnpm typecheck              # Type check (tsc --noEmit)
pnpm lint:fix               # Fix lint errors (biome)

# Testing
pnpm test                   # Run ALL tests
pnpm test:unit              # Unit tests only (no DB required)
pnpm test:integration       # Integration tests (requires DB — skips if unavailable)
pnpm test -- src/fs/sql-fs/sql-fs.cache.test.ts   # Run specific test file

# Database
pnpm db:generate            # Generate Drizzle migrations from schema changes
pnpm db:migrate             # Apply migrations to database
pnpm db:gc                  # Run blob garbage collection

# Docker
docker build -t virtualfs-api .
docker run -p 8080:8080 -e FS_BACKEND=postgres -e DATABASE_URL=... virtualfs-api
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

**SqlFs** (`src/fs/sql-fs/`): The core — implements `IFileSystem` from just-bash using SQL.

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
- `routes/admin.ts` — Admin endpoints (blob GC)
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
- **File naming:** `*.test.ts` colocated with source, or in `__tests__/` for integration tests
- **Unit tests:** Mock the `SqlDialect` interface. Test SqlFs methods in isolation. No real DB needed.
- **Integration tests:** Run against real databases. Skip gracefully if DB URL env var is not set: `describe.skipIf(!process.env.DATABASE_URL)(...)`
- **Assert full output:** Prefer exact match (`toBe`, `toEqual`) over partial (`toContain`). Assert both success and error cases.
- **One concern per test:** Each `it()` tests one behavior. Name it `"throws ENOENT when file does not exist"`, not `"error handling"`.
- **Test file size:** Keep under 300 lines. Split into separate files by concern (e.g., `sql-fs.read.test.ts`, `sql-fs.write.test.ts`).
- **Cleanup:** Every test that creates a sandbox must delete it in `afterEach`. Use `try/finally` in integration tests.

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
| `DATABASE_DIRECT_URL` | Postgres (migrations) | Direct connection (not pooler) for DDL |
| `FS_MOUNT_PATH` | FileShare backend | Mount path for Azure FileShare |
| `PORT` | No (default: 8080) | HTTP server port |
| `AUTH_SECRET` | Yes | Secret for Bearer token validation |
| `SESSION_IDLE_MS` | No (default: 600000) | Idle timeout before session eviction (ms) |
| `MAX_CONCURRENT_PYTHON` | No (default: 5) | Max concurrent Python executions across all sessions. CPython WASM workers cost ~80MB each (EXIT_RUNTIME per invocation); the semaphore caps concurrency to prevent OOM. Excess scripts queue FIFO. |
| `MAX_CONCURRENT_JS` | No (default: 5) | Max concurrent JavaScript (`js-exec`/`node`) executions across all sessions. QuickJS executions cap at 64MB each. Excess scripts queue FIFO. Note: just-bash currently serializes `js-exec` internally through a single worker, so this cap is an upper bound that may not be binding today. |

## File Layout

```
src/
  fs/sql-fs/                     ← Core: IFileSystem backed by SQL
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
  api/                           ← HTTP + MCP server
    server.ts                    ← Hono entry + migration runner
    auth.ts                      ← Bearer token middleware
    validation.ts                ← Zod middleware
    session-manager.ts           ← Warm Bash instance pool
    errors.ts                    ← HTTP error helpers
    routes/
      sandboxes.ts               ← CRUD
      files.ts                   ← File operations
      exec.ts                    ← Bash execution (sync + SSE)
      ingest.ts                  ← Ingest/export
      admin.ts                   ← GC endpoint
    mcp/
      server.ts                  ← MCP server
      tools.ts                   ← Tool definitions + handlers
    cli/
      gc.ts                      ← Blob GC CLI
    __tests__/                   ← API e2e tests
tasks/
  prd-virtual-fs-api.md          ← 105 user stories (23 epics)
  IMPLEMENT.md                   ← 6-phase implementation plan
```

## Changelog Requirement

**Always update `CHANGELOG.md` before pushing any branch.** Add a bullet under `## [Unreleased]` describing the change (Added / Changed / Fixed / Removed). The release pipeline reads CHANGELOG to determine whether to cut a new GitHub Release — omitting an entry means the change ships silently with no release notes.

## Implementation Guidance

- Read `tasks/IMPLEMENT.md` for the phased implementation plan with verification steps.
- Read `tasks/prd-virtual-fs-api.md` for full user story details and acceptance criteria.
- Phase 1 (SqlFs + Postgres) must be completed first — everything else depends on it.
- When implementing a user story, check its acceptance criteria and write tests that verify each criterion.
- After completing a set of stories, run `pnpm typecheck && pnpm lint:fix && pnpm test:unit` before moving on.

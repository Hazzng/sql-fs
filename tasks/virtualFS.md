# VirtualFS

A persistent filesystem and API layer built on top of [just-bash](https://github.com/nicholasgasior/just-bash) — enabling AI agents and developers to create, use, and manage sandboxed bash environments remotely with durable file storage.

## What It Is

just-bash provides a virtual bash interpreter with an in-memory filesystem (`InMemoryFs`). VirtualFS extends this with:

1. **Persistent storage backends** — files survive container restarts (SQL databases or Azure FileShare)
2. **HTTP REST API** — create/destroy sandboxes, read/write files, execute bash over the network
3. **MCP server** — same capabilities exposed as compact Model Context Protocol tools for AI agents
4. **Container-ready deployment** — Dockerfile + Azure Container Apps config

```
Agent / Developer
       |
   HTTP / MCP
       |
+------v-------+        +------------------+
| VirtualFS API |------->| Storage Backend  |
| (Hono + MCP)  |        |                  |
|               |        | - Postgres       |
| Session Mgr   |        | - MySQL          |
|   Bash inst.  |        | - Azure SQL      |
|     SqlFs     |        | - Azure FileShare|
+---------------+        | - InMemory (dev) |
                          +------------------+
```

## Why

| Problem | Solution |
|---|---|
| InMemoryFs data lost on process death | SqlFs / FileShare persist across restarts |
| Single-process, no remote access | HTTP API + MCP server enable network access |
| No sandbox isolation between agents | RLS (Postgres/Azure SQL) or directory isolation (FileShare) |
| No content deduplication | Content-addressable blob store (sha256-keyed) |
| Can't scale horizontally | Stateless containers with shared DB; sticky sessions for warm Bash instances |

## Modules

### 1. SqlFs (`src/fs/sql-fs/sql-fs.ts`)

Implements just-bash's `IFileSystem` interface (~20 methods) with SQL as the storage backend. All filesystem operations (readFile, writeFile, mkdir, rm, mv, cp, stat, symlink, etc.) translate to SQL queries against three core tables:

- **inodes** — file/directory/symlink metadata (kind, mode, size, mtime, nlink)
- **dirents** — directory tree as adjacency list (parent_inode_id, name, inode_id)
- **blobs** — content-addressable file content (sha256 PK, data)

Key design decisions:
- **Adjacency list** — `mv` of a subtree is O(1) (single row UPDATE), not O(n)
- **Content-addressable blobs** — automatic deduplication across all files and sandboxes
- **Two-layer caching** — pathCache (Map) for stat/readdir/getAllPaths at 0ms; contentCache (LRU, 50MB budget) for readFile at 0ms on hit
- **Default-deny symlinks** — matches just-bash security posture

### 2. SqlDialect (`src/fs/sql-fs/types.ts`)

Abstract interface for database-specific SQL. Three implementations:

| Dialect | Driver | RLS | Upsert | Hashing | Stored Proc |
|---|---|---|---|---|---|
| **PostgresDialect** | `postgres` (porsager) | Built-in policy | `ON CONFLICT DO UPDATE` | `pgcrypto digest()` | `plpgsql` |
| **MySqlDialect** | `mysql2` | App-level WHERE | `ON DUPLICATE KEY UPDATE` | `SHA2()` built-in | MySQL procedure |
| **AzureSqlDialect** | `mssql` (tedious) | Built-in policy via SESSION_CONTEXT | `MERGE` | `HASHBYTES()` | T-SQL procedure |

Each dialect implements: connection management, transaction handling, sandbox context setting, inode CRUD, dirent CRUD, blob CRUD, path resolution (`fs_resolve` stored procedure with 40-hop symlink depth limit), bulk loading, and garbage collection.

### 3. Path Cache (`pathCache: Map<string, CacheEntry>`)

Loaded at session start via a single recursive CTE query. Serves `stat()`, `lstat()`, `exists()`, `readdir()`, and `getAllPaths()` with zero database calls. Updated synchronously on every write/delete/move operation. Required because `getAllPaths()` is synchronous on the `IFileSystem` interface — can't await a database query.

### 4. Content Cache (`contentCache: LRU<bigint, Uint8Array>`)

LRU cache keyed by inode ID with a configurable byte budget (default 50MB). Fills lazily on first `readFile()`, evicts oldest entries when full. Invalidated on write/delete. Agents re-read files constantly (grep, cat, sed, etc.) — cache hit rate is typically 80-90% after warmup.

### 5. Factory (`src/fs/sql-fs/index.ts`)

Single entry point for creating any filesystem backend:

```ts
const fs = await createSandboxFs({
  type: 'postgres',                    // or 'mysql', 'azure-sql', 'azure-fileshare', 'memory'
  connectionString: process.env.DATABASE_URL,
}, sandboxId);

const bash = new Bash({ fs, cwd: '/home/user' });
```

Backend selected via `FS_BACKEND` environment variable. Azure FileShare backend reuses existing `ReadWriteFs` pointed at a mounted SMB volume — zero new code for the FS layer itself.

### 6. HTTP API (`api/src/`)

Hono-based REST API. Routes:

**Sandbox lifecycle:**
- `POST /v1/sandboxes` — create sandbox
- `GET /v1/sandboxes/:id` — get sandbox info
- `DELETE /v1/sandboxes/:id` — destroy sandbox and all files

**File operations:**
- `GET /v1/sandboxes/:id/files/*path` — read file
- `PUT /v1/sandboxes/:id/files/*path` — write file
- `DELETE /v1/sandboxes/:id/files/*path` — delete file/directory
- `POST /v1/sandboxes/:id/mkdir` — create directory
- `POST /v1/sandboxes/:id/writeFiles` — bulk write
- `GET /v1/sandboxes/:id/tree` — list file tree with metadata

**Bash execution:**
- `POST /v1/sandboxes/:id/exec` — execute bash, stream output via SSE
- `POST /v1/sandboxes/:id/exec-sync` — execute bash, return buffered JSON result

**Ingest / Export:**
- `POST /v1/sandboxes/:id/ingest` — upload tar.gz, extract into sandbox
- `POST /v1/sandboxes/:id/ingest-files` — upload files via JSON manifest
- `GET /v1/sandboxes/:id/export` — download sandbox as tar.gz

**Admin:**
- `POST /v1/admin/gc` — trigger orphan blob garbage collection
- `GET /healthz` / `GET /readyz` — container health probes

Auth via Bearer token on all `/v1/*` routes. Input validation via zod.

### 7. MCP Server (`api/src/mcp/`)

Model Context Protocol server mounted at `/mcp`. Exposes 10 tools with compact names and one-line descriptions to minimize agent context window usage:

`sandbox_create`, `sandbox_delete`, `bash_exec`, `file_read`, `file_write`, `file_delete`, `dir_list`, `dir_make`, `fs_ingest`, `fs_export`

Streamable HTTP transport per MCP 2025-03-26 spec. Bash exec returns buffered results (not streaming) to keep MCP responses simple.

### 8. Session Manager (`api/src/session-manager.ts`)

Keeps Bash instances warm in memory per sandbox. Sequential API calls to the same sandbox reuse the same Bash instance (preserving shell state: env vars, cwd, functions). Idle sessions evicted after 10 minutes (configurable). Sandbox data persists in the database — eviction only drops the in-memory Bash instance.

### 9. Migrations (`src/fs/sql-fs/migrations/`)

Drizzle ORM schema + drizzle-kit for auto-generated table migrations. Hand-written migrations for database-specific features (RLS policies, stored procedures, extensions). Migrations run automatically on container startup before the HTTP server binds.

### 10. Containerization

Multi-stage Dockerfile (`node:22-slim` runtime, <300MB image). Azure Container Apps deployment YAML with sticky sessions, health probes, auto-scaling (1-10 replicas), secrets management, and optional Azure FileShare volume mount.

## Schema (SQL backends)

```
sandboxes
  id UUID PK
  root_inode BIGINT FK -> inodes.id
  owner TEXT
  created_at TIMESTAMPTZ
  last_used_at TIMESTAMPTZ

inodes
  id BIGSERIAL PK
  sandbox_id UUID
  kind SMALLINT (1=file, 2=dir, 3=symlink)
  mode INT
  size BIGINT
  mtime TIMESTAMPTZ
  nlink INT
  content_sha256 BYTEA FK -> blobs.sha256
  symlink_target TEXT

dirents
  parent_inode_id BIGINT FK -> inodes.id
  name TEXT
  inode_id BIGINT FK -> inodes.id
  sandbox_id UUID
  PK (parent_inode_id, name)

blobs
  sha256 BYTEA PK
  data BYTEA
  size BIGINT
```

## Typical Agent Workflow

```
1. POST /v1/sandboxes              -> { id: "abc-123" }
2. POST /v1/sandboxes/abc/ingest   -> upload project tar.gz
3. POST /v1/sandboxes/abc/exec     -> "npm install && npm test"
   (streams stdout/stderr via SSE)
4. POST /v1/sandboxes/abc/exec     -> "cat test-results.json"
5. GET  /v1/sandboxes/abc/export   -> download modified project
6. DELETE /v1/sandboxes/abc        -> cleanup
```

## Tech Stack

| Component | Technology |
|---|---|
| Bash interpreter | just-bash (existing) |
| HTTP framework | Hono |
| MCP SDK | @modelcontextprotocol/sdk |
| Postgres driver | postgres (porsager) |
| MySQL driver | mysql2 |
| Azure SQL driver | mssql (tedious) |
| ORM / migrations | Drizzle ORM + drizzle-kit |
| Content cache | lru-cache |
| Validation | zod |
| Container | node:22-slim |
| Deployment | Azure Container Apps |
| Database | Neon / Azure SQL / MySQL 8+ |
| File storage (alt) | Azure FileShare (SMB mount) |

## File Layout

```
src/fs/sql-fs/
  index.ts              <- factory: createSandboxFs(), destroySandbox()
  sql-fs.ts             <- SqlFs class (IFileSystem + caching)
  types.ts              <- SqlDialect interface, row types, cache types
  schema.ts             <- Drizzle table definitions
  errors.ts             <- FS error constructors + SQL error translation
  dialects/
    postgres.ts
    mysql.ts
    azure-sql.ts
  migrations/
    0000_create_tables.sql
    0001_rls_and_procs.sql
api/
  package.json
  drizzle.config.ts
  src/
    server.ts           <- Hono app + startup migrations
    routes/
      sandboxes.ts
      files.ts
      exec.ts
      ingest.ts
    session-manager.ts
    auth.ts
    validation.ts
    errors.ts
    mcp/
      server.ts
      tools.ts
Dockerfile
.dockerignore
aca.yaml
tasks/
  prd-virtual-fs-api.md  <- full PRD with 105 user stories
  virtualFS.md            <- this file
```

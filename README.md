<p align="center">
  <img src="assets/banner.svg" alt="virtualFS" width="720" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.3.10-blue" alt="Version" />
  <img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen?logo=node.js&logoColor=white" alt="Node.js" />
  <img src="https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/MCP-2025--03--26-8b5cf6" alt="MCP" />
  <img src="https://img.shields.io/badge/license-MIT-22c55e" alt="License" />
</p>

<p align="center">Persistent bash sandboxes over HTTP and MCP — backed by Postgres</p>

---

Most sandbox runtimes lose state when the process dies. virtualFS gives [just-bash](https://github.com/nicholasgasior/just-bash) sandboxes a durable, Postgres-backed filesystem — so an AI agent can create an environment, run commands, come back hours later, and pick up exactly where it left off.

## Why

| Problem | Solution |
|---|---|
| In-memory FS lost on process death | Every write goes to Postgres — container restarts are transparent |
| No remote access | HTTP REST API + MCP server expose bash over the network |
| No isolation between agents | Row-level security (RLS) on `sandbox_id` — sandboxes are hard-isolated at the DB layer |
| Reading the same files on every exec is slow | Two-layer in-process cache: path map (0ms stat/readdir) + LRU content cache (0ms readFile on hit) |
| Horizontal scaling breaks warm session state | Stateless replicas + Redis distributed lock — only one replica runs exec for a sandbox at a time |
| Duplicate file content wastes storage | Content-addressable blob store (sha256-keyed) — identical files across all sandboxes share one row |
| Partial writes on script failure | Entire script runs in one DB transaction — it either fully commits or fully rolls back |

## Quick Start

### In-memory (no DB required)

```bash
pnpm install
FS_BACKEND=memory AUTH_SECRET=localdev pnpm dev
```

### With Postgres

```bash
cp .env.example .env          # set DATABASE_URL and AUTH_SECRET
pnpm db:migrate               # apply migrations
pnpm dev                      # server at http://localhost:8080
```

### Docker Compose

```bash
docker-compose -f docker-compose.local.yml up
```

## Typical Agent Workflow

```bash
pip install virtualfs-sdk
```

```python
from virtualfs import Client
import pathlib

client = Client(
    base_url="http://localhost:8080",
    auth_secret="localdev",   # exchanges for a JWT automatically
    sub="agent-001",
)

# 1. Create sandbox
sb = client.sandboxes.create(name="my-project")

# 2. Ingest project files
files = {str(p): p.read_bytes() for p in pathlib.Path("src").rglob("*") if p.is_file()}
sb.ingest_files(files, base_path="/home/user/src")

# 3. Run commands — stdout/stderr stream back
result = sb.exec("cd /home/user/src && npm install && npm test")
print(result.stdout)

# 4. Export modified sandbox
pathlib.Path("result.tar.gz").write_bytes(sb.export(base_path="/home/user/src"))

# 5. Cleanup
sb.delete()
```

## MCP Server

Mounted at `/mcp`. Streamable HTTP transport per MCP 2025-03-26 spec. Tool names are kept short to minimize agent context window usage.

| Tool | Description |
|------|-------------|
| `sandbox_create` | Create an isolated bash sandbox; optional `python` / `javascript` runtime flags |
| `sandbox_list` | List all sandboxes owned by the current user |
| `sandbox_delete` | Delete a sandbox and all its files |
| `bash_exec` | Execute a bash script, return buffered output |
| `bash_exec_batch` | Execute multiple scripts in one round-trip; `readOnly:false` → sequential under one write-lock, `readOnly:true` → parallel under a shared read-lock |
| `fs_ingest` | Bulk-upload files into a sandbox |
| `fs_export` | Download sandbox files as a JSON map |

## How It Works

### Key invariant

> **Postgres is always the source of truth. Everything else is a cache or a lock.**

In-process caches exist purely for speed during a single exec. Redis serializes requests across replicas and speeds up cold starts. If you dropped Redis and all caches, the system would still be correct — just slower.

### Request flow

```
POST /exec
     │
     ▼
Auth middleware
     │
     ▼
SessionManager.withSession(sandboxId, fn)
     │
     ├─[1] Acquire Redis exec lock       cross-replica mutex (SET NX PX + heartbeat)
     ├─[2] Version check                 if counter changed → reload pathCache from Postgres
     ├─[3] Acquire session.mutex         in-process mutex (same replica, same sandbox)
     ├─[4] bash.exec(script)             the actual work
     │       each write → Postgres tx (RLS scoping + pg_advisory_xact_lock)
     │       → update in-process caches → set dirty = true
     ├─[5] Release session.mutex
     ├─[6] If dirty → INCR version counter → write path snapshot to Redis
     └─[7] Release Redis exec lock
```

### Three lock layers

Three locks stack on top of each other. Each is the fallback for the one above it.

| Lock | Type | Scope | Purpose |
|---|---|---|---|
| `session.mutex` | async-mutex in Node heap | one replica, one sandbox | Prevents two concurrent requests on the same replica from interleaving inside `Bash` or `SqlFs`. Zero network cost. |
| Redis exec lock | `SET NX PX` + heartbeat + Lua release | entire fleet | Only one replica runs exec for a given sandbox at a time. If Redis is down → fail closed (503). |
| `pg_advisory_xact_lock` | Postgres transaction-scoped advisory lock | database | Last line of defense — serializes at DB level when the Redis lock fails (GC pause beyond lease, code paths that bypass `withSession`). Auto-released on commit/rollback; compatible with Neon transaction-mode pooling. |

### Cache layers

| Layer | What | Keyed by | Populated | Invalidated |
|---|---|---|---|---|
| L1 `pathCache` | `Map<path, entry>` — serves stat/readdir/getAllPaths at 0ms | absolute path | `loadAllPaths` recursive CTE at session start; updated on every write | On `reload()` (cross-replica version mismatch) |
| L1 `contentCache` | LRU (50 MB cap) — serves readFile at 0ms on hit | inode ID | Lazy on first `readFile`; bulk-prewarmed after session start | On write/delete to that inode |
| L2 blob cache | Redis bytes — avoids Postgres round-trips for reads | `sha256hex` | Fire-and-forget on every blob write | Never (content is immutable under its sha256) |
| L2b path snapshot | Redis msgpack — speeds up cold starts | `sandboxId` | After every exec that dirtied the FS | On sandbox delete; version mismatch causes automatic fallthrough to Postgres |

### Cross-replica coherence

No pub/sub. A single monotonic version counter in Redis is sufficient because exec serialization (Lock 2) means only one replica ever writes a sandbox at a time.

```
Replica 1:  [acquire lock] → [exec] → [INCR ver] → [release lock]
Replica 2:                    [blocked on Redis lock]
                                                    [acquire lock] → [ver mismatch → reload from Postgres] → [exec]
```

### What is NOT guaranteed

**Multi-step client atomicity.** The lock is held per `exec` call, not across multiple calls. Bundle read-compute-write into one script:

```bash
# BAD — another agent can slip in between the two exec calls
balance=$(cat balance.txt)          # exec 1
echo $((balance - 50)) > balance.txt  # exec 2

# GOOD — the lock is held for the entire script
balance=$(cat balance.txt)
echo $((balance - 50)) > balance.txt
```

**File API + exec mixing.** The `/files/*` HTTP endpoints bypass the exec lock hierarchy. Use `exec` for all production and agent file access; the file API is for admin and test use only.

## Schema

```
sandboxes   id (UUID PK), root_inode, owner, created_at
    │
inodes      id (BIGSERIAL PK), sandbox_id, kind (file|dir|symlink),
            mode, size, mtime, nlink, content_sha256 → blobs, symlink_target
    │
dirents     parent_inode_id, name, inode_id, sandbox_id
            PK: (parent_inode_id, name)   ← adjacency list; mv is O(1)
    │
blobs       sha256 (PK), data, size       ← content-addressable; global dedup
```

Key design choices:
- **Adjacency list** — `mv` of an entire directory subtree is one `UPDATE` row, not O(n)
- **Content-addressable blobs** — identical files across all sandboxes share one blob row
- **RLS on `sandbox_id`** — isolation enforced at the database layer, not just the application

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `FS_BACKEND` | Yes | — | `postgres` \| `memory` |
| `DATABASE_URL` | Yes (postgres) | — | Postgres connection string (use pooler endpoint for Neon) |
| `DATABASE_DIRECT_URL` | Yes (postgres) | — | Direct connection for DDL / migrations |
| `AUTH_SECRET` | Yes | — | Secret for Bearer token validation |
| `PORT` | No | `8080` | HTTP server port |
| `SESSION_IDLE_MS` | No | `600000` | Evict idle Bash instances after this many ms |
| `MAX_CONCURRENT_PYTHON` | No | `5` | Cap on concurrent CPython WASM workers (~80 MB each) |
| `MAX_CONCURRENT_JS` | No | `5` | Cap on concurrent QuickJS workers (~64 MB each) |
| `REDIS_URL` | No | — | Redis connection string. Required for multi-replica deployments. Without it, only the in-process mutex protects execution. |
| `REDIS_EXEC_LOCK_LEASE_MS` | No | `60000` | Distributed exec lock TTL. Must be > `REDIS_EXEC_LOCK_RENEW_MS`. |
| `REDIS_EXEC_LOCK_RENEW_MS` | No | `20000` | Lock heartbeat interval. Must be strictly less than lease. |
| `REDIS_EXEC_LOCK_ACQUIRE_TIMEOUT_MS` | No | `300000` | Max wait to acquire exec lock before returning 503. |
| `REDIS_BLOB_CACHE_ENABLED` | No | `true` | Set `false` to disable Redis blob cache. |
| `REDIS_BLOB_CACHE_TTL_MS` | No | `86400000` | Blob cache entry TTL (24h). |
| `REDIS_BLOB_MAX_BYTES` | No | `8388608` | Blobs larger than this bypass Redis entirely (8 MB). |
| `REDIS_PATH_SNAPSHOT_ENABLED` | No | `false` | Cache full path tree in Redis for faster cold starts. |
| `REDIS_PATH_SNAPSHOT_TTL_MS` | No | `3600000` | Path snapshot TTL (1h). |
| `JUST_BASH_DEFENSE_IN_DEPTH` | No | `false` | Monkey-patches host globals during exec for extra isolation. |
| `JUST_BASH_DEFENSE_AUDIT_MODE` | No | `true` | When defense-in-depth is on: log violations instead of throwing. |

## Deployment

```bash
docker build -t virtualfs-api .
docker run -p 8080:8080 \
  -e FS_BACKEND=postgres \
  -e DATABASE_URL=postgres://... \
  -e AUTH_SECRET=... \
  virtualfs-api
```

For multi-replica deployments, add `REDIS_URL`. All replicas share the same Postgres database and Redis instance; the exec lock ensures only one replica processes a given sandbox at a time.

## Development

```bash
pnpm dev                    # hot-reload dev server
pnpm typecheck              # type check (tsc --noEmit)
pnpm lint:fix               # format + lint (Biome)
pnpm test:unit              # unit tests — no DB required
pnpm test:integration       # integration tests — requires DATABASE_URL
pnpm test                   # all tests
pnpm db:generate            # generate Drizzle migrations from schema changes
pnpm db:migrate             # apply migrations
pnpm db:gc                  # garbage-collect orphan blobs
```

## Benchmarking

`scripts/benchmark_remote_bash.py` measures end-to-end latency through the API — sandbox lifecycle and exec operations — against either virtualFS or [Daytona](https://daytona.io).

```bash
# Against local dev server
API_URL=http://localhost:8080 AUTH_SECRET=localdev pnpm bench:remote-bash

# Against a remote deployment
API_URL=https://your-api.example.com AUTH_SECRET=$AUTH_SECRET pnpm bench:remote-bash

# Against Daytona (requires daytona-sdk: pip install daytona-sdk)
DAYTONA_API_KEY=dtn_... DAYTONA_API_URL=https://app.daytona.io/api \
  python3 scripts/benchmark_remote_bash.py --provider daytona
```

Key flags: `--lifecycle-runs N`, `--warmup N`, `--runs N`, `--timeout-ms MS`. Leftover `bench-*` sandboxes are auto-cleaned at the end.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, coding standards, and the changeset-based versioning workflow.

## License

MIT

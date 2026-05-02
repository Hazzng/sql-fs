<p align="center">
  <img src="assets/banner.svg" alt="virtualFS" width="720" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.2.13-blue" alt="Version" />
  <img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen?logo=node.js&logoColor=white" alt="Node.js" />
  <img src="https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/MCP-2025--03--26-8b5cf6" alt="MCP" />
  <img src="https://img.shields.io/badge/license-MIT-22c55e" alt="License" />
</p>

<p align="center">Persistent bash sandboxes over HTTP and MCP — backed by Postgres</p>

---

Most sandbox runtimes lose state when the process dies. virtualFS gives [just-bash](https://github.com/nicholasgasior/just-bash) sandboxes durable, SQL-backed filesystems — so an AI agent can create an environment, run commands, come back hours later, and pick up exactly where it left off.

### Why it exists

| Problem | Solution |
|---|---|
| In-memory FS lost on process death | SqlFs persists every write to SQL — restarts are transparent |
| Single-process, no remote access | HTTP REST API + MCP server expose bash over the network |
| No isolation between agents | RLS (Postgres) or directory isolation per sandbox |
| Re-reading the same files is slow | Two-layer cache: pathCache (Map) + contentCache (LRU) for filepath and filecontent |
| Horizontal scaling breaks session state | Stateless containers + shared DB; sticky sessions keep warm Bash instances |
| Duplicate file content wastes storage | Content-addressable blob store (sha256-keyed) — identical files share one blob |
| Concurrent bash calls racing on the same sandbox | Advisory locks (Postgres `pg_try_advisory_xact_lock`) serialize writes per sandbox; `INSERT … ON CONFLICT` eliminates TOCTOU on blobs |
| Distributed locking across replicas | Postgres advisory locks are cluster-wide — any replica acquiring the same lock key is blocked until the holder commits |
| Stale cache after cross-replica writes | pathCache and contentCache are per-process and invalidated on every local write; remote writes invalidate via DB as source of truth on next session load |

### Architecture

```
Agent / Developer
       |
   HTTP / MCP
       |
+------v--------+        +--------------------+
| virtualFS API |------->|  Storage Backend   |
| (Hono + MCP)  |        |                    |
|               |        |  Postgres / Neon   |
| Session Mgr   |        |  InMemory (dev)    |
|   Bash inst.  |        +--------------------+
|     SqlFs     |
+---------------+
```

**Core pipeline:**
```
HTTP Request → Auth → Route Handler → Session Manager → Bash.exec(script)
                                             ↓
                                        IFileSystem
                                             ↓
                                    SqlFs (pathCache + contentCache)
                                             ↓
                                        SqlDialect
                                             ↓
                                         Postgres
```

## Quick Start

### Local (in-memory, no DB)

```bash
pnpm install
FS_BACKEND=memory AUTH_SECRET=localdev pnpm dev
```

### Local with Postgres

```bash
cp .env.example .env          # set DATABASE_URL and AUTH_SECRET
pnpm db:migrate               # run migrations
pnpm dev
```

### Docker Compose

```bash
docker-compose -f docker-compose.local.yml up
```

### Auth

Pass `auth_secret` to the SDK — it bootstraps a JWT automatically on first use:

```python
from virtualfs import Client

client = Client(
    base_url="http://localhost:8080",
    auth_secret="localdev",   # exchanges for a JWT behind the scenes
    sub="agent-001",
)
```

## Important: Always use `exec` / `exec_batch` for file operations

**Do not mix the file HTTP API (`/files/*`, `/writeFiles`, `/tree`) with concurrent `exec` calls.** The file API routes bypass the session lock hierarchy — they do not acquire the per-sandbox advisory lock or the Redis exec lock that `exec` goes through. Using them alongside exec creates races that break the guarantees below.

All of these are only guaranteed when all file access flows through `exec` or `exec_batch`:

| Guarantee | Mechanism |
|---|---|
| No two execs interleave on the same sandbox (single replica) | In-process session lock |
| No two execs interleave across replicas | Redis distributed exec lock |
| Cache always reflects the latest committed write at exec entry | Version counter checked on every lock acquisition |
| DB-level data integrity under any concurrent write | `pg_advisory_xact_lock` per sandbox per transaction |

The file HTTP API is intentionally kept for admin and test use only. For anything in production or agent code, run all reads and writes as bash commands inside `exec`.

## Typical Agent Workflow

Install the Python SDK:

```bash
pip install virtualfs-sdk
```

```python
from virtualfs import Client
import pathlib

client = Client(
    base_url="http://localhost:8080",
    auth_secret="localdev",
    sub="agent-001",
)

# 1. Create sandbox
sb = client.sandboxes.create(name="my-project")

# 2. Ingest project files
files = {
    str(p): p.read_bytes()
    for p in pathlib.Path("src").rglob("*")
    if p.is_file()
}
sb.ingest_files(files, base_path="/home/user/src")

# 3. Run commands
result = sb.exec("cd /home/user/src && npm install && npm test")
print(result.stdout)

# 4. Read an output file
report = sb.fs.read_text("/home/user/src/test-results.json")

# 5. Export modified sandbox
tarball = sb.export(base_path="/home/user/src")
pathlib.Path("result.tar.gz").write_bytes(tarball)

# 6. Cleanup
sb.delete()
```

## MCP Server

Mounted at `/mcp`. Streamable HTTP transport per MCP 2025-03-26 spec. Exposes 7 tools:

| Tool | Description |
|------|-------------|
| `sandbox_create` | Create an isolated bash sandbox; optional `python` / `javascript` runtime flags |
| `sandbox_list` | List all sandboxes owned by the current user |
| `sandbox_delete` | Delete a sandbox and all its files |
| `bash_exec` | Execute a bash script in a sandbox, return buffered output |
| `bash_exec_batch` | Execute multiple scripts sequentially in one request — collapses N round-trips into 1 |
| `fs_ingest` | Bulk-upload files into a sandbox (single DB insert) |
| `fs_export` | Download sandbox files as a JSON map |

## Storage Backends

| Backend | Driver | RLS | Notes |
|---------|--------|-----|-------|
| `postgres` | `postgres` (porsager) | Built-in RLS policy | Works with Neon serverless pooler |
| `memory` | — | None | Dev/test only; no persistence |

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `FS_BACKEND` | Yes | — | `postgres` \| `memory` |
| `DATABASE_URL` | Yes (postgres) | — | Connection string (use pooler endpoint for Neon) |
| `DATABASE_DIRECT_URL` | Yes (postgres) | — | Direct connection for DDL/migrations |
| `AUTH_SECRET` | Yes | — | Secret for Bearer token validation |
| `PORT` | No | `8080` | HTTP server port |
| `SESSION_IDLE_MS` | No | `600000` | Idle timeout before Bash instance eviction |
| `MAX_CONCURRENT_PYTHON` | No | `5` | Cap on concurrent CPython WASM workers (~80MB each) |
| `MAX_CONCURRENT_JS` | No | `5` | Cap on concurrent QuickJS workers (~64MB each) |

## Development

```bash
pnpm dev                    # Dev server with hot reload
pnpm typecheck              # Type check (tsc --noEmit)
pnpm lint:fix               # Fix lint errors (Biome)
pnpm test                   # All tests
pnpm test:unit              # Unit tests only (no DB)
pnpm test:integration       # Integration tests (requires DATABASE_URL)
pnpm db:generate            # Generate Drizzle migrations
pnpm db:migrate             # Apply migrations
pnpm db:gc                  # Garbage-collect orphan blobs
```

## Benchmarking

`scripts/benchmark_remote_bash.py` measures end-to-end latency through the API against either virtualFS or [Daytona](https://daytona.io) for direct comparison.

**What it measures:**
- **Phase 1 — Sandbox lifecycle:** `create` / `ingest` / `delete` over N fresh sandboxes
- **Phase 2 — Exec latency:** `find`, `grep`, `rg`, `write`, `delete`, `mkdir`, `mv` on a warm sandbox. Wall-clock ms always reported; `duration_ms` from the server reported for virtualFS

It ingests your local `./src` directory as the test corpus so commands run against realistic files. Output is rendered as markdown tables.

### Prerequisites

```bash
# No install needed for virtualFS — Python SDK loads directly from clients/python
# Only needed if benchmarking against Daytona:
pip install daytona-sdk
```

### Run

```bash
# Against local dev server
API_URL=http://localhost:8081 AUTH_SECRET=localdev pnpm bench:remote-bash

# Against remote deployment
API_URL=https://your-api.example.com AUTH_SECRET=$AUTH_SECRET pnpm bench:remote-bash

# Against Daytona
DAYTONA_API_KEY=dtn_... DAYTONA_API_URL=https://app.daytona.io/api \
  python3 scripts/benchmark_remote_bash.py --provider daytona
```

### Flags

```
--provider {virtualfs,daytona}   default: virtualfs
--src-dir PATH                   corpus to ingest (default: ./src)
--lifecycle-runs N               full create/ingest/delete cycles (default: 3)
--warmup N                       discarded warmup runs per exec case (default: 1)
--runs N                         measured runs per exec case (default: 5)
--timeout-ms MS                  per-exec timeout (default: 60000)
```

For higher confidence: `--lifecycle-runs 5 --warmup 5 --runs 25`. On a high-RTT deployment that's ~10–15 min; on localhost under a minute. Leftover `bench-*` sandboxes are auto-cleaned at the end.

## Deployment

```bash
docker build -t virtualfs-api .
docker run -p 8080:8080 \
  -e FS_BACKEND=postgres \
  -e DATABASE_URL=... \
  -e AUTH_SECRET=... \
  virtualfs-api
```

## Tech Stack

| Layer | Technology |
|-------|------------|
| Bash interpreter | just-bash |
| HTTP framework | Hono |
| MCP SDK | @modelcontextprotocol/sdk |
| Postgres | postgres (porsager) |
| Schema / migrations | Drizzle ORM + drizzle-kit |
| Content cache | lru-cache |
| Validation | zod |
| Runtime | Node.js ≥ 22, node:22-slim container |

## License

MIT

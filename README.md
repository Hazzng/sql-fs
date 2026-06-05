<p align="center">
  <img src="assets/banner.svg" alt="sql-fs" width="720" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.6.3-blue" alt="Version" />
  <img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen?logo=node.js&logoColor=white" alt="Node.js" />
  <img src="https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/just--bash-3.0.1-f59e0b" alt="just-bash" />
  <img src="https://img.shields.io/badge/license-MIT-22c55e" alt="License" />
</p>

<p align="center">Persistent bash sandboxes over HTTP and MCP — backed by Postgres</p>

---

Most sandbox platforms still spin up full VMs—slow cold starts and per-minute billing where costs stack up fast. [just-bash](https://github.com/nicholasgasior/just-bash) is the virtual bash runtime; we built the distributed, persistent layer around it—a Postgres-backed virtual filesystem over HTTP and MCP, with strong consistency across replicas and fast in-process caching, so sandboxes that are cheap to create, quick to resume, and durable across process restarts.

## Why

| Problem | Solution |
|---|---|
| Sandbox cost at scale is expensive with time-based pricing | State lives in your existing Postgres database — no per-minute sandbox billing, just the DB you already pay for |
| No isolation between agents | Row-level security (RLS) on `sandbox_id` — sandboxes are hard-isolated at the DB layer |
| Cold-starting a session re-fetches the entire filesystem from Postgres | Two-layer in-process cache: path map (0ms stat/readdir) + LRU content cache (0ms readFile on hit) |
| Concurrent requests from different replicas corrupt sandbox state | Stateless replicas + Redis distributed lock — only one replica runs exec for a sandbox at a time |
| Duplicate file content wastes storage | Content-addressable blob store (sha256-keyed) — identical files across all sandboxes share one row |
| Partial writes on script failure | Entire script runs in one DB transaction — it either fully commits or fully rolls back |

## Quick Start

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

Python:

```bash
pip install sql-fs-sdk
```

```python
from sqlfs import Client
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
result = sb.exec("grep -r 'TODO' /home/user/src || echo 'no TODOs found'")
print(result.stdout)

# 4. Export modified sandbox (tar + base64 via exec — no dedicated HTTP endpoint)
import base64
r = sb.exec("tar -czf - -C /home/user/src . | base64 -w 0", read_only=True, timeout_ms=60_000)
pathlib.Path("result.tar.gz").write_bytes(base64.b64decode(r.stdout.strip()))

# 5. Cleanup
sb.delete()
```

TypeScript:

```bash
npm install sql-fs-sdk
```

```ts
import { Client } from "sql-fs-sdk";

const client = new Client({
	baseUrl: "http://localhost:8080",
	authSecret: "localdev",
	sub: "agent-001",
});

const sandbox = await client.sandboxes.create({ name: "my-project" });
const result = await sandbox.exec("echo hello");
console.log(result.stdout);
await sandbox.delete();
```

See [clients/typescript/README.md](clients/typescript/README.md) for the full TypeScript API.

## How It Works

> **Postgres is always the source of truth. Everything else is a cache or a lock.**

Each `exec` call flows through three stacked locks — in-process mutex → Redis distributed lock → `pg_advisory_xact_lock` — ensuring only one writer touches a sandbox at a time across any number of replicas. Writes always go to Postgres first; in-process caches (`pathCache` Map, `contentCache` LRU) and Redis (blob cache, path snapshot) are updated after and exist purely for speed.

Cross-replica coherence uses a single monotonic version counter in Redis — no pub/sub needed. When a replica acquires the exec lock and finds the counter advanced, it reloads `pathCache` from Postgres before proceeding.

> **Note:** The `/files/*` HTTP endpoints bypass the exec lock. Use `exec` for all agent and production file access; the file API is for admin and test use only.

## Schema

```
sandboxes   id (UUID PK), root_inode, owner, created_at
    
    │
 
  inodes    id (BIGSERIAL PK), sandbox_id, kind (file|dir|symlink),
            mode, size, mtime, nlink, content_sha256 → blobs, symlink_target
    │
  
 dirents    parent_inode_id, name, inode_id, sandbox_id
            PK: (parent_inode_id, name)  ← adjacency list; mv is O(1)
    │
 
  blobs     sha256 (PK), data, size      ← content-addressable; global dedup
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
| `MAX_REQUEST_BODY_BYTES` | No | `268435456` | Hard cap on any HTTP request body (256 MB) — file write, bulk write, ingest. Applied before auth/handlers. Since base64 inflates content ~33%, this is usually the binding limit on ingest: ~190 MB of raw file bytes per call. |
| `MAX_INGEST_BYTES` | No | `536870912` | Max total decoded bytes across one `ingest-files` manifest (512 MB). The request-body cap above normally trips first. |
| `MAX_INGEST_FILES` | No | `10000` | Max number of entries (files + paths) in one `ingest-files` manifest. |
| `MAX_INGEST_PATHS_CONCURRENCY` | No | `16` | Max concurrent host-file reads for the MCP `paths` ingest mode (bounds file descriptors / memory). |
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
| `ADMIN_RATE_LIMIT_WINDOW_MS` | No | `60000` | Rolling window (ms) for the admin token-generation endpoint. |
| `ADMIN_RATE_LIMIT_MAX` | No | `5` | Max requests per window for the admin token-generation endpoint. |
| `BOOTSTRAP_RATE_LIMIT_WINDOW_MS` | No | `60000` | Rolling window (ms) for the bootstrap token endpoint. |
| `BOOTSTRAP_RATE_LIMIT_MAX` | No | `5` | Max requests per window for the bootstrap token endpoint. |
| `TRUST_PROXY_HEADERS` | No | `false` | Set `true` to read client IP from `X-Forwarded-For` (use only behind a trusted reverse proxy). |

## Deployment

```bash
docker build -t sql-fs-api .
docker run -p 8080:8080 \
  -e FS_BACKEND=postgres \
  -e DATABASE_URL=postgres://... \
  -e AUTH_SECRET=... \
  sql-fs-api
```

For multi-replica deployments, add `REDIS_URL`. All replicas share the same Postgres database and Redis instance; the exec lock ensures only one replica processes a given sandbox at a time.

## Development

```bash
pnpm dev                    # hot-reload dev server
pnpm dev:portless           # dev server exposed via portless tunnel
pnpm typecheck              # type check (tsc --noEmit)
pnpm lint:fix               # format + lint (Biome)
pnpm test:unit              # unit tests — no DB required
pnpm test:integration       # integration tests — requires DATABASE_URL
pnpm test                   # all tests
pnpm db:generate            # generate Drizzle migrations from schema changes
pnpm db:migrate             # apply migrations
pnpm db:gc                  # garbage-collect orphan blobs
pnpm changeset              # record a version bump for the next release
```

## Benchmarking

`scripts/benchmark_remote_bash.py` measures end-to-end latency through the API — sandbox lifecycle and exec operations — against either sql-fs or [Daytona](https://daytona.io).

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

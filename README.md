<p align="center">
  <img src="assets/banner.svg" alt="sql-fs" width="720" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-1.1.0-blue" alt="Version" />
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
pnpm dev                      # applies migrations on first boot, serves at http://localhost:8080
```

Migrations run automatically when the server boots (`src/api/migrations.ts`); there
is no separate migrate step. (`pnpm db:generate` scaffolds a new migration SQL from
`schema.ts` changes via drizzle-kit; the boot-time runner then applies it.)

### Docker Compose

Spin up a local Postgres + Redis for development and the integration test suite:

```bash
docker compose -f docker-compose.local.yml up -d
```

This provisions a **non-superuser** `sqlfs_app` role that owns the `sqlfs`
database — required, because migration `0005` enables `FORCE ROW LEVEL SECURITY`
and a superuser silently bypasses it. See
[CONTRIBUTING.md → Local database](CONTRIBUTING.md#local-database). Then point the
server (or tests) at the stack:

```bash
export DATABASE_URL=postgres://sqlfs_app:sqlfs_app@localhost:5432/sqlfs
export REDIS_URL=redis://localhost:6379
redis-cli CONFIG SET maxmemory-policy allkeys-lru   # local development cache; see production isolation below
pnpm dev                      # or: pnpm test:integration
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

Requests take a local session lock before using the filesystem and a distributed Redis lock when Redis is configured. SQL mutations also use `pg_advisory_xact_lock`. Redis keeps distributed locks and immutable blob bytes cached by hash.

Every filesystem request validates the durable sandbox epoch in PostgreSQL. SqlFs reads the epoch and, when it changes, the path tree in one REPEATABLE READ transaction. It installs both together after the transaction succeeds. A failed authority check returns an error instead of a successful stale read. Cold loads and recovery use the same paired loader. Buffered script mutations remain private to the exclusive session scope until commit.

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
| `DATABASE_DIRECT_URL` | No | `DATABASE_URL` | Direct (non-pooler) connection used **only** by drizzle-kit (`pnpm db:generate`). The server's boot-time migration runner uses `DATABASE_URL`. Falls back to `DATABASE_URL` when unset. |
| `AUTH_SECRET` | Yes | — | Secret for Bearer token validation |
| `PORT` | No | `8080` | HTTP server port |
| `SESSION_IDLE_MS` | No | `600000` | Evict idle Bash instances after this many ms |
| `SQL_FS_WORKERS_ENABLED` | No | `false` | Opt into bounded worker owners. See [worker owners](#worker-owners). |
| `SQL_FS_WORKER_LARGE_FILES` | No | `false` | Remove the worker execution file cap on the measured large-file profile. Requires at least 2 CPUs, a hard memory limit of at least 3 GiB, and the memory thresholds below. |
| `MAX_CONCURRENT_PYTHON` | No | `5` | Parent Python execution allowance. Execs reserve capacity whenever Python is enabled; allow memory for guest teardown as well (~80 MB per guest). |
| `MAX_CONCURRENT_JS` | No | `5` | Parent JavaScript execution allowance. Execs reserve capacity whenever JavaScript is enabled (~64 MB per guest). |
| `MAX_REQUEST_BODY_BYTES` | No | `268435456` | Configured HTTP body ceiling (256 MiB). Inline mode applies it before authentication. Worker mode authenticates first and uses the smaller of this ceiling and the tenant byte quota (96 MiB by default), counting the encoded JSON body, including base64 expansion. |
| `MAX_FILE_WRITE_BYTES` | No | `52428800` | Largest single file body any write surface accepts (PUT, PATCH, MCP `file_write`, and each entry of a batch write), 50 MiB — the contentCache cap. Raising it past that costs ~4x the memory per file for the whole `SESSION_IDLE_MS`. |
| `MAX_BULK_WRITE_BYTES` | No | `MAX_FILE_WRITE_BYTES` | Max total **decoded** bytes in one batch write — `POST /writeFiles` and the `files` map on `POST /v1/sandboxes`. Defaults to the per-file cap so the bulk route is not a wider door than the single write it batches (it used to default to 128 MiB — see #168). The request body itself is capped at **twice** this, counted off the stream before the JSON parse, leaving headroom for JSON string escaping. |
| `MAX_EXEC_FILE_BYTES` | No | `8388608` | Per-file whole reads and writes inside `exec`. With `SQL_FS_WORKER_LARGE_FILES=true`, leaving this unset removes the worker file cap and uses finite aggregate input, message, string, output, intermediate and container budgets. An explicit value retains an operator cap. Exceeding a configured cap returns `EFBIG`, HTTP 413 and `retryable: false`. Direct file routes retain their own limits. |
| `MAX_BULK_WRITE_FILES` | No | `1000` | Max number of entries in one batch write (`POST /writeFiles`, or the `files` map on `POST /v1/sandboxes`). |
| `SCRIPT_TX_BUFFERED` | No | `true` | Buffer a script's metadata mutations in memory and flush them in one short transaction at scope end, instead of holding one transaction open across the whole of `bash.exec` (#166). The legacy shape pinned a pooled server connection for as long as the user's script ran — `sleep`, a Python step, a `git clone` — and under a transaction pooler that wedges the pool at roughly `default_pool_size` concurrent writers. Measured: a 3 s sleeping write script held a backend `idle in transaction` for 2.98 s before, and 0 s after (the flush itself is 5–16 ms and never idles). Set to `false` to restore the old shape without a code change; both are fully wired. Two things change with it on: per-command DB errors surface at the end of the request rather than at the failing command (only possible on cache/DB divergence), and two replicas writing one sandbox concurrently are no longer serialized by a script-long advisory lock — the loser is fenced out with `ESTALE` → **409** instead of queueing. |
| `SCRIPT_TX_BUFFER_MAX_OPS` | No | `50000` | Max buffered mutations in one script scope. Past it the script fails with `ESCRIPTBUFFER` → **413** and **nothing is applied**; the buffer is never flushed early, because that would split one commit into two and break the per-script all-or-nothing guarantee. 5x just-bash's own 10,000-command ceiling, so no single exec can reach it — the heaviest script measured buffered 3,317 operations. |
| `SCRIPT_TX_BUFFER_MAX_BYTES` | No | `33554432` | Max estimated bytes of one script's buffered mutations (32 MiB). Metadata only — paths, names, shas, ids, and the subtree plans `cp -r`/`rm -r` capture. File content is never buffered: `commitBlob` writes it eagerly on its own connection and the GC grace window (`BLOB_GC_MIN_AGE_MS`) covers the gap until the referencing inode commits. |
| `EVENT_LOOP_MONITOR_INTERVAL_MS` | No | `10000` | Sampling window (ms) for the event-loop lag monitor. Each window logs `event_loop_lag` (`p50Ms`/`p99Ms`/`p999Ms`/`maxMs`/`meanMs`); the live histogram is also exposed on `GET /readyz` as `eventLoop`. |
| `EVENT_LOOP_STALL_THRESHOLD_MS` | No | `2000` | Window `maxMs` above which the sampler also emits `event_loop_stall` at severity `critical`. Defaults to the Redis `commandTimeout`: past it a stall starts timing out other tenants' in-flight commands. A lone stall does **not** move `p50Ms`/`p99Ms` — alert on `event_loop_stall` or `maxMs`. |
| `MAX_INGEST_BYTES` | No | `536870912` | Max total decoded bytes across one `ingest-files` manifest (512 MB). The request-body cap above normally trips first. |
| `MAX_INGEST_FILES` | No | `10000` | Max number of entries (files + paths) in one `ingest-files` manifest. |
| `MAX_INGEST_PATHS_CONCURRENCY` | No | `16` | Max concurrent host-file reads for the MCP `paths` ingest mode (bounds file descriptors / memory). |
| `REDIS_URL` | No | — | Redis connection string. Required for multi-replica deployments. Without it, only the in-process mutex protects execution. Carries the control plane: locks and session state. |
| `REDIS_DATA_URL` | No | `REDIS_URL` | Connection string for the data plane (blob cache). A **separate connection** is opened either way, so multi-MiB cache writes cannot head-of-line block a lock command; use a separate Redis instance for data to keep cache eviction isolated from control locks. This instance must run **`maxmemory-policy allkeys-lru`** (or `allkeys-lfu`) — see [Redis eviction policy](#redis-eviction-policy). |
| `REDIS_EXEC_LOCK_LEASE_MS` | No | `60000` | Distributed exec lock TTL. Must be > `REDIS_EXEC_LOCK_RENEW_MS`. |
| `REDIS_EXEC_LOCK_RENEW_MS` | No | `20000` | Lock heartbeat interval. Must be strictly less than lease. |
| `REDIS_EXEC_LOCK_ACQUIRE_TIMEOUT_MS` | No | `75000` | Max wait to acquire exec lock before returning 503. Must be strictly greater than `REDIS_EXEC_LOCK_LEASE_MS` and `REDIS_RWLOCK_READER_LEASE_MS` (asserted at startup), so a crashed holder's lease can be reaped before the waiter gives up. |
| `REDIS_BLOB_CACHE_ENABLED` | No | `true` | Set `false` to disable Redis blob cache. |
| `REDIS_BLOB_CACHE_TTL_MS` | No | `86400000` | Blob cache entry TTL (24h). |
| `REDIS_BLOB_MAX_BYTES` | No | `8388608` | Blobs larger than this bypass Redis entirely (8 MB). |
| `REDIS_BLOB_SET_MAX_IN_FLIGHT` | No | `32` | Max concurrent blob-cache backfill writes, per data connection and shared across all tenants on it. Writes over the cap are dropped (the cache is fail-open), not queued. |
| `REDIS_BLOB_SET_MAX_IN_FLIGHT_BYTES` | No | `33554432` | Max total bytes of concurrent blob-cache backfill writes (32 MB), likewise per data connection and shared across tenants. Same drop-not-queue rule. |
| `PG_DRIVER_FAULT_GUARD` | No | `true` | Keeps the replica alive when `postgres.js` throws out of its own socket-write path (#169) — a backend reaped mid-transaction makes the driver flush a buffered write to a nulled socket from a bare `setImmediate`, which is a fatal uncaught exception that drops every other in-flight request on the replica. The guard recognises that one stack frame (`nextWrite` in `postgres/src/connection.js`), logs `driver_socket_fault`, and fails the stuck DB awaits with `EDRIVERFAULT` → 503. **Everything else still crashes the process.** Set `false` to restore crash-and-restart: right if your orchestrator restarts fast, you would rather lose the replica than serve from one whose pool just lost a connection, and you alert on restarts but not on log events. |
| `PG_DRIVER_FAULT_GRACE_MS` | No | `5000` | How long a DB await may stay pending after a driver fault before it is failed with `EDRIVERFAULT`. The fault handler cannot tell which connection the dropped write belonged to, so the window spares healthy concurrent queries (which settle in ms) while still bounding the ones that will never settle. Raise it if a loaded replica legitimately holds statements open longer than this. |
| `JUST_BASH_DEFENSE_IN_DEPTH` | No | `false` | Monkey-patches host globals during exec for extra isolation. |
| `JUST_BASH_DEFENSE_AUDIT_MODE` | No | `true` | When defense-in-depth is on: log violations instead of throwing. |
| `ADMIN_RATE_LIMIT_WINDOW_MS` | No | `60000` | Rolling window (ms) for the admin token-generation endpoint. |
| `ADMIN_RATE_LIMIT_MAX` | No | `5` | Max requests per window for the admin token-generation endpoint. |
| `BOOTSTRAP_RATE_LIMIT_WINDOW_MS` | No | `60000` | Rolling window (ms) for the bootstrap token endpoint. |
| `BOOTSTRAP_RATE_LIMIT_MAX` | No | `5` | Max requests per window for the bootstrap token endpoint. |
| `TRUST_PROXY_HEADERS` | No | `false` | Set `true` to read client IP from `X-Forwarded-For` (use only behind a trusted reverse proxy). |
| `MCP_API_KEY` | No | — | Enables static-header auth on `/mcp` (see [MCP auth](#mcp-auth-for-static-header-clients-eg-librechat)). Pre-shared secret (≥16 chars) accepted as `Authorization: Bearer <key>`. When unset, `/mcp` stays JWT-only. |
| `MCP_IDENTITY_HEADER` | No | `x-librechat-user-id` | Header whose value becomes the sandbox owner (`sub`) for static-header requests. |
| `MCP_DEFAULT_SUB` | No | — | Owner used for static-header requests when the identity header is absent. When unset, a missing identity header is rejected (`401 AUTH_IDENTITY_REQUIRED`). |
| `MCP_STATIC_TENANT` | No | `default` | Tenant assigned to static-header requests. Must be a configured tenant. |

## Worker owners

With `SQL_FS_WORKERS_ENABLED=true`, a fixed worker pool owns each sandbox's filesystem and Bash runtime, keeping execution off the HTTP event loop. Leave workers disabled on intermediate stack revisions. Deploy PostgreSQL generation fencing to every replica before enabling the complete API and SDK stack on a canary; older replicas cannot safely share that canary. Every session entry, including reads, claims a durable generation under the sandbox's writer advisory lock to prevent stale caches and late writes after recovery.

Admission uses tenant round-robin queues and active per-tenant quotas, with waiting writers taking precedence over new readers of the same sandbox. With two workers, a tenant can hold one active operation. Ordinary API and MCP tool requests use four retained ingress permits per tenant out of eight globally. Long-lived MCP `GET /mcp` event streams use a separate finite listener quota, so idle listeners do not consume tool-call permits; both pools share the request-body and retained-byte budgets. Each pool waits up to 250 ms, then returns `EWORKER_BUSY`, HTTP 503 and `Retry-After: 1`. If a dispatched script loses its worker, lease or response, its outcome is unknown: `EEXEC_OUTCOME_UNKNOWN`, HTTP 503 and `retryable: false`. Neither the server nor SDKs replay it automatically, including `readOnly` scripts with external effects. Read persisted state before deciding the next action; earlier completed batch items can remain committed. Drain accepted work before replacing or disabling a replica; forced termination can leave an unknown outcome.

Worker settings use positive safe integers. Per-tenant limits must leave capacity for other tenants when the corresponding global limit exceeds one. Queued byte quotas apply only while waiting for admission; an idle pool can accept a larger request within its execution and ingress budgets. The principal defaults are:

| Setting | Default |
|---|---:|
| `SQL_FS_WORKER_COUNT` / `SQL_FS_WORKER_HEAP_MB` | 2 workers / 512 MiB each |
| `SQL_FS_WORKER_ACTIVE_TENANT_MAX` | Half the worker count, rounded down; at least 1 |
| `SQL_FS_WORKER_PG_POOL_MAX` / `SQL_FS_WORKER_MAX_PG_CONNECTIONS` | 2 per worker / 4 total |
| `SQL_FS_WORKER_QUEUE_MAX` / `SQL_FS_WORKER_QUEUE_TENANT_MAX` / `SQL_FS_WORKER_QUEUE_BYTES` | 32 / 8 / 67108864 bytes |
| `SQL_FS_WORKER_QUEUE_TENANT_BYTES` | Half the global queued byte limit; at least 1 |
| `SQL_FS_WORKER_QUEUE_WAIT_MS` / `SQL_FS_WORKER_STARTUP_MS` / `SQL_FS_WORKER_CANCEL_GRACE_MS` | 250 / 10000 / 500 ms |
| `SQL_FS_MAX_INGRESS_REQUESTS` / `SQL_FS_MAX_INGRESS_BYTES` | 8 / 134217728 bytes |
| `SQL_FS_MAX_INGRESS_TENANT_REQUESTS` | Half the ingress request limit, rounded down; at least 1 |
| `SQL_FS_MAX_INGRESS_MCP_LISTENERS` / `SQL_FS_MAX_INGRESS_TENANT_MCP_LISTENERS` | 8 / 4 long-lived `GET /mcp` listeners |
| `SQL_FS_MAX_INGRESS_TENANT_BYTES` | Three quarters of the global ingress byte limit; at least 1 |
| `SQL_FS_WORKER_MAX_RSS_BYTES` / `SQL_FS_WORKER_MAX_EXTERNAL_BYTES` | 1610612736 / 536870912 bytes |
| `SQL_FS_WORKER_SOURCE_BYTES` / `SQL_FS_WORKER_INPUT_BYTES` | 1048576 / 134217728 bytes |
| `SQL_FS_WORKER_STRING_CHARS` | 67108864 UTF-16 characters |
| `SQL_FS_WORKER_OUTPUT_BYTES` / `SQL_FS_WORKER_MESSAGE_BYTES` / `SQL_FS_WORKER_LIVE_BYTES` | 67108864 / 68157440 / 134217728 bytes. The default message budget leaves 1 MiB for the reply envelope around maximum output; large result environments or metadata can still exhaust the independent message budget. |
| `SQL_FS_WORKER_EXECUTION_MS` | 120000 ms |
| `SQL_FS_WORKER_SCRIPT_BUFFER_OPS` / `SQL_FS_WORKER_SCRIPT_BUFFER_BYTES` | 50000 / 33554432 bytes |

The input budget counts repeated reads, including cached reads and Python/JavaScript bridges. Exceeding it returns `EEXEC_INPUT_LIMIT`, HTTP 413 and `retryable: false`, rolling back buffered filesystem writes. Other execution and direct-file budgets retain separate units and coverage. SDK ingestion applies configured client limits before server limits; the deprecated `allowOversized` / `allow_oversized` options are accepted as no-ops. Execs in both modes reserve each enabled runtime's global parent allowance, including variable and sourced commands. Native Python allows five active guests and 100 pending commands per Node isolate, with one active guest per filesystem; queued commands allocate no shared bridge. Inline Python bridge payloads default to 8 MiB, while worker payloads follow the configured transport budget. Budget parent metadata pools and transient recovery connections separately from worker connections.

Heap limits exclude native/external allocations. RSS checks at admission and external-memory reports at operation boundaries cannot continuously stop an in-flight allocation, so retain a hard container memory limit. The measured large-file profile uses 2 CPU / 3 GiB, two 512 MiB worker heaps, `SQL_FS_WORKER_LARGE_FILES=true`, `SQL_FS_WORKER_MAX_RSS_BYTES=2415919104`, `SQL_FS_WORKER_MAX_EXTERNAL_BYTES=1073741824`, and unset `MAX_EXEC_FILE_BYTES`. Startup reads the Linux cgroup v2 CPU quota only when process membership is the cgroup namespace root (`0::/`); nested or host-namespace membership cannot enable uncapped execution. It also checks the actual memory limit, requires at least those memory thresholds, and keeps the RSS threshold below the container memory limit. Unknown CPU or memory limits cannot enable uncapped execution. A default-threshold 2 GiB run refused a bystander during a 49 MiB transform; the default remains capped at 8 MiB. Validate your own deployment profile with `scripts/verify` before enabling a canary.

Workers do not autoscale within a replica. Scale replicas using CPU/RSS together with worker runnable queues, admitted queue delay and refusal/timeout rates from `GET /metrics`, authenticated with the same bearer JWT as the REST API. Same-sandbox, distributed-lock and recovery waits have separate gauges; adding replicas cannot resolve those bottlenecks. Busy slots include waiting reservations, and queue-delay histograms exclude refused requests, so include refusal counters. The metrics configure no platform autoscaler and contain no tenant or sandbox labels.

## MCP auth (for static-header clients, e.g. LibreChat)

The `/mcp` endpoint normally requires a `Authorization: Bearer <JWT>` signed with `AUTH_SECRET` (the SDKs mint this automatically from `auth_secret`). External MCP clients that can only send **fixed headers** — notably [LibreChat](https://github.com/danny-avila/LibreChat) — cannot mint a per-request JWT.

Setting **`MCP_API_KEY`** turns on a second, additive auth path on `/mcp`:

- A `Authorization: Bearer <MCP_API_KEY>` is accepted **without** JWT verification (constant-time compared).
- The sandbox **owner** (`sub`) is derived from a forwarded identity header (`MCP_IDENTITY_HEADER`, default `x-librechat-user-id`), so each end-user gets an **isolated** sandbox/owner.
- Any token that is *not* the API key still falls through to JWT verification, so JWT clients keep working on `/mcp` unchanged.

```yaml
# librechat.yaml — point LibreChat's MCP client at sql-fs
mcpServers:
  sql-fs:
    type: streamable-http
    url: https://your-sql-fs.example.com/mcp
    headers:
      Authorization: "Bearer ${MCP_API_KEY}"      # the shared service credential
      x-librechat-user-id: "{{LIBRECHAT_USER_ID}}" # forwarded per end-user → owner
```

```bash
# Server config
MCP_API_KEY=<long-random-shared-secret>   # ≥16 chars; guards code execution — keep it secret
MCP_IDENTITY_HEADER=x-librechat-user-id    # default; the header carrying the end-user id
# MCP_DEFAULT_SUB=shared                    # optional: shared owner when no identity header
# MCP_STATIC_TENANT=default                 # optional: tenant for static-header requests
```

> **Security model.** The forwarded identity header is trusted as the end-user identity, so it must be set by your proxy/LibreChat and **not** be settable by untrusted callers. Treat `MCP_API_KEY` like a password: anyone who has it *and* can reach `/mcp` directly can choose any `sub`. Put `/mcp` behind your ingress, keep the key secret, and ensure the identity header is stamped by a trusted hop. Cross-sandbox isolation is still enforced by RLS scoped to `(owner, tenant)`.

| Response | Cause |
|---|---|
| `401 AUTH_IDENTITY_REQUIRED` | API key matched but no identity header and no `MCP_DEFAULT_SUB`. |
| `401 AUTH_IDENTITY_INVALID` | Identity header present but empty, >256 chars, or contains control characters. |
| `401 AUTH_INVALID` | Token is neither the API key nor a valid JWT. |

## Deployment

```bash
docker build -t sql-fs-api .
docker run -p 8080:8080 \
  -e FS_BACKEND=postgres \
  -e DATABASE_URL=postgres://... \
  -e AUTH_SECRET=... \
  sql-fs-api
```

For multi-replica deployments, set `REDIS_URL` for a shared control instance and `REDIS_DATA_URL` for a separate blob-cache instance. All replicas share the same Postgres database and control Redis. Distributed locks coordinate writers while shared readers may run concurrently. Set the Redis policies described below.

### Redis eviction policy

Configure the Redis behind `REDIS_DATA_URL` (which defaults to `REDIS_URL`) with
`allkeys-lru` (or `allkeys-lfu`):

```bash
redis-cli -u "${REDIS_DATA_URL:-$REDIS_URL}" CONFIG SET maxmemory-policy allkeys-lru   # data instance; persist in redis.conf
```

Redis ships with `noeviction`, and under `noeviction` an instance that reaches
`maxmemory` starts refusing every write and **does not recover on its own**: blob
cache entries carry a 24h TTL (`REDIS_BLOB_CACHE_TTL_MS`), so waiting it out is not
a strategy, and someone has to flush keys or raise the limit by hand. The load
harness measured that as 97.6% 5xx with no recovery, against a `CLIENT PAUSE` that
recovered the moment the pause lifted. With `allkeys-lru` on a separate data instance,
the same memory pressure evicts cached blobs, and a cache miss costs a Postgres read.

For multi-replica distributed lock isolation, configure separate Redis instances for control (`REDIS_URL`) and data (`REDIS_DATA_URL`). Keep control on `noeviction` with enough memory headroom for lock operations. Keep the data instance on `allkeys-lru` or `allkeys-lfu`. Separate connections to one instance still share its eviction policy and memory limit.

On the default shared instance, LRU/LFU favor recent or frequent keys but cannot guarantee lock retention. Evicting the reader-membership ZSET makes active readers invisible to writer drain checks. Use separate instances when distributed lock isolation must hold under cache memory pressure. `allkeys-random` also permits lock eviction, and `volatile-*` can run out of TTL-bearing keys to evict.

The check runs only when this client actually carries the blob cache. With `REDIS_BLOB_CACHE_ENABLED=false`, no data connection opens. A control-only Redis must
**not** be switched to `allkeys-*` — that would make its leases evictable.

The server checks this at boot with `CONFIG GET maxmemory-policy` and logs
`event:"redis_eviction_policy_unsafe"` at `severity:"critical"` if the policy is
neither `allkeys-lru` nor `allkeys-lfu`. It is a warning, never a startup failure: managed Redis providers often
forbid `CONFIG GET`, and that case logs
`event:"redis_eviction_policy_unknown"` with `reason:"config_get_denied"` and boots
normally. If your provider hides the setting, confirm with them that the instance
evicts.

## Development

```bash
pnpm dev                    # hot-reload dev server
pnpm dev:portless           # dev server exposed via portless tunnel
pnpm typecheck              # type check (tsc --noEmit)
pnpm lint:fix               # format + lint (Biome)
pnpm test:unit              # unit tests — no DB required
pnpm test:integration       # integration tests — requires DATABASE_URL
pnpm test                   # all tests
pnpm db:generate            # scaffold a new migration SQL from schema changes (applied on server boot)
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

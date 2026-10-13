# Configuration

The server reads every setting from an environment variable. `FS_BACKEND` and `AUTH_SECRET` are always required, and `DATABASE_URL` is required for the `postgres` backend. Sizes are in bytes and durations are in milliseconds, unless the variable name says otherwise.

## Core

| Variable | Default | Description |
|---|---|---|
| `FS_BACKEND` | Required | `postgres` or `memory`. |
| `DATABASE_URL` | Required for `postgres` | Postgres connection string. The migration runner uses it at boot. On Neon, use the pooler endpoint. |
| `DATABASE_DIRECT_URL` | `DATABASE_URL` | Direct connection, without a pooler. Only drizzle-kit (`pnpm db:generate`) uses it. |
| `AUTH_SECRET` | Required | Signs and verifies bearer JWTs. |
| `ADMIN_SECRET` | Unset | Secret for `POST /v1/auth/admin`. If it is unset, that endpoint returns `500 ADMIN_NOT_CONFIGURED`. |
| `PORT` | `8080` | HTTP port. |
| `SESSION_IDLE_MS` | `600000` | Idle time before the server evicts a warm sandbox session. |
| `SKIP_STARTUP_MIGRATIONS` | `false` | If `true`, the server does not apply migrations at boot. |

## Postgres

| Variable | Default | Description |
|---|---|---|
| `PG_POOL_MAX` | `2` | Connections in each Postgres pool. Worker mode uses `SQL_FS_WORKER_PG_POOL_MAX` instead. |
| `PG_POOL_IDLE_TIMEOUT_S` | `30` | Seconds before the pool closes an idle connection. |
| `PG_POOL_CONNECT_TIMEOUT_S` | `30` | Connect timeout, in seconds. |
| `PG_POOL_MAX_LIFETIME_S` | `1800` | Seconds before the pool replaces a connection. |
| `PG_DRIVER_FAULT_GUARD` | `true` | Keeps the process alive after one known `postgres.js` crash (#169). When Postgres ends a backend mid-transaction, the driver can write to a closed socket and throw an uncaught exception. The guard matches only that stack frame. It logs `driver_socket_fault` and fails the stuck queries with `EDRIVERFAULT` (503). Every other uncaught exception still ends the process. Set it to `false` to crash and restart instead. |
| `PG_DRIVER_FAULT_GRACE_MS` | `5000` | Time a query can stay pending after a driver fault before it fails with `EDRIVERFAULT`. Raise it if a busy replica holds statements open for longer. |
| `BLOB_GC_MIN_AGE_MS` | `10800000` | Age (3 hours) an orphaned blob must reach before `pnpm db:gc` deletes it. |

## Size limits

| Variable | Default | Description |
|---|---|---|
| `MAX_REQUEST_BODY_BYTES` | 256 MiB | HTTP body limit. Inline mode checks it before authentication. Worker mode checks authentication first, then applies the smaller of this limit and the tenant ingress byte quota to the encoded JSON body. |
| `MAX_FILE_WRITE_BYTES` | 50 MiB | Largest file that one write accepts. It applies to `PUT`, `PATCH`, MCP `file_write` and each entry of a batch write. Above 50 MiB, the content cache cannot hold the file, and each such file costs about 4 times its size in memory for `SESSION_IDLE_MS`. |
| `MAX_BULK_WRITE_BYTES` | `MAX_FILE_WRITE_BYTES` | Total decoded bytes in one batch write: `POST /writeFiles`, or the `files` map on `POST /v1/sandboxes`. The request body can be twice this size, for JSON escaping. |
| `MAX_BULK_WRITE_FILES` | `1000` | Entries in one batch write. |
| `MAX_EXEC_FILE_BYTES` | 8 MiB | Largest file that a script can read or write whole. Above it, the exec fails with `EFBIG` (413, not retryable). To remove it in worker mode, see [Large files](#large-files). |
| `MAX_INGEST_BYTES` | 512 MiB | Total decoded bytes in one `ingest-files` manifest. |
| `MAX_INGEST_FILES` | `10000` | Entries in one `ingest-files` manifest. |
| `MAX_INGEST_PATHS_CONCURRENCY` | `16` | Concurrent host-file reads in the `paths` mode of MCP `fs_ingest`. |
| `MAX_EXPORT_FILES` | `10000` | Files in one MCP `fs_export`. |
| `MAX_EXPORT_BYTES` | 256 MiB | Total bytes in one MCP `fs_export`. |
| `MAX_EXPORT_CONCURRENCY` | `16` | Concurrent file reads in one `fs_export`. |
| `MAX_MCP_READ_FILE_BYTES` | 16 MiB | Largest file that MCP `file_read` opens. |
| `MAX_MCP_READ_RESPONSE_BYTES` | 1 MiB | Largest `file_read` response. A longer file comes back in pages, with `nextByteOffset` for the next page. |
| `MAX_TREE_ENTRIES` | `50000` | Entries in one tree listing. |

## Script execution

| Variable | Default | Description |
|---|---|---|
| `SCRIPT_TX_BUFFERED` | `true` | Holds a script's metadata changes in memory and commits them in one short transaction when the script ends (#166). If `false`, the script holds one transaction open for its whole run, as in older versions. While it is `true`, a database error surfaces when the request ends instead of at the failing command. Two replicas that write one sandbox at the same time get `ESTALE` (409) instead of waiting. |
| `SCRIPT_TX_BUFFER_MAX_OPS` | `50000` | Buffered changes in one script. Above it, the script fails with `ESCRIPTBUFFER` (413) and the server applies none of its changes. The largest measured script buffered 3,317 changes. |
| `SCRIPT_TX_BUFFER_MAX_BYTES` | 32 MiB | Estimated size of one script's buffer. The buffer holds metadata only. The server writes file bytes immediately, and `BLOB_GC_MIN_AGE_MS` protects them until the commit. |
| `MAX_CONCURRENT_PYTHON` | `5` | Python executions that run at the same time in one process. Each one uses about 80 MB. |
| `MAX_CONCURRENT_JS` | `5` | JavaScript executions that run at the same time in one process. Each one uses up to 64 MB. |
| `MAX_PYTHON_QUEUE` | `100` | Python executions that can wait for a slot. Above it, new ones fail with `ERUNTIME_BUSY` (503). |
| `MAX_JS_QUEUE` | `100` | JavaScript executions that can wait for a slot. Above it, new ones fail with `ERUNTIME_BUSY` (503). |
| `JUST_BASH_DEFENSE_IN_DEPTH` | `false` | If `true`, just-bash replaces `setTimeout`, `eval`, `Function` and dynamic `import` while a script runs. |
| `JUST_BASH_DEFENSE_AUDIT_MODE` | `true` | If defense in depth is on, log violations instead of throwing. |
| `GITHUB_TOKEN` | Unset | GitHub token that the server exports into every `network: true` sandbox, for `curl` and `git` over HTTPS. Any code in those sandboxes can read it, so set it only for trusted agents. A per-request `env` overrides it. |
| `GIT_AUTHOR_NAME` | Unset | Default author name for sandbox `git`. |
| `GIT_AUTHOR_EMAIL` | Unset | Default author email for sandbox `git`. |
| `GIT_COMMITTER_NAME` | Unset | Default committer name. `GIT_AUTHOR_NAME` takes precedence. |
| `GIT_COMMITTER_EMAIL` | Unset | Default committer email. `GIT_AUTHOR_EMAIL` takes precedence. |

The `GIT_*` identity needs both a name and an email. `git -c user.*`, the repository's git config and a per-request `env` all override it.

## Redis

On a single replica, Redis is optional. With more than one replica, it is required. `REDIS_URL` carries the locks. `REDIS_DATA_URL` carries the blob cache on a separate connection, so that a large cache write never delays a lock command.

| Variable | Default | Description |
|---|---|---|
| `REDIS_URL` | Unset | Control Redis, for distributed exec locks. If it is unset, only an in-process lock protects a sandbox. |
| `REDIS_DATA_URL` | `REDIS_URL` | Data Redis, for the blob cache. It needs `allkeys-lru` or `allkeys-lfu`. See [Redis eviction policy](#redis-eviction-policy). |
| `REDIS_EXEC_LOCK_LEASE_MS` | `60000` | Lock lease. If the holder crashes, its lock expires after this time. It must be greater than `REDIS_EXEC_LOCK_RENEW_MS`. |
| `REDIS_EXEC_LOCK_RENEW_MS` | `20000` | Interval between lease renewals. |
| `REDIS_EXEC_LOCK_ACQUIRE_TIMEOUT_MS` | `75000` | Time to wait for the lock before the request fails with 503. It must be greater than both `REDIS_EXEC_LOCK_LEASE_MS` and `REDIS_RWLOCK_READER_LEASE_MS`, so that a crashed holder's lease expires first. The server checks this at startup. |
| `REDIS_EXEC_LOCK_ACQUIRE_RETRY_MS` | `50` | Base interval between lock attempts. Each wait is randomized, so replicas do not retry at the same moment. |
| `REDIS_RWLOCK_ENABLED` | `true` | Lets read-only execs share a sandbox. Set it to `false` during a rolling deploy from a version without reader locks. Reads then wait for writes. |
| `REDIS_RWLOCK_READER_LEASE_MS` | `60000` | Reader lease. It limits how long a writer waits for a crashed reader. |
| `REDIS_BLOB_CACHE_ENABLED` | `true` | If `false`, the server reads blobs from Postgres only. |
| `REDIS_BLOB_CACHE_TTL_MS` | `86400000` | Blob cache entry lifetime (24 hours). |
| `REDIS_BLOB_MAX_BYTES` | 8 MiB | Blobs above this size bypass the cache. |
| `REDIS_BLOB_SET_MAX_IN_FLIGHT` | `32` | Cache writes in progress at one time, for each data connection and across all tenants. The server drops a write above the limit instead of queueing it. A dropped write costs one Postgres read later. |
| `REDIS_BLOB_SET_MAX_IN_FLIGHT_BYTES` | 32 MiB | Total bytes of the cache writes in progress, with the same rule. |

### Redis eviction policy

The data Redis must use `allkeys-lru` or `allkeys-lfu`:

```bash
redis-cli -u "${REDIS_DATA_URL:-$REDIS_URL}" CONFIG SET maxmemory-policy allkeys-lru
```

Also set the policy in `redis.conf`, so that it survives a restart.

Redis defaults to `noeviction`. Under `noeviction`, a full instance refuses every write and does not recover by itself, because blob entries live for 24 hours. In load tests, that state returned 97.6% 5xx with no recovery. Under `allkeys-lru`, the same memory pressure evicts old blobs, and each miss costs one Postgres read.

The control Redis in `REDIS_URL` must use `noeviction` and have spare memory. An evicting policy there can remove a live lock, or the reader set that a writer checks before it starts. If both roles share one instance, LRU and LFU usually keep the busy lock keys but cannot guarantee it. To keep locks safe under memory pressure, use two instances. Do not use `allkeys-random`, which can evict a live lock. Do not use a `volatile-*` policy, which stops evicting when no keys with a TTL are left.

At boot, the server reads the data connection's policy with `CONFIG GET maxmemory-policy`. For any policy other than `allkeys-lru` or `allkeys-lfu`, it logs `redis_eviction_policy_unsafe` with severity `critical`. The server only warns and always starts. If the provider forbids `CONFIG GET`, the server logs `redis_eviction_policy_unknown`. If the blob cache is off, the server skips the check.

## Auth and rate limits

| Variable | Default | Description |
|---|---|---|
| `ADMIN_RATE_LIMIT_WINDOW_MS` | `60000` | Window for the admin token endpoint's rate limit. |
| `ADMIN_RATE_LIMIT_MAX` | `5` | Requests in one window for the admin token endpoint. |
| `BOOTSTRAP_RATE_LIMIT_WINDOW_MS` | `60000` | Window for the bootstrap token endpoint's rate limit. |
| `BOOTSTRAP_RATE_LIMIT_MAX` | `5` | Requests in one window for the bootstrap token endpoint. |
| `TRUST_PROXY_HEADERS` | `false` | If `true`, read the client IP from `X-Forwarded-For`. Set it only behind a trusted proxy. |
| `MCP_SESSION_IDLE_MS` | `1800000` | Idle time (30 minutes) before the server drops an MCP session. |
| `MCP_SESSION_MAX` | `1000` | MCP sessions kept. Above it, the server evicts the oldest. |
| `MCP_SWEEP_INTERVAL_MS` | `60000` | Interval between sweeps for idle MCP sessions. |

### MCP auth for static-header clients

By default, `/mcp` requires `Authorization: Bearer <JWT>` signed with `AUTH_SECRET`. The SDKs create that token. Some clients, such as [LibreChat](https://github.com/danny-avila/LibreChat), can only send fixed headers. They can use a shared key instead.

| Variable | Default | Description |
|---|---|---|
| `MCP_API_KEY` | Unset | Shared key of at least 16 characters. On `/mcp`, the server accepts `Authorization: Bearer <MCP_API_KEY>` without JWT verification. Any other token still goes through JWT verification. |
| `MCP_IDENTITY_HEADER` | `x-librechat-user-id` | Header whose value becomes the sandbox owner. Each end user gets their own sandboxes. |
| `MCP_DEFAULT_SUB` | Unset | Owner for requests that have no identity header. If it is unset, those requests get `401 AUTH_IDENTITY_REQUIRED`. |
| `MCP_STATIC_TENANT` | `default` | Tenant for requests that use the key. |

```yaml
# librechat.yaml
mcpServers:
  sql-fs:
    type: streamable-http
    url: https://your-sql-fs.example.com/mcp
    headers:
      Authorization: "Bearer ${MCP_API_KEY}"
      x-librechat-user-id: "{{LIBRECHAT_USER_ID}}"
```

The server trusts the identity header. Your proxy or LibreChat must set it, and untrusted callers must not be able to. A caller who has `MCP_API_KEY` and can reach `/mcp` directly can act as any owner. Keep `/mcp` behind your ingress, and protect the key like a password.

| Response | Cause |
|---|---|
| `401 AUTH_IDENTITY_REQUIRED` | The key matched, but the request has no identity header and `MCP_DEFAULT_SUB` is unset. |
| `401 AUTH_IDENTITY_INVALID` | The identity header is empty, is longer than 256 characters, or contains control characters. |
| `401 AUTH_INVALID` | The token is not the key and is not a valid JWT. |

## Observability

| Variable | Default | Description |
|---|---|---|
| `EVENT_LOOP_MONITOR_INTERVAL_MS` | `10000` | Window for the `event_loop_lag` log line, which reports p50, p99, p999, max and mean lag. `GET /readyz` also returns the histogram as `eventLoop`. |
| `EVENT_LOOP_STALL_THRESHOLD_MS` | `2000` | If a window's maximum lag exceeds this, the server also logs `event_loop_stall` with severity `critical`. The default equals the Redis command timeout. Above it, a stall starts to fail other tenants' Redis commands. One stall does not move p50 or p99, so alert on `event_loop_stall` or `maxMs`. |

`GET /metrics` serves Prometheus metrics for the worker queues, admission delay and refusals. It accepts the same bearer JWT as the REST API. The metrics have no tenant or sandbox labels.

## Worker owners

If `SQL_FS_WORKERS_ENABLED` is `true` (default `false`), a fixed pool of worker threads owns each sandbox's filesystem and shell. Scripts then run off the HTTP event loop.

Before you turn workers on:

- Run a version with PostgreSQL generation fencing on every replica. A replica without it cannot share sandboxes with worker replicas.
- Set a hard container memory limit. Heap limits do not cover native memory, and the RSS checks run only between operations.
- Plan to drain a replica before you replace or stop it. A script that is cut off mid-run has an unknown outcome.

**Admission.** Each tenant has a queue, and the server takes requests from the queues in turn. On one sandbox, a waiting writer goes before new readers. With the defaults, one tenant can hold one of the two workers and four of the eight ingress permits. Long-lived `GET /mcp` streams count against a separate listener quota. If a request waits more than 250 ms, it fails with `EWORKER_BUSY` (503) and `Retry-After: 1`.

**Unknown outcomes.** If a script loses its worker, lease or response after it starts, the request fails with `EEXEC_OUTCOME_UNKNOWN` (503, `retryable: false`). The server and the SDKs do not replay it. That includes read-only scripts, because they can still have network side effects. Read the sandbox state before the next action. Earlier items in a batch can already be committed.

**Input budget.** Every byte that a script reads counts against `SQL_FS_WORKER_INPUT_BYTES`. That includes repeated reads, cached reads and the Python and JavaScript bridges. If a script exceeds it, the exec fails with `EEXEC_INPUT_LIMIT` (413, not retryable) and its writes roll back.

Every worker setting must be a positive integer. If a global limit is above 1, its per-tenant limit must be lower, so that other tenants keep some capacity.

| Variable | Default |
|---|---|
| `SQL_FS_WORKER_COUNT` | 2 workers |
| `SQL_FS_WORKER_HEAP_MB` | 512 MiB per worker |
| `SQL_FS_WORKER_ACTIVE_TENANT_MAX` | Half the worker count, at least 1 |
| `SQL_FS_WORKER_PG_POOL_MAX` | 2 connections per worker |
| `SQL_FS_WORKER_MAX_PG_CONNECTIONS` | 4 connections in total |
| `SQL_FS_WORKER_QUEUE_MAX` | 32 requests |
| `SQL_FS_WORKER_QUEUE_TENANT_MAX` | 8 requests |
| `SQL_FS_WORKER_QUEUE_BYTES` | 64 MiB |
| `SQL_FS_WORKER_QUEUE_TENANT_BYTES` | Half of `SQL_FS_WORKER_QUEUE_BYTES`, at least 1 |
| `SQL_FS_WORKER_QUEUE_WAIT_MS` | 250 ms |
| `SQL_FS_WORKER_STARTUP_MS` | 10000 ms |
| `SQL_FS_WORKER_CANCEL_GRACE_MS` | 500 ms |
| `SQL_FS_MAX_INGRESS_REQUESTS` | 8 requests |
| `SQL_FS_MAX_INGRESS_TENANT_REQUESTS` | Half of `SQL_FS_MAX_INGRESS_REQUESTS`, at least 1 |
| `SQL_FS_MAX_INGRESS_BYTES` | 128 MiB |
| `SQL_FS_MAX_INGRESS_TENANT_BYTES` | Three quarters of `SQL_FS_MAX_INGRESS_BYTES`, at least 1 |
| `SQL_FS_MAX_INGRESS_MCP_LISTENERS` | 8 listeners |
| `SQL_FS_MAX_INGRESS_TENANT_MCP_LISTENERS` | 4 listeners |
| `SQL_FS_WORKER_MAX_RSS_BYTES` | 1.5 GiB |
| `SQL_FS_WORKER_MAX_EXTERNAL_BYTES` | 512 MiB |
| `SQL_FS_WORKER_SOURCE_BYTES` | 1 MiB |
| `SQL_FS_WORKER_INPUT_BYTES` | 128 MiB |
| `SQL_FS_WORKER_STRING_CHARS` | 64 Mi UTF-16 characters |
| `SQL_FS_WORKER_OUTPUT_BYTES` | 64 MiB |
| `SQL_FS_WORKER_MESSAGE_BYTES` | 65 MiB |
| `SQL_FS_WORKER_LIVE_BYTES` | 128 MiB |
| `SQL_FS_WORKER_PYTHON_BRIDGE_BYTES` | 64 MiB |
| `SQL_FS_WORKER_EXECUTION_MS` | 120000 ms |
| `SQL_FS_WORKER_SCRIPT_BUFFER_OPS` | 50000 changes |
| `SQL_FS_WORKER_SCRIPT_BUFFER_BYTES` | 32 MiB |

A replica does not add workers by itself. Scale the number of replicas on CPU and RSS, together with the worker queue, admission delay and refusal metrics from `GET /metrics`. Waits on one sandbox, on distributed locks and on recovery have their own gauges. More replicas do not shorten those waits.

### Large files

If `SQL_FS_WORKER_LARGE_FILES` is `true` (default `false`), worker mode can run without the per-file `MAX_EXEC_FILE_BYTES` limit. The input, message, string and output budgets above still apply. To remove the per-file limit, leave `MAX_EXEC_FILE_BYTES` unset. To keep one, set it.

At startup, the server refuses to remove the limit unless it can confirm all of these:

- The container has at least 2 CPUs and a memory limit of at least 3 GiB. The server reads both from cgroup v2, and only when the process sits at the root of its cgroup namespace.
- `SQL_FS_WORKER_MAX_RSS_BYTES` is at least 2415919104 and below the container memory limit.
- `SQL_FS_WORKER_MAX_EXTERNAL_BYTES` is at least 1073741824.

These values match the measured profile: two 512 MiB worker heaps on 2 CPUs and 3 GiB. In a 2 GiB run with the default thresholds, the server refused another tenant's request during a 49 MiB transform. For that reason, the default keeps the 8 MiB limit. Run `scripts/verify` against your own deployment profile before you enable it on a canary.

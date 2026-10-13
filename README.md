<p align="center">
  <img src="assets/banner.svg" alt="sql-fs" width="720" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-1.1.0-blue" alt="Version" />
  <img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen?logo=node.js&logoColor=white" alt="Node.js" />
  <img src="https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/just--bash-3.6.0-f59e0b" alt="just-bash" />
  <img src="https://img.shields.io/badge/license-MIT-22c55e" alt="License" />
</p>

<p align="center">Persistent bash sandboxes over HTTP and MCP, backed by Postgres</p>

---

sql-fs gives AI agents isolated bash sandboxes without a VM for each one. [just-bash](https://github.com/nicholasgasior/just-bash) runs the shell inside the server process. sql-fs stores each sandbox's filesystem in Postgres and serves it over HTTP and MCP. A sandbox costs a few database rows and survives restarts.

- **No per-sandbox billing.** State lives in the Postgres you already run.
- **Isolated.** Row-level security on `sandbox_id` keeps sandboxes apart in the database.
- **All or nothing.** A script's file changes commit together when it ends, or not at all.
- **Fast reads.** An in-process path map and content cache answer `stat`, `ls` and repeated reads without a database call for each operation.
- **Deduplicated.** Postgres stores each file's content once, keyed by SHA-256, across all sandboxes.
- **Scales out.** Replicas keep no state. A Redis lock lets one replica write a sandbox at a time, and readers run in parallel.

## Development and agent setup

Read [AGENTS.md](AGENTS.md) for implementation instructions and [CONTRIBUTING.md](CONTRIBUTING.md) for setup. Run `pnpm setup:dev`, then `pnpm check` for all credential-free checks and `pnpm verify:local` for disposable database and API verification.

## Run it locally

1. Start Postgres and Redis:

	```bash
	docker compose -f docker-compose.local.yml up -d
	```

2. Copy the example settings. They already point at the compose Postgres. To use Redis, uncomment `REDIS_URL` in `.env`.

	```bash
	cp .env.example .env
	```

3. Install and start the server. It applies migrations at boot and listens on `http://localhost:8080`.

	```bash
	pnpm install
	pnpm dev
	```

The server connects as `sqlfs_app`, the non-superuser role that the compose file creates. A superuser bypasses row-level security, so the isolation tests fail under one. [CONTRIBUTING.md](CONTRIBUTING.md#local-database) has the details.

The running server serves its API reference at `/docs` (Swagger UI) and `/openapi.json`. MCP clients connect to `/mcp`.

## Call it from an SDK

Both SDKs take the server's `AUTH_SECRET` and exchange it for a JWT.

Python, from `pip install sql-fs-sdk`:

```python
import os
from sqlfs import Client

client = Client(base_url="http://localhost:8080", auth_secret=os.environ["AUTH_SECRET"], sub="agent-001")

sb = client.sandboxes.create(name="my-project", network=True)
sb.ingest_files({"app.py": b"print('hi')"}, base_path="/home/user/src")
print(sb.exec("ls /home/user/src").stdout)
sb.delete()
```

TypeScript, from `npm install sql-fs-sdk`:

```ts
import { Client } from "sql-fs-sdk";

const client = new Client({ baseUrl: "http://localhost:8080", authSecret: process.env.AUTH_SECRET, sub: "agent-001" });

const sandbox = await client.sandboxes.create({ name: "my-project" });
console.log((await sandbox.exec("echo hello")).stdout);
await sandbox.delete();
```

The [Python SDK README](clients/python/README.md) and the [TypeScript SDK README](clients/typescript/README.md) cover the full API.

A new sandbox has no network, no Python and no JavaScript. To turn one on, pass `network`, `python` or `javascript` when you create the sandbox. To turn a flag on or off later, set it to `true` or `false` in `PATCH /v1/sandboxes/:id` or the MCP tool `sandbox_update`. A flag that you leave out keeps its current value.

## How it works

Postgres is the source of truth. Everything else is a cache or a lock.

```
HTTP or MCP client → Hono API → session manager → just-bash → SqlFs → Postgres
                                       │                        │
                                  Redis locks           Redis blob cache
```

Each sandbox's tree is an adjacency list, so `mv` of a whole directory updates one row:

```
sandboxes  id, root_inode, owner, created_at
inodes     id, sandbox_id, kind, mode, size, mtime, content_sha256 → blobs
dirents    (parent_inode_id, name) → inode_id
blobs      sha256, data, size        -- keyed by content, shared across sandboxes
```

Before a request touches the cache, the server checks the sandbox's epoch in Postgres. If the epoch moved, the server reloads the path tree in the same transaction. A replica never answers from a stale cache. If it cannot check the epoch, the request fails.

While a script runs, its changes stay in memory. They commit in one short transaction when the script ends.

Each request takes a local lock, and also a Redis lock when Redis is configured. With `SQL_FS_WORKERS_ENABLED=true`, scripts run in a pool of worker threads instead of on the HTTP event loop.

## Configure the server

Most deployments need only these settings. [CONFIGURATION.md](CONFIGURATION.md) lists every variable, worker tuning, the Redis eviction policy and MCP static-key auth.

| Variable | Description |
|---|---|
| `DATABASE_URL` | Postgres connection string. Required unless `TENANT_DATABASES` maps one database per tenant. |
| `AUTH_SECRET` | Signs and verifies bearer JWTs. Required. |
| `REDIS_URL` | Redis for distributed locks. Required for more than one replica. |
| `REDIS_DATA_URL` | Redis for the blob cache, on its own connection. Defaults to `REDIS_URL`. Needs `maxmemory-policy allkeys-lru` or `allkeys-lfu`. |
| `SQL_FS_WORKERS_ENABLED` | Run scripts in worker threads. Default `false`. |

## Deploy with Docker

```bash
docker build -t sql-fs-api .
docker run -p 8080:8080 \
	-e DATABASE_URL=postgres://... -e AUTH_SECRET=... \
	sql-fs-api
```

To run several replicas, point them all at one Postgres database and one control Redis in `REDIS_URL`. Put the blob cache on a separate Redis in `REDIS_DATA_URL` with `allkeys-lru`, and keep the control Redis on `noeviction`. [Redis eviction policy](CONFIGURATION.md#redis-eviction-policy) explains why.

## Develop

```bash
pnpm dev                # dev server with hot reload
pnpm typecheck          # tsc --noEmit
pnpm lint:fix           # Biome format and lint
pnpm test:unit          # no database needed
pnpm test:integration   # needs DATABASE_URL and REDIS_URL
pnpm verify:local       # disposable services, integration tests, HTTP/MCP and SDK checks
pnpm db:gc              # delete orphaned blobs
pnpm changeset          # record a change for the next release
```

`pnpm bench:remote-bash` measures end-to-end latency against a running server. To compare against Daytona, run `scripts/benchmark_remote_bash.py --provider daytona`. The script lists its other flags.

[CONTRIBUTING.md](CONTRIBUTING.md) covers setup, coding standards and releases. [DEVELOPER.md](DEVELOPER.md) covers internals.

## License

MIT

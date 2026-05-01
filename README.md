# virtualFS

A virtual file system implementation.

## Getting a JWT for API calls

All `/v1/*` endpoints require `Authorization: Bearer <JWT>`. Three ways to mint a token:

1. **Bootstrap from `AUTH_SECRET` over HTTP** (recommended for external clients/agents):

   ```bash
   curl -X POST https://<host>/v1/auth/bootstrap \
     -H "X-Auth-Secret: $AUTH_SECRET" \
     -H "Content-Type: application/json" \
     -d '{"sub":"agent-001","expiresIn":"30d"}'
   ```

   Returns `{ token, sub, tenant, expiresAt }`. The endpoint is unauthenticated by design — the `X-Auth-Secret` header is the credential, compared in constant time against the server's `AUTH_SECRET`. Add `"tenant": "<id>"` for multi-tenant deployments.

2. **CLI** (when you have the repo cloned): `AUTH_SECRET=... pnpm token:create -- --sub agent-1 --expires 30d`.

3. **Admin endpoint** (`POST /v1/auth/admin`) — requires both an existing Bearer JWT *and* `X-Admin-Secret`. Use this once you already have a token and want to mint others without exposing `AUTH_SECRET`.

## Benchmarking

`scripts/benchmark_remote_bash.py` measures end-to-end latency of bash commands
through the API, including the network round-trip. It runs against either the
**VirtualFS** API or **Daytona** so you can compare them directly.

What it measures:

- **Phase 1 — Sandbox lifecycle**: `create` / `ingest` / `delete` over N fresh
  sandboxes (every iteration is a real round-trip to the backend).
- **Phase 2 — Exec latency**: `find`, `grep`, `rg`, `write`, `delete`, `mkdir`,
  `mv` cases on a warm sandbox. Wall-clock ms is always reported; `duration_ms`
  from the server is reported for VirtualFS (Daytona doesn't expose it).

It uses your local `./src` directory as the test corpus and ingests it into the
sandbox so commands have realistic files to operate on. Output is rendered as
markdown tables (copy-paste into anywhere).

### Prerequisites

```bash
# VirtualFS Python SDK is loaded directly from clients/python — no install needed.
# Daytona SDK is only required if you want to benchmark Daytona:
pip install daytona-sdk
```

### Run against VirtualFS

```bash
# Local API (pnpm dev) + local Postgres
API_URL=http://localhost:8081 \
AUTH_SECRET=localdev \
  pnpm bench:remote-bash

# Remote API
API_URL=https://your-api.example.com \
AUTH_SECRET=$AUTH_SECRET \
  pnpm bench:remote-bash
```

### Run against Daytona

```bash
DAYTONA_API_KEY=dtn_... \
DAYTONA_API_URL=https://app.daytona.io/api \
  python3 scripts/benchmark_remote_bash.py --provider daytona
```

### Useful flags

```
--provider {virtualfs,daytona}  # default: virtualfs
--src-dir PATH                  # local dir to ingest (default: ./src)
--lifecycle-runs N              # full create/ingest/delete cycles (default: 3)
--warmup N                      # discarded warmup runs per exec case (default: 1)
--runs N                        # measured runs per exec case (default: 5)
--timeout-ms MS                 # per-exec timeout (default: 60000)
```

For higher confidence at the cost of runtime, bump `--lifecycle-runs 5
--warmup 5 --runs 25`. On a high-RTT deployment that's roughly 10–15 minutes;
on localhost it's under a minute.

The script auto-cleans any leftover `bench-*` sandboxes at the end so failed
runs don't accumulate state.

## License

MIT

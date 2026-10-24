---
name: verify
description: Prove a change to sql-fs works the way an API, MCP, or SDK client sees it. Picks the gates a change needs (pnpm check, verify:local, verify:architecture, single suites) and drives a persistent disposable Postgres/Redis/API stack with curl-level HTTP, MCP tool calls, and SQL inspection, keeping evidence. Use before handing back any change, when asked to verify/prove/test behavior end to end, or when a full verify:local run is too coarse to debug a failure.
---

# Verify sql-fs

sql-fs is an HTTP + MCP service. Its users are API clients, MCP clients, and the TypeScript/Python SDKs, so proof means real requests against a real server backed by real Postgres and Redis. This skill adds two things on top of the repo's gates:

1. A **change → gate map** so you run the right checks without asking.
2. A **persistent disposable stack** (`scripts/stack.sh`) so you can drive one endpoint, rerun one suite, or inspect the database while you iterate, instead of paying for a full `pnpm verify:local` on every attempt.

All paths below are relative to the repo root. `S=.claude/skills/verify/scripts/stack.sh`.

## Choose the gates

Run every row your diff touches. `pnpm check` is always required; the full verify command named on a row is the completion evidence, and the stack is how you iterate toward it. For any runtime change, the default loop is: `$S up` → edit → `$S restart` → `$S doctor` → the row's drive/suite → `journeys.sh` → the completion gate → `$S down`.

| Diff touches | Iterate with | Completion evidence |
| --- | --- | --- |
| Docs, comments, `.changeset/` only | — | `pnpm check` |
| `src/sql-fs/` (fs, transactions, cache, RLS, symlinks) | targeted `pnpm exec vitest run <file>`, `$S suite integration <file>`, [files](features/files.md) / [exec](features/exec.md) drive | `pnpm check` + `pnpm verify:local` |
| `src/api/routes/`, `auth.ts`, `validation.ts`, `openapi-spec.ts` | the matching feature drive + `$S suite contracts` | `pnpm check` + `pnpm verify:local` |
| `src/api/mcp/` | [mcp](features/mcp.md) drive + `$S suite contracts` | `pnpm check` + `pnpm verify:local` |
| `src/api/worker-owner/`, `ingress-admission.ts`, `session-manager.ts`, `src/execution/`, `script-scope.ts`, budgets, cancellation, deadlines, body limits | `$S suite worker-failures`, `sse-finalization`, `input-budgets`, `ingress-queue`, `output-cap` | `pnpm check` + `pnpm verify:architecture` |
| `src/api/server.ts` startup/shutdown, `src/api/mcp/server.ts` listener lifecycle, ingress waits | `$S suite shutdown`, `$S suite contracts` | `pnpm check` + `pnpm verify:local` |
| Tenancy, `TENANT_DATABASES`, owner isolation | `$S suite tenants`, [sandboxes](features/sandboxes.md) isolation steps | `pnpm check` + `pnpm verify:architecture` |
| `src/redis/`, `redis-blob-cache.ts` | `$S suite integration src/redis` | `pnpm check` + `pnpm verify:local` |
| `src/sql-fs/migrations/postgres/` | `$S down && $S up` (fresh DB runs every migration), `$S psql '\d <table>'` | `pnpm check` + `pnpm verify:local` |
| `clients/typescript/` or `clients/python/` only | `pnpm check:typescript` / `pnpm check:python`, `$S suite sdk-clients` | `pnpm check` + `pnpm verify:local` |
| `package.json`, lockfiles, `patches/` | — | `pnpm check` + `pnpm verify:local` + `pnpm security:audit` |

Also, from CLAUDE.md: add `.changeset/*.md` for behavior changes, update `src/api/openapi-spec.ts` when an API contract changes, and report every command with its result. A skipped test is not proof.

## Launch

Preconditions: Docker daemon running, `pnpm setup:dev` done (needs `node_modules` and `clients/python/.venv`), and `jq` on `PATH`. `journeys.sh` and the feature recipes need `jq`.

```bash
$S up            # compose stack + pnpm build + API server; ~10s
$S up --no-build # reuse the current dist/
```

`up` starts `infra/docker-compose.verify.yml` under a unique Compose project with tmpfs Postgres and random loopback ports. It builds, then starts `node dist/api/server.js` with a clean environment (`env -i`, so `.env` and your shell's deployment variables are ignored) on a random port. The server applies every migration at startup. Ready means `GET /readyz` returns `{"status":"ok"}`, and the server only gets there after migrations and Redis connect. If the server exits first, `up` prints the tail of `server.log` and fails.

`up` refuses while a stack is recorded for this checkout. Reuse it (`$S doctor`) or `$S down` first. After a failed `up`, run `$S down` too, because the containers may be running.

Server environment overrides: `SERVER_ENV="SQL_FS_WORKERS_ENABLED=false SQL_FS_WORKER_OUTPUT_BYTES=1048576" $S restart`. Overrides persist across later restarts until you pass `SERVER_ENV="" $S restart`. Values are split on spaces, so use compact JSON with no spaces. `server.log` and `doctor` show only the override names; the values stay in the owner-only `state.env`.

## Doctor

Run `$S doctor` first, and again whenever anything looks off. It is read-only and exits non-zero on any `FAIL`:

- all three services `healthy`
- the recorded PID is alive and is `node dist/api/server.js`
- that PID owns the recorded port (via `lsof`)
- `/readyz` ok and a freshly minted token gets `200` on `GET /v1/sandboxes`
- `node_modules` matches `pnpm-lock.yaml`, compared byte-for-byte with `node_modules/.pnpm/lock.yaml`. After a pull that changed the lockfile, the old install keeps running and unit tests fail for reasons unrelated to your diff. Fix it with `pnpm install --frozen-lockfile && $S restart`. `up` refuses to start on drift.
- `dist/` is not older than any non-test `src/**/*.ts` or `src/**/*.sql`, so a migration edit also fails until you restart. **A stale build is the most common false result**: you edited source, but the server and every suite still run the old `dist/`. Fix it with `$S restart`.

## Drive

After every source edit: `$S restart` (rebuild + restart, same port, data kept), then `$S doctor`.

**Regression sweep:** `.claude/skills/verify/scripts/journeys.sh [auth|sandboxes|exec|files|ingest|mcp ...]` runs every journey in the feature map against the stack and asserts the documented result. With no arguments it runs all six, about 40 assertions in roughly 10 seconds. It exits non-zero at the first mismatch and prints the expected and actual values. Run it after any change to `src/api/` or `src/sql-fs/` before the full gate. It is the executable form of `features/*.md`: when you add or change a journey there, change the matching `journey_<name>` function in the same commit. It is iteration evidence, not a gate. CI and `verify:local` do not run it.

| Command | What it does |
| --- | --- |
| `$S api METHOD PATH [curl args]` | Authenticated request. Body goes to stdout and `HTTP <status>` to stderr, and a record is appended to `transcript.jsonl`. Exits non-zero unless the status is 2xx, or equals `EXPECT=<code>`. `AS=<sub>` picks the caller (default `verify-agent`), `AS=none` sends no token, `TENANT=<id>` adds a tenant claim. |
| `$S mcp list` / `$S mcp TOOL '<json>'` | MCP over Streamable HTTP with the same `AS`/`TENANT`. Exits non-zero on `isError` or a `{"ok":false}` payload. Use `EXPECT=error` to assert one of those. `bash_exec` denials are neither; assert their `exitCode`/`stderr`. |
| `$S token [sub] [tenant]` | Print a 24h JWT signed with the stack's `AUTH_SECRET`. |
| `$S psql 'SQL'` | Run SQL as the `postgres` superuser on the stack DB. This **bypasses RLS** and is only for inspecting side effects; never use it to prove isolation. Tables: `sandboxes`, `inodes`, `dirents`, `blobs`, `sandbox_epochs`. |
| `$S suite NAME [args]` | Run the suite entry point `scripts/verify/NAME.mjs` against the stack's Postgres and Redis. Suites start their own API servers from `dist/`, so a passing suite does not prove the `$S up` server; restart (build) first. An entry point is a non-test file that creates a `LocalApiRun`; helper modules such as `local-api.mjs` or `measurements.mjs` are rejected with the list of entry points. `NAME=integration [file filters]` runs vitest integration and writes a JSON report. |
| `$S env` | Print the recorded state (URLs, port, PID, run dir). |

Use `curl --json '<body>'` for JSON (sets both headers). Use `--data-binary @file -H 'Content-Type: application/octet-stream'` for raw file bytes.

The feature map in [features/](features/README.md) has the exact journeys. Always assert the observable result (status, body, a second read through another path). Don't settle for "it returned 200".

## Evidence

Everything lands in `scripts/verify/.run/stack-<id>/` (gitignored) and survives `down`:

- `transcript.jsonl`: every `api` call with caller, method, path, curl args, and HTTP status, and every `mcp` call (including `list`) with caller, tool, args, and whether it failed. Each record keeps the response body up to 4 KiB; a longer body is cut, marked `truncated: true`, and `bytes` keeps the full size. The stack secret, JWTs, values of token/secret/password/authorization keys (also inside JSON strings such as `--json` args and MCP text parts), and sensitive header values are redacted.
- `server.log`: server stdout/stderr across restarts, with a `--- restart` line at each one.
- `services.log`: Postgres/Redis logs, written at `down`.
- `suites/<suite>-<id>/proof.json` and `requests.jsonl`, plus `suites/integration-*.json`.
- `state.env`: the stack's coordinates. It contains the local-only verification secret and any `SERVER_ENV` values, so the run directory is owner-only.

`pnpm verify:local` writes its own `scripts/verify/.run/verify-*/` directory with `proof.json` per suite and `integration.json`.

Proof standards:

- Drive the public path a client uses (`/v1/*`, `/mcp`, the SDKs). Never call internals or test-only hooks to make a journey pass.
- For mutations, capture the action and an independent read: write via REST, read via bash or MCP, or the reverse. Then confirm the side effect with `$S psql` where it matters.
- For isolation, prove the denial (`AS=intruder EXPECT=403`) through the API, not through SQL.
- If a precondition is missing, report the journey as failed with the reason. Never weaken the journey to make it pass.
- Report what you ran and what you saw: commands, statuses, evidence paths. Name anything you did not verify.

## Cleanup

```bash
$S down
```

`down` stops only the recorded PID, and only if it still runs `dist/api/server.js`. It saves service logs, removes this run's containers and volumes (`down --volumes`), and clears the pointer. Evidence stays on disk. Never `pkill node` or `docker rm` by pattern, because other worktrees and the user's own stacks may be running. Delete old `scripts/verify/.run/stack-*` directories only when the user asks.

## Isolation

- One recorded stack per checkout (pointer: `scripts/verify/.run/current-stack`). Separate worktrees get separate stacks and never collide, since project names and ports are unique.
- `STACK_DIR=scripts/verify/.run/stack-<id> $S doctor` targets a specific recorded stack.
- `pnpm verify:local` and `verify:architecture` start their own fresh stack and can run while yours is up.
- Never point the helper or suites at a shared or non-disposable database. `tenants`, `worker-failures`, and the integration suite create databases and inject faults.

## Gotchas

- zsh has no `PIPESTATUS`; use `${pipestatus[1]}`, or don't pipe when you need the exit code.
- `exec-sync` timeouts return `408 EXEC_TIMEOUT` but commit the completed prefix. Assert both.
- MCP tool errors use three shapes (`src/api/mcp/tool-errors.ts`): worker errors set `isError:true`; file and sandbox tools return `{"ok":false,"error":...}` with `isError:false`; `bash_exec` returns `{"exitCode":1,"stderr":"forbidden"}`. The helper catches the first two. For bash tools, assert the fields.
- `PATCH /v1/sandboxes/:id` accepts only `python`, `javascript`, and `network`. A `name` is rejected with 400.
- The integration suite takes about 2.5 minutes. Narrow it with a path filter while iterating, then run it whole.

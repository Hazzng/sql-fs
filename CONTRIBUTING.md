# Contributing to sql-fs

## Set up the repository

Install Node 22, pnpm 10.30.3, Python 3.12, uv 0.9.18, and Docker with Compose v2. The Node version is recorded in `.node-version`; the pnpm version is recorded in `package.json`.

```bash
git clone https://github.com/Hazzng/sql-fs.git
cd sql-fs
pnpm setup:dev
pnpm check
```

`pnpm setup:dev` installs the server, TypeScript SDK, and Python SDK from their lockfiles and installs Lefthook hooks. It does not write `.env`. `pnpm check` runs types, lint, unit tests, builds, and both SDK suites without database credentials. Use `pnpm check:typescript` or `pnpm check:python` for focused SDK work.

Python type checking targets the oldest supported interpreter. `pnpm check:python:types` uses uv to provision Python 3.9 in `clients/python/.venv-py39`, separate from the Python 3.12 development environment. This keeps the dependency syntax aligned with the declared target. Mypy stays below version 2 while Python 3.9 is supported.

## Verify against disposable services

```bash
pnpm verify:local
```

This command creates a unique Compose project with Postgres 16 and separate Redis 7 control and data instances on random loopback ports. It builds the server, exercises the HTTP and MCP contracts, runs the database integration tests serially, and tests both SDKs against a real API in worker mode. Server startup applies migrations. The data Redis uses `allkeys-lru`; the control Redis keeps `noeviction`.

The command ignores `.env` and inherited deployment settings. It fails if Docker is unavailable or integration tests skip. It removes only its own containers and volumes on exit. Evidence remains under the printed `scripts/verify/.run/<run-id>/` directory. Inspect `proof.json`, request logs, service logs, and `integration.json` there after a failure. Correct the cause before rerunning.

For an interrupted host or a killed shell, list leftover projects with `docker compose ls`. Remove only the `sqlfs-verify-*` project named by your run. Do not reset a shared development database to repair a verification run.

## Start a development server

```bash
docker compose -f docker-compose.local.yml up -d --wait
cp .env.example .env
pnpm dev
```

The server listens on port 8080. The example environment points at the development Postgres instance and has a local-only authentication secret. Copy the example only when `.env` does not already exist. Set `REDIS_URL=redis://localhost:6379` in `.env` to use the optional development Redis. `pnpm dev:portless` provides a stable `https://sql-fs.localhost` address when Portless is configured.

The persistent development stack and disposable verification stack are separate. The development stack has fixed ports 5432 and 6379. Its `sqlfs_app` role owns the database and schema and has `CREATEDB` for tests, but has neither superuser nor `BYPASSRLS` privileges. `FORCE ROW LEVEL SECURITY` does not constrain a superuser, so testing as `postgres` invalidates isolation checks.

## Local database

For a separate Postgres 16 instance, create the app role, database, and schema ownership using `scripts/initdb/00-create-app-role.sql`. The app role must own its tables without superuser or `BYPASSRLS` privileges; integration tests also need `CREATEDB`.

## Change SQL safely

Add a numbered SQL file in `src/sql-fs/migrations/postgres/`. The boot-time runner in `src/api/migrations.ts` applies migrations for every configured tenant. Do not edit already applied migrations. There is no Drizzle schema or `db:generate` command.

To use the lower-level integration command, first start the server once to apply migrations, then stop it and run:

```bash
DATABASE_URL=postgres://sqlfs_app:sqlfs_app@localhost:5432/sqlfs \
REDIS_URL=redis://localhost:6379 \
pnpm test:integration
```

Use disposable services for fault injection and multi-tenant tests. The suite runs files serially to respect the Postgres connection budget. A deadlock is a failure to investigate. Missing service variables can skip tests in this lower-level command, so use `pnpm verify:local` as the completion check.

## Submit a change

Read [AGENTS.md](AGENTS.md) for coding rules and [DEVELOPER.md](DEVELOPER.md) before changing sessions, transactions, locks, or caches.

1. Branch from `main` and implement the change with focused tests.
2. Run `pnpm check`.
3. Run `pnpm verify:local` for runtime, database, dependency, or SDK behavior changes.
4. Run `pnpm security:audit` for dependency changes.
5. Add a changeset for behavior changes with `pnpm changeset`.
6. Commit the changeset with the code and open a PR that describes the behavior and verification.

Use a patch changeset for fixes, a minor changeset for compatible features, and a major changeset for breaking API or schema changes. Documentation and tooling-only changes do not need a release entry. Do not manually edit `CHANGELOG.md` or bump versions in a feature PR.

For a release, maintainers run `pnpm changeset:version` in a release branch. That consumes pending changesets, updates `CHANGELOG.md`, synchronizes the OpenAPI version, and refreshes the lockfile. Review that diff before merging the release PR. The release workflow publishes after the version change reaches `main`.

## Diagnose failures

`/healthz` reports liveness. `/readyz` reports dependency readiness. `/metrics` requires a bearer JWT and exposes worker queues, capacity, refusal counts, and timing data. API logs contain structured events. See [CONFIGURATION.md](CONFIGURATION.md) for settings and worker recovery outcomes.

Report defects with the revision, reproduction, expected and actual behavior, and redacted logs. Report security defects through [SECURITY.md](SECURITY.md).

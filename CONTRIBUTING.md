# Contributing to sql-fs

Thank you for your interest. This guide covers everything you need to go from zero to a merged PR.

## Prerequisites

- **Node.js ≥ 22** and **pnpm**
- **Postgres** — only required for integration tests; unit tests run without a database
- **Redis** — optional; only needed for distributed lock / snapshot cache integration tests

## Setup

```bash
git clone https://github.com/your-org/sql-fs-api.git
cd sql-fs-api
pnpm install
cp .env.example .env        # defaults target the local compose stack (below)
pnpm dev                    # dev server at http://localhost:8080
```

## Local database

The unit tests need no database, but the **integration suite** (`pnpm test:integration`)
requires Postgres (and, for the distributed-lock / cache suites, Redis). The fastest
way to get both is the bundled compose stack:

```bash
docker compose -f docker-compose.local.yml up -d
```

This starts Postgres + Redis and runs `scripts/initdb/00-create-app-role.sql`, which
provisions a **non-superuser** role `sqlfs_app` that **owns** the `sqlfs` database.
Point your connection strings at it (these are the defaults baked into `.env.example`):

```bash
export DATABASE_URL=postgres://sqlfs_app:sqlfs_app@localhost:5432/sqlfs
export REDIS_URL=redis://localhost:6379
```

### Why a non-superuser owner role (do not use the default `postgres` user)

Migration `0005_enable_rls.sql` turns on `FORCE ROW LEVEL SECURITY` for sandbox
isolation. The connecting role therefore has hard requirements that aren't obvious:

- **Not a superuser.** A superuser (the `postgres` image's default role) has
  `BYPASSRLS` and **silently bypasses** the policy. The RLS suite then fails with
  confusing errors — under "sandbox A's context", queries return rows from *every*
  sandbox.
- **Owns the schema and tables.** The boot-time migration runner creates objects in
  `public`, and `rls.integration.test.ts` re-applies `0005`'s
  `ALTER TABLE … FORCE ROW LEVEL SECURITY`, which requires table ownership (a
  non-owner fails with `must be owner of table inodes` / `permission denied for schema public`).
- **`CREATEDB`.** The multi-tenant and migrations suites create ephemeral databases
  at runtime from `DATABASE_URL`.

The compose `initdb` script sets all three up for you. If you bring your own Postgres,
mirror it (Postgres 16):

```sql
CREATE ROLE sqlfs_app LOGIN PASSWORD 'sqlfs_app' NOSUPERUSER NOBYPASSRLS CREATEDB;
CREATE DATABASE sqlfs OWNER sqlfs_app;
\connect sqlfs
ALTER SCHEMA public OWNER TO sqlfs_app;   -- PG15+: lets the migration runner CREATE in public
```

### Applying migrations

There is no manual migrate step — the server applies every migration in
`src/sql-fs/migrations/postgres/` on boot (`src/api/migrations.ts`). Start it once
against the compose database to create the schema before running the integration suite:

```bash
DATABASE_URL=postgres://sqlfs_app:sqlfs_app@localhost:5432/sqlfs pnpm dev   # creates tables on boot; stop once it logs "server_start"
```

(`pnpm db:generate` only *scaffolds* a new migration SQL from `schema.ts`; it does not apply anything.)

### Running the suite

```bash
DATABASE_URL=postgres://sqlfs_app:sqlfs_app@localhost:5432/sqlfs \
REDIS_URL=redis://localhost:6379 \
pnpm test:integration
```

All suites share one database, so a fully parallel run can occasionally hit transient
`deadlock detected` errors (DDL-vs-DML lock contention between files). If you see one,
re-run serialized — it's not a real failure:

```bash
pnpm test:integration -- --no-file-parallelism --poolOptions.forks.singleFork
```

Reset the database to a clean slate (re-runs the `initdb` script) with
`docker compose -f docker-compose.local.yml down -v`.

## Development workflow

```bash
pnpm dev                    # hot-reload dev server
pnpm typecheck              # type check (must pass before PR)
pnpm lint:fix               # format + lint (Biome)
pnpm test:unit              # unit tests — no DB required
pnpm test:integration       # integration tests — requires DATABASE_URL
pnpm test                   # all tests
```

Always run `pnpm typecheck && pnpm lint:fix && pnpm test:unit` before pushing.

## Architecture

Read [DEVELOPER.md](DEVELOPER.md) before touching `session-manager.ts`, `sql-fs.ts`, or any dialect code. It covers the three-lock model, cache layers, and cross-replica coherence in detail.

## Coding standards

Full standards are in [CLAUDE.md](CLAUDE.md). Key points:

- No `any` — use `unknown` and narrow
- All errors are `Error` instances with a `code` property; SQL errors go through `translateSqlError()`
- Every `IFileSystem` method is async; SQL ops run inside explicit transactions
- Sandbox isolation is non-negotiable — every query must be scoped to `sandbox_id`
- Use null prototypes for `Record<string, T>` objects with user-controlled keys

## Submitting a PR

1. Fork the repo and branch from `main`
2. Make your changes
3. Run the quality gate: `pnpm typecheck && pnpm lint:fix && pnpm test:unit`
4. Create a changeset (see below)
5. Commit both your code and the generated changeset file
6. Open a PR — describe what changed and why

## Versioning with Changesets

This project uses [Changesets](https://github.com/changesets/changesets) to manage versioning and the changelog. Every PR that changes behaviour (feature, fix, or breaking change) must include a changeset.

### Creating a changeset

```bash
pnpm changeset
```

The CLI will ask you to:

1. Select a bump type:
   - `patch` — bug fixes, docs, chores, refactors
   - `minor` — new features (backwards-compatible)
   - `major` — breaking API or schema changes
2. Write a one-line summary of what changed (this becomes the changelog entry)

Commit the generated `.changeset/*.md` file alongside your code.

### Maintainer release flow

When cutting a release, a maintainer runs:

```bash
pnpm changeset:version
```

This does three things atomically:
1. Merges all pending changesets into `CHANGELOG.md` and bumps `package.json`
2. Syncs the version into `src/api/openapi-spec.ts` (via `scripts/sync-openapi-version.mjs`)
3. Updates `pnpm-lock.yaml`

Commit the result and push — the CI pipeline cuts a GitHub Release from the new `CHANGELOG.md` entry.

## Reporting issues

Open a GitHub issue with:
- The sql-fs version (`pnpm list sql-fs-api` or the `/readyz` response)
- Steps to reproduce
- Expected vs actual behaviour
- Relevant logs (redact connection strings)

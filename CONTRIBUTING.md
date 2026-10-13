# Contributing

## Prerequisites

- Node.js 22 or later.
- pnpm. The `packageManager` field in `package.json` pins the version.
- Docker, for the local Postgres and Redis. Unit tests need neither.

## Set up a local checkout

1. Clone the repository: `git clone https://github.com/Hazzng/sql-fs.git && cd sql-fs`.
2. Install dependencies with `pnpm install`. The install also sets up the lefthook git hooks.
3. Copy the example environment with `cp .env.example .env`. `pnpm dev` reads `.env`, and the defaults match the compose stack.
4. Start Postgres and Redis with `docker compose -f docker-compose.local.yml up -d`. [Local database](#local-database) explains what the stack creates.
5. Start the dev server with `pnpm dev`. It listens on `http://localhost:8080` and applies the migrations on boot.

To serve the app at a stable `https://sql-fs.localhost` URL on a dynamic port, run `pnpm dev:portless` instead. To mint a bearer token for local requests, run `pnpm token:create -- --sub dev`.

## Local database

`docker-compose.local.yml` starts Postgres 16 and Redis 7. On the first start, `scripts/initdb/00-create-app-role.sql` creates the role that the app and the tests connect as. Point your shell at it:

```bash
export DATABASE_URL=postgres://sqlfs_app:sqlfs_app@localhost:5432/sqlfs
export REDIS_URL=redis://localhost:6379
```

Do not connect as the image's `postgres` superuser. Migration `0005_enable_rls.sql` turns on `FORCE ROW LEVEL SECURITY`, so the role needs three properties:

- **Not a superuser.** A superuser has `BYPASSRLS` and skips the policies. The RLS suite then sees rows from every sandbox and fails with confusing errors.
- **Owner of the database and the `public` schema.** The migration runner creates tables in `public`, and `ALTER TABLE ... FORCE ROW LEVEL SECURITY` requires ownership. Without it, boot fails with `must be owner of table inodes` or `permission denied for schema public`.
- **`CREATEDB`.** The multi-tenant and migrations suites create throwaway databases.

To use your own Postgres 16, run the same statements as the init script:

```sql
CREATE ROLE sqlfs_app LOGIN PASSWORD 'sqlfs_app' NOSUPERUSER NOBYPASSRLS CREATEDB;
CREATE DATABASE sqlfs OWNER sqlfs_app;
\connect sqlfs
ALTER SCHEMA public OWNER TO sqlfs_app;
```

sql-fs has no migrate command. The server applies every file in `src/sql-fs/migrations/postgres/` on boot, from `src/api/migrations.ts`. To migrate a fresh database before you run the integration suites:

1. Run `pnpm dev`.
2. Wait for the `server_start` log line.
3. Stop the server.

The integration suites check for a migrated schema and fail without one. `pnpm db:generate` only scaffolds a new migration file from `schema.ts`. It applies nothing.

To wipe the database, run `docker compose -f docker-compose.local.yml down -v`. The next `up` runs the init script again.

## Run the checks before you push

```bash
pnpm typecheck              # tsc --noEmit
pnpm lint:fix               # Biome format and lint
pnpm test:unit              # every test outside an integration/ directory, no database needed
pnpm test:integration       # needs DATABASE_URL, and REDIS_URL for the Redis suites
pnpm test                   # unit and integration tests
pnpm test -- path/to/file.test.ts
pnpm test:comparison        # just-bash comparison fixtures, set RECORD_FIXTURES=1 to record
```

Before you push, run `pnpm typecheck && pnpm lint:fix && pnpm test:unit`. CI runs typecheck, `pnpm lint`, the unit tests and the build. CI does not run the integration suites. If you change SQL, locking or session code, run them yourself.

## Integration tests run one file at a time

The integration tests live in `src/sql-fs/tests/integration/` and `src/api/tests/integration/`. The database-backed suites skip if `DATABASE_URL` is unset. Two files do not use the database. `heartbeat-gap.redis.integration.test.ts` needs only `REDIS_URL`, and `git-network.integration.test.ts` runs on an `InMemoryFs` with no prerequisites. The cross-replica, multi-tenant, worker-owner, and blob cache suites need `REDIS_URL` as well as `DATABASE_URL`.

`pnpm test:integration` passes `--no-file-parallelism`, because the database-backed files share one database and its `max_connections`. Parallel files run out of connection slots unless you raise that limit.

One suite runs migration DDL against the shared database. In `src/sql-fs/tests/integration/postgres.test.ts`, the `fs_resolve` tests apply `0001_rls_and_procs.sql` to `DATABASE_URL` in `beforeAll`. The migration and multi-tenant suites create their own databases and migrate those. A `deadlock detected` error in a run is a real bug, so investigate it instead of re-running.

## Read the standards before you change code

[CLAUDE.md](CLAUDE.md) holds the coding standards, the architecture summary and the caching rules. Read [DEVELOPER.md](DEVELOPER.md) before you change `session-manager.ts`, `sql-fs.ts` or dialect code. [CONFIGURATION.md](CONFIGURATION.md) documents every environment variable.

`just-bash` is an npm dependency, not vendored source. Local fixes to it ship as the pnpm patch `patches/just-bash@3.6.0.patch`, which `pnpm-workspace.yaml` registers. `scripts/build-just-bash-patch.mjs` builds that patch from a published package and a rebuilt one.

## Open a pull request with a changeset

1. Branch from `main`.
2. Run the checks in [Run the checks before you push](#run-the-checks-before-you-push).
3. If the change is a feature, a fix or a breaking change, run `pnpm changeset`. Pick the bump and write a one-line summary. The summary becomes the changelog entry.
4. Commit the generated `.changeset/*.md` file with your code.
5. Open the PR and say what changed and why.

| Bump | Use it for |
|---|---|
| `patch` | Bug fixes, docs, chores and refactors |
| `minor` | Features that stay backwards-compatible |
| `major` | Breaking API or schema changes |

Do not edit `CHANGELOG.md` or bump a version in a feature PR.

## Cut a release

A maintainer batches every pending changeset into one release PR:

1. Create a `chore/release` branch from an up-to-date `main`.
2. Run `pnpm changeset:version`. It bumps `package.json`, writes `CHANGELOG.md`, syncs the version into `src/api/openapi-spec.ts`, updates `pnpm-lock.yaml` and deletes the consumed changesets.
3. Review `git diff`, commit as `chore: release vX.Y.Z`, push, and open the PR.

Every push to `main` runs the `Release` workflow, which builds and pushes the container image. If the top version in `CHANGELOG.md` has no `v<version>` tag yet, the workflow also creates the tag and publishes a GitHub Release.

## Report an issue

Open a GitHub issue. Include the version from `package.json` or the release tag, the steps to reproduce, the expected and actual behaviour, and the relevant logs with connection strings removed.

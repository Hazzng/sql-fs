# Working on sql-fs

sql-fs serves persistent bash sandboxes over HTTP and MCP. The API uses Postgres for durable state and optional Redis for distributed coordination and blob caching. The filesystem factory also offers in-memory storage for tests. MySQL, Azure SQL, and Azure FileShare are unimplemented factory options, not supported API backends.

## Start here

Use Node 22 from `.node-version`, pnpm 10.30.3 from `package.json`, Python 3.12, and uv 0.9.18. Bash and Docker Compose v2 are needed for local integration verification. Python SDK CI also covers Python 3.9, 3.11, and 3.13.

```bash
pnpm setup:dev          # install all three packages from their lockfiles; install git hooks
pnpm check          # types, formatting, unit tests, builds, and both SDKs; no services or .env needed
pnpm verify:local   # isolated Postgres/Redis, HTTP/MCP contracts, integration tests, and both live SDKs
pnpm verify:architecture # also worker failure, stream finalization, input budgets, and multi-tenant proofs
```

`pnpm verify:local` uses random loopback ports and a unique Compose project, applies migrations through server startup, and removes only its own containers and volumes. It ignores `.env` and inherited deployment settings. It writes logs and JSON proof to `scripts/verify/.run/`. A missing Docker daemon or skipped integration test fails the command.

`pnpm verify:architecture` runs the standard verification plus `worker-failures.mjs`, `sse-finalization.mjs`, `input-budgets.mjs`, and `tenants.mjs` in the same disposable stack. Run it for worker ownership, script completion, command protocol, or isolation changes. CI runs this expanded profile on pushes to `main`; PR checks keep the faster static, unit, build, and SDK gates. Resource and large-file profiling remain separate and require a suitable cgroup v2 host.

Use `pnpm check:typescript` or `pnpm check:python` for SDK-only changes. Run a targeted core test with `pnpm exec vitest run src/sql-fs/tests/unit/sql-fs.cache.test.ts`. A nonexistent test selection must fail. `pnpm test:integration` is the lower-level command for an already migrated disposable database with `DATABASE_URL` and `REDIS_URL`; it can skip without those variables. Prefer `pnpm verify:local` for completion evidence.

See [READINESS.md](docs/READINESS.md) for verified scope and hosted follow-up. Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup and contribution steps, [DEVELOPER.md](docs/DEVELOPER.md) before changing consistency or session ownership, and [README.md](README.md) for API behavior, and [CONFIGURATION.md](docs/CONFIGURATION.md) for runtime settings.

Python type checking targets the oldest supported interpreter. `pnpm check:python:types` uses uv to provision Python 3.9 in `clients/python/.venv-py39`, separate from the Python 3.12 development environment. This keeps the dependency syntax aligned with the declared target. Mypy stays below version 2 while Python 3.9 is supported.

## Where to make changes

| Concern | Source | Verification |
| --- | --- | --- |
| Filesystem, transactions, caching, RLS | `src/sql-fs/`, especially `sql-fs.ts`, `types.ts`, `dialects/postgres.ts` | `src/sql-fs/tests/`, `pnpm verify:local` |
| HTTP validation, auth, execution, ingest | `src/api/routes/`, `auth.ts`, `validation.ts`, `session-manager.ts` | `src/api/tests/unit/`, `scripts/verify/contracts.mjs` |
| Worker ownership, budgets, recovery | [Ownership map](src/api/worker-owner/README.md), `src/api/worker-owner/`, `src/api/ingress-admission.ts` | worker tests in `src/api/tests/`, `scripts/verify/sdk-clients.mjs` |
| Redis control/data isolation | `src/redis/`, `src/sql-fs/redis-blob-cache.ts` | `src/redis/tests/`, integration suite |
| MCP | `src/api/mcp/` | MCP unit tests and HTTP contract verification |
| TypeScript SDK | `clients/typescript/src/` | `pnpm check:typescript`, live SDK verification |
| Python SDK | `clients/python/src/sqlfs/` | `pnpm check:python`, live SDK verification |
| SQL migrations | `src/sql-fs/migrations/postgres/`, `src/api/migrations.ts` | migrations and RLS integration tests |

## Ownership and API contracts

`pnpm check:architecture` checks production TypeScript imports and script-scope calls. Worker internals stay in `src/api/worker-owner/`; the checker lists the permitted named imports for session management, ingress, request context, and metrics. Mutable reservation state must not be imported by callers. Put completion policy in `src/sql-fs/script-scope.ts`; routes use the shared helper instead of calling begin/end/abort themselves. `src/execution/owner-cancellation.ts` holds the lease-loss context shared by execution and filesystem fencing.

The boundary checker uses TypeScript symbols to follow named imports, re-exports, aliases, and literal dynamic imports. Its fixture tests must reject a forbidden import and duplicated completion policy. Tests of worker mechanics can still access their owner's internals. Nonliteral imports, dynamic imports of `node:module` or `module`, CommonJS loaders (including aliases), and direct or reflective script-scope calls are rejected outside their owners. The checker catches source-level regressions; it is not a security sandbox or a whole-program dataflow analysis.

Live contract and SDK verification validates observed `/v1` operations, status codes, media types, and JSON bodies against `/openapi.json`. Update `src/api/openapi-spec.ts` when changing an API contract. The schema checker does not replace the existing streaming, binary-content, retry, and persistence assertions. Unexercised operations and query/header parameter semantics require their own coverage.

## Invariants

- Preserve tenant and owner isolation. Parameterize SQL and scope sandbox queries. The Postgres app role must own its tables without superuser or `BYPASSRLS` privileges.
- Keep database transactions, durable epochs, generation fencing, and Redis leases consistent. Outside a script scope, commit to the database before updating caches. Buffered script metadata can lead the database until scope finalization. Failed flushes must reload committed state or poison the cache.
- A worker may complete a write before its reply is lost. Preserve typed unknown-outcome errors and never automatically replay that execution. Worker routing and recovery live in `src/api/worker-owner/`.
- Preserve cancellation, deadlines, body limits, read-only enforcement, and worker budgets when adding entry points. Run integration verification after changes to those boundaries.
- Sanitize database and filesystem errors before exposing them. HTTP errors use `{ error, code }`. Do not log tokens or connection strings.
- Symlinks are enabled by default; callers can explicitly disable creation with `allowSymlinks: false`. Preserve bounded resolution and account for target strings in cache estimates. Normalize paths and reject null bytes. Use `Map` or null-prototype objects for user-controlled keys.
- Static MCP keys belong to trusted proxies that authenticate users and overwrite the identity header. A shared key holder can choose the owner header.

## Code and tests

Use strict TypeScript, `unknown` at external boundaries, and explicit return types on exported functions. Keep the existing Biome style, tabs and 120-column lines. Run `pnpm lint:fix` for formatting and inspect its diff. Keep tests near their source in `tests/`; use real Postgres integration tests for transaction or isolation behavior. Assert observable results and clean up every sandbox a test creates.

TypeScript 7.0.2 builds and checks both TypeScript packages. Oxlint complements Biome with native correctness, selected type-aware promise checks, and test-integrity rules: `pnpm lint` runs both, and CI runs that command. `pnpm lint:fix` applies Biome fixes and then checks Oxlint. Keep Biome rules until equivalent coverage is verified. See [the anti-slop policy](tools/oxlint/anti-slop/README.md) for enabled rules, test-fixture exceptions, and vendored-source update instructions.

Unit tests run with two Vitest workers to bound CPU and WASM memory pressure. Do not increase parallelism or weaken a timeout assertion to hide a failure. Reproduce the failing behavior first. Commit hooks check staged TypeScript style and types, plus Python style and types when relevant.

Migrations are handwritten numbered SQL files. Add the next migration without editing an applied migration. The boot runner applies them for each configured tenant. There is no Drizzle schema or generation step.

`just-bash@3.6.0` has a substantial checked-in patch. Dependabot may open upgrade PRs for this package; maintainers review the upgrade and patch before merging. Read `scripts/build-just-bash-patch.mjs` and `patches/` before upgrading it. Regenerate the patch and run the full unit suite and `pnpm verify:local`; do not drop it to make an install pass.

## Completion and boundaries

Work autonomously on local implementation and reversible verification. Use a separate checkout for concurrent writers. Do not overwrite another agent's changes. Keep secrets out of commits and evidence. Use the disposable verification stack for tests that create databases or inject faults.

Before handing back, run `pnpm check`, then `pnpm verify:local` for runtime, database, dependency, or SDK behavior changes. Run `pnpm security:audit` after dependency changes. Report the commands, results, and any unverified claims. A skipped test is not proof.

Add a `.changeset/*.md` entry for behavior changes. Do not bump versions or edit `CHANGELOG.md` in feature work. Deployment, release, merging, production data changes, and shared-branch force pushes need explicit task authorization. Repository changes do not prove that hosted CI or branch protection is active.

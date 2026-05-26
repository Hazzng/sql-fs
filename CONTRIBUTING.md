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
cp .env.example .env        # fill in DATABASE_URL and AUTH_SECRET at minimum
pnpm dev                    # dev server at http://localhost:8080
```

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

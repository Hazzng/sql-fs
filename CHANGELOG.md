# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.13] - 2026-05-01

### Added

- `scripts/benchmark_remote_bash.py`: end-to-end Remote Bash latency benchmark hitting the live HTTP API via the Python SDK. Runs in two phases — sandbox lifecycle (create / ingest / delete over N fresh sandboxes) and exec latency (find / grep / rg / write / delete / mkdir / mv cases on a warm sandbox). Reports wall-clock ms and server-side `duration_ms` (avg / p50 / p95 / max) as markdown tables. Supports both `virtualfs` and `daytona` providers via `--provider`, auto-detects writable home dir on Daytona, and sweeps leftover `bench-*` sandboxes on exit. Run with `pnpm bench:remote-bash`. See README for full instructions.

### Removed

- `src/fs/sql-fs/benchmark.ts` and the `bench:sql-fs-cache` npm script. Replaced by the more comprehensive `scripts/benchmark_remote_bash.py` which exercises the actual HTTP API path instead of the dialect directly.

## [0.2.12] - 2026-05-01

### Changed

- Reorganized colocated `*.test.ts` files into per-module `tests/` directories so source and tests are visually separated. Affects `src/api/`, `src/api/lib/`, `src/fs/sql-fs/`, `src/fs/sql-fs/dialects/`, and `src/redis/`. No source or runtime changes.

## [0.2.11] - 2026-04-30

### Added

- `SqlDialect.getBlobsForSandbox(sandboxId, maxBytes)` and `RedisBlobCache.mget(sha256s)` for batched content prewarm. The dialect method issues a metadata-only window-CTE first, bulk-fetches misses from Redis L2, then one batched `WHERE sha256 = ANY(…)` for remaining Postgres misses.

### Changed

- `SqlFs.ready()` and `SqlFs.reload()` now kick off a non-fatal background content-cache prewarm. Cache-miss reads in `readFile`/`readFileBuffer` coalesce onto the in-flight prewarm rather than racing it with per-file SELECTs. Cold-grep latency on a 125-file / 1 MB tree drops from ~9.4 s to ~3.8 s on remote Postgres deployments.

## [0.2.10] - 2026-04-30

### Changed

- Removed the per-blob read transaction wrapper from `readFile`/`readFileBuffer`. Cache-miss reads now issue a single pool-level SELECT instead of `BEGIN`/`SET LOCAL`/`COMMIT`/`SELECT`/`COMMIT`. ~70 % reduction in cold-grep latency on remote Postgres deployments. Internal change; no API surface impact.

## [0.2.9] - 2026-04-30

### Added

- `lefthook` pre-commit hooks: runs `ruff format --check` and `ruff check` against `clients/python/**` staged changes; runs `mypy src/` when `.py` files are staged. Hooks are installed automatically on `pnpm install` via the `prepare` script.
- GitHub Actions workflow `python-sdk-ci.yml`: path-filtered CI for the Python SDK (lint, typecheck, test matrix on Python 3.9/3.11/3.13).
- GitHub Actions workflow `python-sdk-release.yml`: automated PyPI publish via OIDC trusted publisher when `clients/python/**` changes land on `main`.
- `clients/python/CHANGELOG.md` for Python SDK version tracking.

### Changed

- `bulkIngest` now populates the in-memory content cache with the bytes it just received, eliminating a database round-trip on the very next read of an ingested file. No API surface change.
- Python SDK PyPI distribution name renamed from `virtualfs` to `virtualfs-sdk`.
- Fixed pre-existing mypy strict errors in `clients/python/src/virtualfs/_http.py` and `models.py`: typed `list`/`tuple` type arguments, cast `Literal` for `StreamEvent.type`.
- Fixed pre-existing ruff lint/format issues in `clients/python/examples/perf_benchmark.py` and `tests/test_client.py`.

## [0.2.8] - 2026-04-28

### Added

- `jti` claim on tokens minted by `POST /v1/auth/admin`, generated via `randomUUID()` and recorded in the `admin_token_issued` audit log so a leaked-token incident can be correlated back to the issuing log line.
- `admin_token_issued`, `admin_token_denied`, and `admin_token_misconfigured` audit log events on `POST /v1/auth/admin` (matching issue #23 names; bootstrap retains the existing `auth_bootstrap_*` events).
- `auth_rate_limited` audit log event emitted when a rate-limited request is rejected.
- `src/api/rate-limit.ts` — in-memory rate-limit primitive with injectable store and clock. Mounted on `/v1/auth/admin` (keyed by IP and Bearer sub) and `/v1/auth/bootstrap` (keyed by IP).
- Env vars: `ADMIN_RATE_LIMIT_WINDOW_MS` (default `60000`), `ADMIN_RATE_LIMIT_MAX` (default `5`), `BOOTSTRAP_RATE_LIMIT_WINDOW_MS` (default `60000`), `BOOTSTRAP_RATE_LIMIT_MAX` (default `5`), `TRUST_PROXY_HEADERS` (default `false`).
- `InMemoryRateLimitStore` now caps live keys (default `10000`) with FIFO eviction so attacker-controlled key cardinality (e.g. spoofed `X-Forwarded-For` against unauthenticated bootstrap) cannot grow the store unbounded within a window.
- HTTP `429 RATE_LIMITED` response (with `Retry-After` header) on both auth endpoints when the limit is tripped.

### Changed

- `constantTimeEqual()` in `src/api/routes/auth.ts` now compares SHA-256 digests of the inputs, removing the early-return length oracle. Used by both `POST /v1/auth/bootstrap` and `POST /v1/auth/admin`.
- `POST /v1/auth/admin` is now structured as pre-middleware → `validateBody` → handler so the `X-Admin-Secret` check runs before body parsing. Wrong/missing secrets now return 403 even for malformed bodies (previously returned 400 from Zod). The handler also hard-fails with 500 `AUTH_NOT_CONFIGURED` when `AUTH_SECRET` is unset.
- Rate-limit `clientIp()` no longer reads `X-Forwarded-For` / `X-Real-IP` by default — those headers are spoofable. Operators behind a trusted ingress that strips inbound forwarding headers must opt in via `TRUST_PROXY_HEADERS=true`. Otherwise the connecting socket's `remoteAddress` is used. See `plugins/virtualfs/skills/api/SETUP.md` for the full trust-proxy note.

## [0.2.7] - 2026-04-28

### Changed

- **perf(ingest):** Batch directory existence checks per depth level in `bulkIngest`, reducing ~40 sequential DB round-trips to ~4 (one per depth level).
- **perf(ingest):** Replace post-write `reload()` (full recursive CTE re-read) with in-memory `pathCache` merge from `INSERT RETURNING` data — zero DB calls after commit.
- `SqlDialect.bulkIngest` return type changed from `Promise<void>` to `Promise<Map<string, PathCacheEntry>>` to support cache merge.

### Fixed

- **bulkIngest EISDIR:** Ingesting a file at a path that is currently a directory now throws `EISDIR` instead of silently overwriting the directory and orphaning its children.
- **bulkIngest ENOTDIR:** Ancestor directory check now JOINs `inodes` to verify `kind=DIRECTORY`, throwing `ENOTDIR` if an ancestor is a file or symlink.
- **bulkIngest nlink:** Overwriting two hardlinks to the same inode now decrements `nlink` by the correct count (was only decrementing once due to `IN`-clause deduplication).
- **bulkIngest contentCache:** Overwritten file inodes are evicted from `contentCache` during the cache merge, preventing stale content reads.

## [0.2.6] - 2026-04-28

### Added

- `GET /v1/sandboxes` — list all sandboxes owned by the authenticated user, queried directly from Postgres for accuracy across replicas.
- `sandbox_list` MCP tool providing the same listing capability to MCP clients.
- `name` field on sandboxes: optional human-readable name (`TEXT`, max 255 chars) set at creation time via `POST /v1/sandboxes` body or `sandbox_create` MCP tool. Returned in create, get, and list responses.
- Postgres migration `0003_add_sandbox_name.sql` adding the `name` column.
- `listSandboxes` method on `SqlDialect` interface and Postgres dialect implementation.
- OpenAPI spec updated with the new list endpoint and `name` field on all sandbox schemas.

## [0.2.5] - 2026-04-26

### Fixed

- Move `vi.restoreAllMocks()` into `afterEach` in exec-batch tests so spy cleanup is guaranteed even when a test throws.
- Align `bash_exec_batch` MCP tool description to reference the `timeout` field (not `timeoutMs`) so clients send the correct key.
- Sanitize unexpected `bash_exec_batch` MCP errors: log server-side and return `"internal error"` instead of exposing `err.message`.
- Propagate client disconnect into batch cancellation via `c.req.raw.signal`, releasing the session lock early instead of running to timeout.

## [0.2.4] - 2026-04-26

### Added

- Batch execution endpoint `POST /v1/sandboxes/:id/exec-sync-batch` that collapses N sequential exec round-trips into a single HTTP request, eliminating transport overhead for exploration workflows.
- `bash_exec_batch` MCP tool providing the same capability to MCP clients.
- OpenAPI spec for the new batch endpoint.

## [0.2.3] - 2026-04-26

### Added

- `POST /v1/auth/bootstrap` — unauthenticated token bootstrap endpoint that exchanges `AUTH_SECRET` (passed in `X-Auth-Secret`) for a signed JWT, breaking the chicken-and-egg dependency on `POST /v1/admin/tokens` for external clients (issue #27). Uses constant-time secret comparison, hard-fails when `AUTH_SECRET` is unset, validates tenants against the configured set, and emits `auth_bootstrap_issued` / `auth_bootstrap_denied` audit events.

## [0.2.2] - 2026-04-26

### Fixed

- Updated OpenAPI spec to document new `debug` request parameter and `exitSignal`, `timedOut`, `durationMs` response fields on exec-sync 200/408 responses.

## [0.2.1] - 2026-04-26

### Fixed

- `timeoutMs` query parameter now rejects values exceeding 300000 with a 400 error instead of silently capping.

### Added

- SSE streaming tests for `text/plain` content type and `timeoutMs` query parameter timeout enforcement.

## [0.2.0] - 2026-04-26

### Added

- Accept `text/x-shellscript` and `text/plain` content types on `exec-sync` and `exec` (SSE) endpoints — the raw request body is used as the script verbatim, removing the need for JSON encoding. Optional `?timeoutMs=` query parameter available in plaintext mode. Returns 415 for unsupported content types.
- Enriched exec-sync response with `exitSignal`, `timedOut`, and `durationMs` fields for better error disambiguation.
- Enriched 408 timeout response with `timedOut` and `durationMs` fields.
- `debug` request flag on exec-sync, exec (SSE), and MCP `bash_exec` that prepends `set -x` for command-level tracing without modifying the submitted script.

## [0.1.1] - 2026-04-26

### Changed

- Migrated Claude Code skills from `commands/virtualfs-api.md` + `skills/virtualfs-api/` into the plugin layout under `.claude-plugin/` and `plugins/virtualfs/`.

## [0.1.0] - 2026-04-26

### Added

- Initial release of `virtualfs-api`: persistent filesystem backend + HTTP/MCP API for `just-bash` sandboxes.
- SQL-backed `IFileSystem` implementation (`SqlFs`) with Postgres, MySQL, and Azure SQL dialects.
- Adjacency-list directory model with content-addressable blob storage and global dedup.
- Path cache (eager) and content cache (lazy LRU, 50 MB/session) for low-latency reads.
- HTTP API (Hono): sandboxes CRUD, file operations, exec (sync + SSE), ingest/export, admin GC.
- MCP server with 10 tools over streamable HTTP transport.
- Bearer-token auth, RLS-based sandbox isolation, default-deny symlinks, error sanitization.
- Multi-tenant routing and session rehydration.
- Docker image and Azure Container Apps deployment config.

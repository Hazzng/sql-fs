# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

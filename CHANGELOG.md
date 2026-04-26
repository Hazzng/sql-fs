# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

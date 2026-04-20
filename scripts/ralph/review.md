# Branch Review Report

Reviewed scope:
- `main...HEAD`
- Current tracked worktree edits
- Related untracked files in the worktree

Verification:
- Static review only. Attempts to run `pnpm test` and `pnpm typecheck` were blocked by the environment, so the findings below are from code and diff inspection.

## Overall Findings

1. `src/api/server.ts` + `src/api/mcp/tools.ts` introduce a critical auth/authz gap: `/mcp` is unauthenticated, and the MCP tools do not enforce ownership.
2. `src/api/routes/ingest.ts` and `src/api/mcp/tools.ts` accept unsanitized file keys, so `../` traversal can escape the requested `basePath`.
3. `src/api/routes/ingest.ts` does not check `bash.exec()` exit codes for `tar`, which can turn failed ingest/export operations into false-success or misleading responses.
4. `src/api/mcp/tools.ts` has additional correctness issues: `sandbox_delete` can return success for a missing sandbox, and `fs_export` can silently drop files after the worktree change that swallows all read errors.

## File Reviews

### `src/api/server.ts`
- Summary: mounts the new ingest/export HTTP routes and adds a new `/mcp` endpoint backed by the shared `SessionManager`.
- Potential bugs / logic errors:
  - No file-local logic bug beyond the route wiring itself, but this file exposes the new MCP surface without adding any guardrail around it.
- Security vulnerabilities:
  - Critical: `authMiddleware` only protects `/v1/*`, but `/mcp` is mounted outside that namespace. Every MCP tool becomes remotely reachable without authentication.
- Code quality improvements:
  - Put `/mcp` behind dedicated auth middleware or mount it under an authenticated prefix.
  - Add an HTTP-level regression test that unauthenticated `POST /mcp` and `GET /mcp` requests are rejected.
- Severity: critical

### `src/api/mcp/server.ts`
- Summary: adds MCP server creation plus streamable HTTP transport reuse keyed by `mcp-session-id`.
- Potential bugs / logic errors:
  - The module-level `sessions` map only shrinks when `onsessionclosed` fires. If clients disappear without a clean close, transports can accumulate indefinitely.
  - Unknown `mcp-session-id` values fall through to "create a new session" behavior instead of being rejected, which can hide client/session bugs.
- Security vulnerabilities:
  - High: this layer does not propagate any authenticated caller identity into tool handlers, so even after route auth is added there is still no per-owner authorization hook for the tools.
- Code quality improvements:
  - Bind caller identity into the MCP session context and pass it into `registerTools(...)`.
  - Add invalid-session tests and consider time-based cleanup for abandoned transports.
- Severity: high

### `src/api/mcp/tools.ts`
- Summary: adds `sandbox_create`, `sandbox_delete`, `bash_exec`, `fs_ingest`, and `fs_export`; the current worktree also renames `fs_export.path` to `basePath` and parallelizes export reads.
- Potential bugs / logic errors:
  - `sandbox_delete` ignores the boolean returned by `sessionManager.destroy()`. In the real implementation, a missing sandbox can yield `false`, but the tool still reports `{ ok: true }`.
  - `bash_exec`, `fs_ingest`, and `fs_export` all call `withSession()`, which auto-creates a sandbox when the ID does not exist. That lets callers bypass `sandbox_create` and create ownerless sandboxes implicitly.
  - The current worktree change makes `fs_export` swallow every `readFileBuffer()` failure. Directory skips are fine, but genuine read errors now degrade into silent partial exports.
  - `sandbox_create` advertises an optional `env` input and then ignores it completely.
- Security vulnerabilities:
  - Critical: there are no auth or ownership checks anywhere in the tool layer. Combined with the unauthenticated `/mcp` route, this is effectively remote arbitrary sandbox creation, command execution, file ingest/export, and deletion.
  - High: `fs_ingest` does not validate `relativePath`. Keys like `../outside.txt` will normalize outside the requested `basePath`.
  - Medium: `fs_export` can return arbitrarily large JSON payloads with no size guard or pagination.
- Code quality improvements:
  - Thread authenticated caller identity into every tool call and enforce ownership consistently.
  - Reject absolute paths, `..`, and NUL bytes in file keys before joining with `basePath`.
  - Surface partial export failures instead of silently skipping them.
  - Either implement `env` for `sandbox_create` or remove it from the schema/description.
- Severity: critical

### `src/api/routes/ingest.ts`
- Summary: adds three authenticated HTTP routes for tar.gz ingest, JSON/base64 file ingest, and tar.gz export.
- Potential bugs / logic errors:
  - All three handlers use `withSession()`, which auto-creates a sandbox if the ID does not exist. That means `POST /ingest`, `POST /ingest-files`, and `GET /export` can create orphaned sandboxes instead of returning 404.
  - The tar-based ingest/export paths call `session.bash.exec(...)` but never inspect `exitCode`. A bad archive, a failed `tar`, or a failed `rm` can still produce a 200 or a misleading follow-on error.
  - `Buffer.from(base64Content, "base64")` accepts malformed input leniently. Invalid payloads can silently decode to corrupted bytes instead of returning 400.
  - Temporary archive files are only deleted on the happy path; failures leave `/tmp/_ingest.tar.gz` or `/tmp/_export.tar.gz` behind inside the sandbox.
- Security vulnerabilities:
  - High: `ingest-files` does not validate `relativePath`, so `../` traversal can escape the requested `basePath`.
  - High: tar ingest trusts archive member paths and special entries. There is no screening for traversal entries, absolute paths, or other dangerous archive contents before extraction.
  - Medium: both upload and export fully buffer archive bytes in memory, with no request/response size limit.
  - Medium: ownership checks only consult the in-memory session. When a sandbox is cold or evicted, the new session starts with `owner = ""`, so the route cannot enforce persisted ownership.
- Code quality improvements:
  - Add a shared path-validation helper for manifest keys and archive extraction policy.
  - Check `bash.exec()` results explicitly and map failures to structured HTTP errors.
  - Clean up temp files in `finally` blocks.
  - Add negative tests for missing sandbox IDs, malformed base64, traversal attempts, and tar failures.
- Severity: high

### `src/api/__tests__/mcp.test.ts`
- Summary: adds end-to-end in-memory tests for MCP server init and all five MCP tools; the worktree also updates the `fs_export` argument name to `basePath`.
- Potential bugs / logic errors:
  - The delete-not-found test uses a mock that throws, so it never exercises the real `SessionManager.destroy() -> false` behavior that currently produces a false success in the tool.
  - There is no regression test for implicit sandbox creation when `bash_exec`, `fs_ingest`, or `fs_export` are called with a nonexistent ID.
- Security vulnerabilities:
  - No direct vulnerability in the test file, but it misses the two critical security cases: unauthenticated `/mcp` access and unauthorized access to another sandbox ID.
  - There is no test for `../` traversal in `fs_ingest`.
- Code quality improvements:
  - Add HTTP-level MCP tests for auth.
  - Add tool tests for missing IDs, traversal rejection, and partial export failure behavior.
- Severity: medium

### `src/api/__tests__/ingest.test.ts`
- Summary: adds unit tests for tar ingest, JSON ingest-files, and tar export happy paths plus a small amount of basic validation/auth coverage.
- Potential bugs / logic errors:
  - The helper `createTarGz()` shell-builds its file list and only works safely for simple names. Nested or shell-sensitive filenames would break the helper itself.
  - The tests do not cover failed `tar` commands, malformed base64 input, missing sandbox IDs, or leftover temp files.
- Security vulnerabilities:
  - No direct vulnerability in the test file, but it omits traversal coverage for JSON manifests and malicious tar member paths.
  - There is no regression test for the cold-session ownership gap.
- Code quality improvements:
  - Build archive fixtures without shell interpolation when possible.
  - Add failure-path tests for traversal attempts, malformed base64, tar extraction failures, and nonexistent sandbox IDs.
- Severity: medium

### `scripts/ralph/prd.json`
- Summary: replaces the Phase 2 planning file with a Phase 3 plan focused on ingest/export and MCP stories.
- Potential bugs / logic errors:
  - The current file is stale relative to the worktree: it still documents `fs_export` as `{ id, path? }`, while the current code/tests now use `basePath`.
  - The story `passes` flags read as complete even though the implementation still has major auth, authorization, and path-safety gaps.
- Security vulnerabilities:
  - The MCP stories do not require authentication or ownership enforcement, which likely contributed to the critical security gap that shipped in code.
- Code quality improvements:
  - Add explicit acceptance criteria for authN/authZ, traversal rejection, missing-sandbox behavior, and negative security tests.
  - Keep the documented tool contract in sync with current code (`basePath` vs `path`).
- Severity: low

### `scripts/ralph/progress.txt`
- Summary: rewrites the main Ralph progress log around Phase 3 work and implementation notes.
- Potential bugs / logic errors:
  - The log is stale relative to the current worktree: it still documents `handleMcpRequest(c.req.raw)` instead of `handleMcpRequest(c.req.raw, sessionManager)`.
  - It also still describes `fs_export` using `path?` instead of `basePath?`.
- Security vulnerabilities:
  - The notes normalize an unauthenticated `/mcp` mount pattern without calling out the security implications.
- Code quality improvements:
  - Record unresolved security issues and verification gaps, not only happy-path implementation notes.
  - Keep the log aligned with the live code contract after worktree edits.
- Severity: low

### `scripts/ralph/.last-branch`
- Summary: updates the branch marker from `ralph/phase1-sqlfs-postgres` to `ralph/phase3-ingest-mcp`.
- Potential bugs / logic errors:
  - None obvious; this appears to be an internal bookkeeping file.
- Security vulnerabilities:
  - None direct.
- Code quality improvements:
  - If this file is tool-managed and noisy, consider ignoring it from review/commit workflows unless it is intentionally versioned.
- Severity: low

### `REDIS_DISTRIBUTED_ARCH.md`
- Summary: adds a design doc for multi-replica Session Manager + Redis + Postgres behavior.
- Potential bugs / logic errors:
  - No code issues. The document is coherent as an architecture note.
- Security vulnerabilities:
  - No direct implementation vulnerability, but the doc should explicitly note that shared cache coherence never replaces auth/ownership checks.
- Code quality improvements:
  - Mark the document clearly as "proposed" versus "implemented".
  - Add a short section on tenant isolation and cache key hygiene if Redis is introduced later.
- Severity: low

### `src/fs/sql-fs/benchmark.ts`
- Summary: adds a standalone Postgres benchmark that seeds synthetic data and measures `ready()`, cold reads, and warm reads.
- Potential bugs / logic errors:
  - Running the script auto-applies migrations and mutates the database pointed to by `DATABASE_URL`; that is an operational footgun if someone points it at a shared or production database.
  - The file executes via top-level `await main()`, so any accidental import would run side effects immediately.
- Security vulnerabilities:
  - No app-facing vulnerability, but accidental execution against production credentials could still cause destructive operational impact.
- Code quality improvements:
  - Move it under a dedicated `scripts/` or `bench/` entry point.
  - Require an explicit opt-in env var before running against a real database.
  - Add CLI help and document that it expects an isolated benchmark database.
- Severity: medium

### `scripts/ralph/archive/2026-04-19-phase1-sqlfs-postgres/progress.txt`
- Summary: archived Phase 1 progress snapshot.
- Potential bugs / logic errors:
  - None in current use; this is a historical artifact.
- Security vulnerabilities:
  - None direct.
- Code quality improvements:
  - If these archives are intended to be immutable snapshots, consider documenting that convention so tooling does not treat them as live planning inputs.
- Severity: low

### `scripts/ralph/archive/2026-04-19-phase1-sqlfs-postgres/prd.json`
- Summary: archived Phase 1 PRD snapshot.
- Potential bugs / logic errors:
  - None in current use; it appears to be a preserved planning artifact.
- Security vulnerabilities:
  - None direct.
- Code quality improvements:
  - Same suggestion as above: make snapshot status explicit if other tooling scans `scripts/ralph/`.
- Severity: low

### `scripts/ralph/archive/2026-04-19-phase2-http-api/progress.txt`
- Summary: archived Phase 2 progress snapshot.
- Potential bugs / logic errors:
  - None in current use; historical snapshot only.
- Security vulnerabilities:
  - None direct.
- Code quality improvements:
  - Consider a lightweight archive index so humans/tools can distinguish "live" files from preserved history.
- Severity: low

### `scripts/ralph/archive/2026-04-19-phase2-http-api/prd.json`
- Summary: archived Phase 2 PRD snapshot.
- Potential bugs / logic errors:
  - None in current use; historical snapshot only.
- Security vulnerabilities:
  - None direct.
- Code quality improvements:
  - Same as the other archive files: make immutable/archive intent explicit for downstream tooling.
- Severity: low

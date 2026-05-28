# Changelog

## 0.5.0

### Minor Changes

- [#103](https://github.com/Hazzng/sql-fs/pull/103) Thanks [@Hazzng](https://github.com/Hazzng)! - Add `paths` param to `fs_ingest` MCP tool. Pass `{ relativePath: absoluteHostPath }` and the server reads bytes directly from the host filesystem — no base64 encoding, no file content generated as output tokens. Matches py-sdk `ingest_files()` performance. `files` (inline base64) is kept for small generated content but is now the exception path.

## 0.4.2

### Patch Changes

- Thanks [@Hazzng](https://github.com/Hazzng)! - Rebranding the repo as sql-fs

## 0.4.1

### Patch Changes

- [#95](https://github.com/Hazzng/sql-fs/pull/95) Thanks [@Hazzng](https://github.com/Hazzng)! - Add `durationMs` to `BatchScriptResult` so agents can profile individual script latencies inside a batch execution.

- [#96](https://github.com/Hazzng/sql-fs/pull/96) Thanks [@Hazzng](https://github.com/Hazzng)! - Fix GET /v1/sandboxes/:id returning stale createdAt and transient 404 after session eviction. The route now falls back to the database when the session is not in the in-memory pool, and createdAt is sourced from the DB RETURNING clause on creation and restored from DB meta on rehydration so all three endpoints (POST, GET, LIST) agree on the same timestamp.

## 0.4.0

### Minor Changes

- [#86](https://github.com/Hazzng/sql-fs/pull/86) Thanks [@Hazzng](https://github.com/Hazzng)! - feat(py-exec): add warm Python interpreter to eliminate 1.4s startup cost per invocation

  Introduces `py-exec`, a new bash command available in `python=true` sandboxes that routes Python execution through a persistent `python3` process instead of spawning a fresh CPython/WASM worker on every call.

  **Before:** `python3 -c 'print(1)'` → ~1.4 s per call (WASM cold boot)
  **After:** `py-exec -c 'print(1)'` → ~30–50 ms per call after first use

  The warm process uses a base64-encoded stdin/stdout turn protocol so arbitrary Python code (including multi-line scripts and `sys.exit()`) works safely without shell-quoting hazards. Variables persist across calls in the same session (stateful REPL semantics).

  The built-in `python3` command is still available for isolated, stateless execution.

## 0.3.10

### Patch Changes

- [#85](https://github.com/Hazzng/sql-fs/pull/85) Thanks [@Hazzng](https://github.com/Hazzng)! - fix(session-manager): persist cwd across exec calls

  `cd` executed inside a `bash.exec()` call was silently discarded because
  just-bash runs each call against a **copy** of the interpreter state;
  `bash.getCwd()` never changed. The next `exec` always started from the
  initial home directory (`/home/user`), causing agents that relied on `cd`
  for path convenience to silently grep or operate on the wrong directory.

  Fix: track `session.cwd` on each `Session` object (initialised from
  `bash.getCwd()` at creation). Before every `execWithRuntimeThrottle` call
  the tracked cwd is forwarded as `opts.cwd` (unless the caller already
  supplied an explicit `cwd`). After every **non-readOnly** exec the final
  working directory is read from `result.env.PWD` (always populated by
  just-bash) and stored back on `session.cwd`, so the next call starts
  from the correct directory.

  Semantics chosen: cwd is session-scoped and per-sandbox. It resets to
  `/home/user` only when the session is evicted (idle timeout or explicit
  destroy). readOnly execs use the current `session.cwd` as their starting
  directory but do not update it, consistent with the read-only contract.

  Note: env variables set via `export` inside a script also do not persist
  across exec calls — this is symmetric with the cwd behaviour and is the
  correct just-bash design. The issue report's claim that env persists was
  incorrect; only cwd needed fixing.

  Closes [#73](https://github.com/Hazzng/sql-fs/issues/73).

## 0.3.9

### Patch Changes

- [#81](https://github.com/Hazzng/sql-fs/pull/81) Thanks [@Hazzng](https://github.com/Hazzng)! - just-bash's built-in nodeStubCommand (registered alongside js-exec when javascript=true) ignores all arguments and unconditionally prints the full 60-line js-exec --help page to stderr before exiting 1. Added src/api/commands/node-command.ts — a custom Command that replaces the built-in stub via BashOptions.customCommands (which takes precedence over built-ins with the same name). Custom commands are only injected when javascript: true; non-JS sandboxes are unaffected.

## 0.3.8

### Patch Changes

- [#79](https://github.com/Hazzng/sql-fs/pull/79) Thanks [@Hazzng](https://github.com/Hazzng)! - Python SDK: expose `read_only` parameter on `Sandbox.exec_batch()`. When `read_only=True`, the request forwards `readOnly: true` to the server, activating parallel script execution under a shared read-lock. Defaults to `False` (sequential, write-lock) for full backward compatibility.

## 0.3.7

### Patch Changes

- [#69](https://github.com/Hazzng/sql-fs/pull/69) Thanks [@Hazzng](https://github.com/Hazzng)! - Parallel readOnly batch execution. POST /exec-sync-batch and MCP bash_exec_batch now run scripts in parallel when readOnly: true, bounded at 16 concurrent workers. Result order is preserved. Write-path batches are unchanged (sequential, exclusive lock). MCP client disconnects now propagate into in-flight scripts via extra.signal forwarding.

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.3.6

### Patch Changes

- 8d50059: add distributed lock for R-W so strong consistency is enforced

## [0.3.4] - 2026-05-13

### Added

- Cross-replica reader-writer exec lock (`withDistributedRWLock`, `src/api/distributed-rw-lock.ts`). Parallel `readOnly` execs now run concurrently across replicas while writers maintain strong cross-replica consistency: writers take an exclusive Redis flag, readers register a TTL'd entry in a per-sandbox ZSET, and writer-priority prevents reader starvation. `SessionManager.withSessionRead` acquires the new shared lock; `withSession` / `withExistingSession` / `withSessionOrRehydrate` use the exclusive path. New env vars: `REDIS_RWLOCK_ENABLED` (default `true`, deploy-window flag) and `REDIS_RWLOCK_READER_LEASE_MS` (default `60000`). Issue #61.
- Integration suite `cross-replica-rw-lock.integration.test.ts` covering parallel cross-replica readers, writer/reader blocking both directions, writer-priority under continuous readers, crashed-reader reaping, and version visibility after writes.

### Changed

- `rwLockKeys()` now wraps the sandbox id in a Redis Cluster hash tag (`vfs:{tenant}:rwlock:{<sandboxId>}:writer` / `…:readers`) so the two-key Lua scripts route to the same slot under Redis Cluster.

### Fixed

- `DistributedRWLockOptions` validation now requires `renewMs < readerLeaseMs` in addition to `renewMs < leaseMs`. Without this, a misconfigured `REDIS_RWLOCK_READER_LEASE_MS` shorter than `REDIS_EXEC_LOCK_RENEW_MS` could let a writer reap a live reader's ZSET entry between heartbeats and enter the critical section while a read was still in flight.

## [0.3.3] - 2026-05-11

### Changed

- `DEVELOPER.md`: documented the parallel-readOnly architecture. Core Data Flow now covers both write (`runExclusive`) and read (`runShared`) paths; Lock 1 rewritten as the `RWLock` (writer-priority, batch-wake, AbortSignal); new "ReadOnly Safety Model" section explains the three cooperating mechanisms (shared lock + refcounted FS scope + `readOnlyContext` AsyncLocalStorage attribution) and the `EREADONLY` → `EREADONLY_VIOLATION` remap; same-replica concurrency matrix and "what each lock catches" table extended for readOnly; Key Source Files lists `rw-lock.ts`, `read-only-context.ts`, `ownership.ts`, and `mcp/tools.ts`.

## [0.3.2] - 2026-05-11

### Added

- `portless` dev dependency, `portless.json` (`sql-fs-api`), and `pnpm dev:portless` to run the dev server behind stable `https://…localhost` URLs (including per-branch subdomains in git worktrees).

## [0.3.1] - 2026-05-11

### Fixed

- ReadOnly bash exec: a synchronous `EREADONLY` thrown by `SqlFs#assertWritable` that escapes `bash.exec` (e.g. via shell redirections like `echo x > /file`) is now remapped to `EREADONLY_VIOLATION` in `withSessionReadEntry`, so route handlers consistently return HTTP **422** instead of falling through to the generic 500. The narrow `code === "EREADONLY"` check preserves the existing behavior of letting unrelated `fn` errors win over a recorded violation.

## [0.3.0] - 2026-05-10

### Added

- Parallel readOnly bash exec on the same sandbox (single-replica). Callers opt in by passing `readOnly: true` on `/v1/sandboxes/:id/exec`, `/exec-sync`, `/exec-sync-batch`, and the MCP `bash_exec` / `bash_exec_batch` tools. ReadOnly execs route through the new `SessionManager.withSessionRead`: they take a per-session async readers-writer lock in _shared_ mode (multiple readers run concurrently), skip the distributed exec lock, and share one single-flighted `ensureFreshCache` probe + reload across the cohort. Writes still take the lock exclusively and are writer-priority — a queued writer blocks new readers, preventing reader starvation.
- Read-only safety net on `SqlFs`: while a read-only scope is active every mutating syscall (`writeFile`, `appendFile`, `mkdir`, `rm`, `chmod`, `utimes`, `cp`, `mv`, `symlink`, `link`, `bulkIngest`) throws `EREADONLY` _before_ any DB work. The scope is **reference-counted** so multiple concurrent readers share a single FS instance safely. Violation attribution uses an `AsyncLocalStorage`-based `readOnlyContext` so a lying script in one reader never falsely flags innocent concurrent readers — only the originating call's context is marked, and the session manager surfaces `EREADONLY_VIOLATION` (HTTP **422**) on that one call. Violations are emitted via `logAudit("read_only_violation", ...)`.
- New async readers-writer lock primitive `RWLock` (`src/api/rw-lock.ts`) replaces `async-mutex`'s `Mutex` on `Session`. Drop-in `runExclusive` for existing call sites plus a new `runShared`. AbortSignal support cancels pending acquisitions cleanly.
- OpenAPI spec documents the new `readOnly` request field on `/exec-sync`, `/exec`, and `/exec-sync-batch`, and the corresponding 422 response.

### Changed

- `Session.mutex: Mutex` is now `Session.lock: RWLock`. The `async-mutex` runtime dependency is no longer used by `SessionManager`. All exclusive-mode call sites (`withSessionEntry`, `destroy`, reaper, shutdown) are unchanged in semantics.
- `execWithRuntimeThrottle` skips the per-script `scriptTx.beginScope/endScope` wrapper when the call is inside a `readOnlyContext` (no writes can occur, and the shared `SessionScopedFs` would race across concurrent readers).
- `withSessionReadEntry` is now wrapped in `try/finally` so `session.inFlight` and `endReadOnlyScope` always run even when `fn` throws — fixes a counter leak that pinned sessions and prevented idle eviction.

## [0.2.20] - 2026-05-09

### Fixed

- `SessionManager.getOrCreate()` refuses new sessions once `shutdown()` has begun (checked at entry and again after `buildFs()` returns) so a request accepted before shutdown cannot register a session after the shutdown snapshot, leaking its dialect pool.
- Reaper now marks `state="closing"` before deleting and drains via `mutex.runExclusive` before disconnecting, so a request that already captured the session reference but has not yet entered the mutex observes `ESESSIONCLOSING` instead of running against a disconnected filesystem.
- Raw `PUT /v1/sandboxes/:id/files/*` pre-checks `Content-Length` and rejects oversized uploads (`PAYLOAD_TOO_LARGE`) before buffering the request body.
- Distributed lock heartbeat stops scheduling further `EVAL` renewals once the lock is lost or a renew times out, preventing command pile-up in the ioredis send queue when Redis is hung.
- `RedisBlobCache.mget()` chunks calls at 1024 keys per round-trip to bound peak reply size on warm sandboxes with large blob counts.

## [0.2.19] - 2026-05-09

### Fixed

- Wired production lifecycle: `SessionManager.startReaper()` and `startMcpSessionSweeper()` called at boot; `SIGTERM`/`SIGINT` now runs a full ordered shutdown — MCP transports → session drain + FS disconnect → meta dialects → Redis `quit()`.
- Postgres pool caps on `PostgresDialect.connect()` (`max: 2`, `idle_timeout: 30s`, `connect_timeout: 30s`, `max_lifetime: 30m`) to prevent connection exhaustion under load.
- `createPostgresSandboxFs()` now disconnects the dialect on any post-`connect()` failure (sandbox bootstrap, `fs.ready()`, etc.) so pools cannot leak on setup errors.
- `SessionManager.getOrCreate()` disconnects the created FS if session construction throws after `buildFs()` returns.
- `SessionManager.destroy()` disconnects the FS in a `finally` block so the pool is always released even when `destroySandboxFn` or Redis cleanup throws.
- `publishVersionIfDirty()`: Redis `INCR` failure now surfaces as `ECOHERENCE` (HTTP 503), sets `publishPending` for retry on the next turn, and forces a reload via `lastSeenVersion = -1`. Previously the failure was silently swallowed.
- Distributed lock heartbeat replaced `setInterval(async)` with a sequential `setTimeout` chain to prevent overlapping Redis `EVAL` commands under slow Redis; renewal command is now bounded by `Promise.race`.
- Runtime semaphore waiters are now abort-aware: cancelled via `AbortSignal`, evicted on per-waiter timeout, and bounded by `MAX_PYTHON_QUEUE`/`MAX_JS_QUEUE`. Backpressure surfaces as `ERUNTIME_BUSY` (HTTP 503).
- Added `SessionManager.shutdown()` for graceful drain and FS disconnect of all live sessions.
- Added MCP session TTL (`MCP_SESSION_IDLE_MS`), cap (`MCP_SESSION_MAX`), idle sweeper, and `shutdownMcp()` to bound transport memory growth.
- Added `closeRedisClient()` with `quit()` + `disconnect()` fallback for clean Redis teardown on shutdown.
- Capped raw `PUT /files/*` body size and bulk `writeFiles` file count + total bytes to prevent OOM from unbounded upload buffering.
- Mapped `ECOHERENCE` and `ERUNTIME_BUSY` error codes to HTTP 503.

## [0.2.18] - 2026-05-09

### Fixed

- Connection leak: `SessionManager.destroy()` and the idle-session reaper now call `dialect.disconnect()` on the evicted session's `SqlFs`, releasing the Postgres connection pool back to the server. Previously, sandbox deletion left pools open indefinitely until process exit.
- Added `SqlFs.disconnect()` as a thin public wrapper over `dialect.disconnect()` to support clean teardown without exposing the dialect directly.

## [0.2.17] - 2026-05-07

### Added

- Synchronous blob pre-fetch on cold-start snapshot hit: when `REDIS_PATH_SNAPSHOT_ENABLED=true` and `REDIS_BLOB_CACHE_ENABLED=true`, `SqlFs.ready()` now issues a single Redis `mget` for all file-inode sha256s from the path snapshot before returning the session to the caller. This eliminates the race window where `readFile` calls during background prewarm each paid an individual Postgres round-trip. Background prewarm (`getBlobsForSandbox`) continues to fire as the Postgres fallback for blobs not yet in Redis.

## [0.2.16] - 2026-05-06

### Added

- Defense-in-depth security layer for just-bash execution: opt-in via `JUST_BASH_DEFENSE_IN_DEPTH=true`. When enabled, just-bash monkey-patches host globals (`setTimeout`, `eval`, `Function`, dynamic `import`) during `bash.exec` to prevent sandbox escape. All Postgres I/O chokepoints (`#withTx`, `#withReadTx`, `#withBareTx`, `getBlobNoTx`) are wrapped in `DefenseInDepthBox.runTrustedAsync` to keep DB access functional.
- `JUST_BASH_DEFENSE_AUDIT_MODE` env var (default `true`): controls whether violations throw (`false`) or are logged only (`true`). Recommended rollout: enable with audit mode on, watch for `defense_in_depth_violation` logs, then flip to enforce mode once clean.
- Structured violation logging: violations emit a JSON line `{ event: "defense_in_depth_violation", sandboxId, ... }` via `onViolation` callback for easy grep/alerting.

## [0.2.15] - 2026-05-02

### Fixed

- `SqlFs#openScriptTx`: attach `.catch(() => {})` to `#scriptTxPromise` immediately after creation to prevent an unhandled rejection crash (Node.js 15+) when the database connection is closed while the deferred transaction is open. Also switch `await txReady` to `await Promise.race([txReady, #scriptTxPromise])` so a connection failure before `resolveTxReady` fires propagates immediately rather than hanging forever.
- `SqlFs#withBareTx`: route through the already-open `#scriptTx` when `this.#scriptTx !== undefined`, preventing a deadlock that occurred in `appendFile` when `#withTx` (blob read) opened the script-tx and acquired `pg_advisory_xact_lock`, then the subsequent `#withBareTx` → `writeFileComposite` started a new transaction and immediately blocked on the same lock.

## [0.2.14] - 2026-05-02

### Performance

- `PostgresDialect`: fuse `setSandboxContextWithLock` into a single `SELECT` (saves 1 RTT on all non-composite write paths).
- `PostgresDialect`: add `writeFileComposite`, `mkdirComposite`, `rmComposite`, `mvComposite` — single-CTE methods that embed sandbox context setup + advisory lock + all operation queries, reducing each write transaction from 3–7 RTTs to 1.
- `SqlFs`: `writeFile`, `appendFile`, `mkdir` (non-recursive), `rm` (single), and `mv` now use composite CTEs when the dialect provides them via a new `#withBareTx` helper; fall back to the existing sequential path for MySQL/Azure SQL dialects.
- `SqlDialect` interface: four new optional composite method signatures (`writeFileComposite?`, `mkdirComposite?`, `rmComposite?`, `mvComposite?`) — backward-compatible, no changes required for existing dialect implementations.

### Tests

- Add `sql-fs.composite.test.ts`: 22 unit tests verifying composite paths call composite methods instead of sequential methods, skip `setSandboxContextWithLock`, and produce correct pathCache updates.

## [0.2.13] - 2026-05-01

### Added

- `scripts/benchmark_remote_bash.py`: end-to-end Remote Bash latency benchmark hitting the live HTTP API via the Python SDK. Runs in two phases — sandbox lifecycle (create / ingest / delete over N fresh sandboxes) and exec latency (find / grep / rg / write / delete / mkdir / mv cases on a warm sandbox). Reports wall-clock ms and server-side `duration_ms` (avg / p50 / p95 / max) as markdown tables. Supports both `sqlfs` and `daytona` providers via `--provider`, auto-detects writable home dir on Daytona, and sweeps leftover `bench-*` sandboxes on exit. Run with `pnpm bench:remote-bash`. See README for full instructions.

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
- Python SDK PyPI distribution name renamed from `sqlfs` to `sql-fs-sdk`.
- Fixed pre-existing mypy strict errors in `clients/python/src/sqlfs/_http.py` and `models.py`: typed `list`/`tuple` type arguments, cast `Literal` for `StreamEvent.type`.
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
- Rate-limit `clientIp()` no longer reads `X-Forwarded-For` / `X-Real-IP` by default — those headers are spoofable. Operators behind a trusted ingress that strips inbound forwarding headers must opt in via `TRUST_PROXY_HEADERS=true`. Otherwise the connecting socket's `remoteAddress` is used. See `plugins/sqlfs/skills/api/SETUP.md` for the full trust-proxy note.

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

- Migrated Claude Code skills from `commands/sql-fs-api.md` + `skills/sql-fs-api/` into the plugin layout under `.claude-plugin/` and `plugins/sqlfs/`.

## [0.1.0] - 2026-04-26

### Added

- Initial release of `sql-fs-api`: persistent filesystem backend + HTTP/MCP API for `just-bash` sandboxes.
- SQL-backed `IFileSystem` implementation (`SqlFs`) with Postgres, MySQL, and Azure SQL dialects.
- Adjacency-list directory model with content-addressable blob storage and global dedup.
- Path cache (eager) and content cache (lazy LRU, 50 MB/session) for low-latency reads.
- HTTP API (Hono): sandboxes CRUD, file operations, exec (sync + SSE), ingest/export, admin GC.
- MCP server with 10 tools over streamable HTTP transport.
- Bearer-token auth, RLS-based sandbox isolation, default-deny symlinks, error sanitization.
- Multi-tenant routing and session rehydration.
- Docker image and Azure Container Apps deployment config.

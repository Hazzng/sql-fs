# Changelog

All notable changes to the SQL-FS Python SDK are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-06-05

### Added

- `Client(max_file_size=...)` — a per-file size ceiling (default 64 MiB) enforced
  client-side on every write path (`ingest_files`, `fs.write`, `fs.write_files`)
  **before** any content is base64-encoded or sent. Oversized files raise
  `ValidationError(code="EFILE_TOO_LARGE")` (with `status=None`) naming each
  offending path and size. Set `max_file_size=0` to disable. The limit is threaded
  to every `Sandbox` the client creates or attaches.

## [0.2.5] - 2026-05-27

### Changed

- Package renamed from `virtualfs-sdk` to `sql-fs-sdk` following project rebrand.
- Top-level import module renamed from `virtualfs` to `sqlfs` (`from sqlfs import Client, Sandbox`).
- `VirtualFSError` base exception class renamed to `SQLFSError`.

---

## [0.2.4] - 2026-05-17

### Fixed

- `exec()` and `exec_batch()` no longer silently retry write scripts on 5xx responses. Before this fix, `Transport.request()` retried `{429, 500, 502, 503, 504}` unconditionally, which could re-execute a write whose Postgres mutation had already committed (`ECOHERENCE` → 503), double-applying side effects.

### Added

- `retry_on_5xx: bool = False` parameter on `exec()` and `exec_batch()`. Opt in only when every script in the call is idempotent (e.g. `mkdir -p`, deterministic `echo > file`).
- `read_only=True` execs continue to be retried automatically — no opt-in needed (reads cannot commit state).
- `503 ECOHERENCE` is never retried on write execs even when `retry_on_5xx=True`: the write committed; only the Redis cache-invalidation publish failed.

---

## [0.2.3] - 2026-05-17

### Added

- `per_script_timeout_ms` parameter on `exec_batch()` — optional per-script timeout budget (ms). When set, each script gets its own independent deadline instead of sharing the global `timeout_ms`. The outer `timeout_ms` still acts as an absolute ceiling. Recommended for capability probes where a slow first script would otherwise exhaust the shared budget and silently turn later scripts into false negatives.

---

## [0.2.2] - 2026-05-16

### Added

- `network` parameter on `Sandbox.create()` — enables outbound internet access for the sandbox.

---

## [0.2.1] - 2026-05-16

### Added

- `py-exec` is now the recommended way to run Python on `python=True` sandboxes. The server registers a warm interpreter per session so the ~1.4 s WASM cold-boot cost is paid at most once; subsequent `py-exec` calls run in < 5 ms. Use `python3` only when per-call state isolation is required.

---

## [0.2.0] - 2026-05-16

### Added

- `read_only` parameter on `exec()`, `exec_batch()`, and `exec_stream()` — passes `readOnly: true` to the server, skipping the exclusive sandbox lock for parallel read concurrency. Any mutating filesystem op raises `ValidationError(code="EREADONLY_VIOLATION")`.

### Fixed

- HTTP 422 responses now correctly raise `ValidationError` (was falling through to base `SQLFSError`).

### Removed

- `ingest_archive()` — the `POST /ingest` tar.gz multipart route has been removed from the server. Use `ingest_files()` for all ingestion.
- `export()` and `export_stream()` — the `GET /export` tar.gz download route has been removed. Use `sb.exec("tar -czf - <root> | base64")` and decode client-side.

## [0.1.0] - 2026-04-30

### Added

- `Client` — synchronous HTTP client wrapping all SQL-FS API endpoints; supports
  token-based auth, `auth_secret`/`sub` bootstrap, and `admin_secret` bootstrap.
- `SandboxHandle` — fluent handle returned by `client.sandboxes.create()` / `.attach()` / `.get()`;
  exposes `.fs`, `.exec()`, `.exec_batch()`, `.exec_stream()`, `.ingest_files()`, `.export()`.
- `FsHandle` — file-system operations: `read`, `write`, `write_files`, `delete`, `mkdir`, `tree`.
- `ExecResult` / `ExecStreamEvent` — typed result objects for sync and streaming execution.
- Typed error hierarchy: `VirtualFsError`, `NotFoundError`, `ConflictError`, `AuthError`,
  `ValidationError`, `RateLimitError`, `ExecTimeoutError`.
- Automatic retry with exponential back-off on transient 5xx and network errors
  (configurable via `max_retries`).
- SSE streaming for `exec_stream()` with per-event typed parsing.
- `ingest_files()` with base64 encoding of binary payloads.
- `export()` returning raw `bytes` (tar.gz).
- Full unit test suite using `respx` mock transport — no network required.
- `examples/quickstart.py` and `examples/perf_benchmark.py`.

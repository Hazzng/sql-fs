# Changelog

All notable changes to the VirtualFS Python SDK are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-04-30

### Added

- `Client` — synchronous HTTP client wrapping all VirtualFS API endpoints; supports
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

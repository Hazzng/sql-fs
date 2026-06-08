# Changelog

All notable changes to the TypeScript SDK are documented here.

## [0.4.0] - 2026-06-08

### Changed

- **Breaking:** replaced the boolean `python` create option with the
  `python_runtime` enum (`"stdlib" | "pyodide" | null`). `SandboxRecord.python`
  is now `SandboxRecord.python_runtime`. Migrate `python: true` →
  `python_runtime: "stdlib"` and `python: false` → omit (or `null`).

### Added

- `SandboxRecord.network` is now surfaced (previously server-only).
- Exported the `PythonRuntime` type.

## [0.3.1] - 2026-06-08

### Added

- `ingestFiles(..., { allowOversized })` — rejects files larger than 8 MiB with
  `ValidationError` (code `EFILE_TOO_LARGE_FOR_CPYTHON`) before anything is sent.
  The `python3` runtime (CPython WASM) reads sandbox files through an 8 MiB IPC
  bridge, so `open()` fails on larger files. Pass `allowOversized: true` to
  ingest anyway (the bytes stay usable from bash and `js-exec`; only `python3
  open()` can't read them), or split the file into <8 MiB chunks.

## [0.3.0] - 2026-06-05

### Added

- Initial public release of the TypeScript SDK
- `Client` for authentication and sandbox CRUD
- `Sandbox` helpers for sync, batch, and streaming exec
- File read/write, bulk write, mkdir, tree, delete, and base64 ingest operations
- Client-side `maxFileSize` guard
- Idempotency-aware retries and typed API errors
- Full TypeScript types and ESM-only distribution

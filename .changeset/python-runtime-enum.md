---
"sql-fs-api": major
---

**Breaking:** replace the boolean `python` sandbox capability with a nullable `python_runtime` enum (`"stdlib" | "pyodide" | null`) across the HTTP API, MCP tools, OpenAPI spec, and both SDKs.

- `POST /v1/sandboxes` now accepts `python_runtime` instead of `python`; the legacy `python` key is rejected with `400 INVALID_INPUT`. Create/get/list responses echo `python_runtime` (and now consistently include `network`).
- MCP `sandbox_create` takes `python_runtime` and `sandbox_list` echoes it.
- TypeScript SDK (`SandboxRecord`, `CreateSandboxOptions`) and Python SDK (`SandboxRecord`, `client.create(...)`) use `python_runtime`; both `SandboxRecord` types now also expose `network`.

`python_runtime: "stdlib"` is the air-gapped CPython-WASM runtime (the previous `python: true`). `python_runtime: "pyodide"` adds a numpy/pandas/scipy/openpyxl runtime in an OS-isolated Deno subprocess. The DB layer migrates rolling-deploy-safe (migration 0006 dual-writes/back-reads the legacy column).

Clients must migrate `python: true` → `python_runtime: "stdlib"` and `python: false` → omit (or `null`).

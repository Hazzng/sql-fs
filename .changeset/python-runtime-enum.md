---
"sql-fs-api": major
---

**Breaking:** replace the boolean `python` sandbox capability with a nullable `python_runtime` enum (`"stdlib" | "pyodide" | null`) across the HTTP API, MCP tools, OpenAPI spec, and both SDKs.

- `POST /v1/sandboxes` now accepts `python_runtime` instead of `python`; the legacy `python` key is rejected with `400 INVALID_INPUT`. Create/get/list responses echo `python_runtime` (and now consistently include `network`).
- MCP `sandbox_create` takes `python_runtime` and `sandbox_list` echoes it.
- TypeScript SDK (`SandboxRecord`, `CreateSandboxOptions`) and Python SDK (`SandboxRecord`, `client.create(...)`) use `python_runtime`; both `SandboxRecord` types now also expose `network`.

`python_runtime: "stdlib"` is the air-gapped CPython-WASM runtime (the previous `python: true`). `python_runtime: "pyodide"` adds a numpy/pandas/scipy/openpyxl runtime in an OS-isolated Deno subprocess. The DB layer migrates rolling-deploy-safe (migration 0006 dual-writes/back-reads the legacy column).

Clients must migrate `python: true` → `python_runtime: "stdlib"` and `python: false` → omit (or `null`).

**Pyodide runtime memory & throughput tuning** (part of the same unreleased feature):

- Cut combined runtime memory ~1.6 GB → ~1.1 GB on an 18.8 MB-CSV workload: O(n) chunk-list IPC framing (replaces an O(n²) per-chunk reallocation on both the Deno runner and the Node manager), and a streamed SHA-256 diff baseline (replaces holding every staged file's bytes for the whole run).
- Lazy, offline package loading: only `PYODIDE_PRELOAD_PACKAGES` (default `numpy,pandas`) is resident at init; other distribution packages load on first import from the local lock. Lowers the idle floor and lets operators trade latency against RSS.
- `matplotlib` now defaults to the headless `Agg` backend so `savefig()` works in the Deno child (previously failed resolving the DOM `webagg` backend).
- New env vars `PYODIDE_PRELOAD_PACKAGES` and `PYODIDE_MAX_CHILD_RSS_BYTES` (optional RSS-based child retirement).
- Raised the default IPC frame/aggregate caps (192 MiB / 256 MiB) so a monolithic drain response carrying the full `PYODIDE_MAX_TOTAL_BYTES` (128 MiB, base64-expanded) is reachable instead of being killed at the old 64 MiB frame cap, and wired the previously-documented-but-unused `PYODIDE_MAX_FRAME_BYTES` / `PYODIDE_MAX_AGGREGATE_BYTES` env overrides.

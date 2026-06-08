# Task — Pyodide Python runtime for in-sandbox data analysis

Add an opt-in Pyodide-backed Python runtime to sql-fs so sandboxed code can `import numpy`, `pandas`, `scipy`, and `openpyxl` entirely in WASM, preserving the air-gapped, no-host-process security posture. This replaces the existing boolean `python` capability flag with a `python_runtime: "stdlib" | "pyodide" | null` field that spans the API, both SDKs, the MCP tool, the OpenAPI spec, and a DB migration — a breaking, major-version change. The driving use case is AI agents analysing user-uploaded CSV/Excel files behind a self-hosted LibreChat deployment, which additionally requires that **output files written by the script are drained back to SqlFs and retrievable**, not just input loading.

Source: [Hazzng/sql-fs#118](https://github.com/Hazzng/sql-fs/issues/118) (issue body + the maintainer's accepted implementation analysis in the first comment).

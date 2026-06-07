---
"sql-fs-api": patch
---

SDK: guard `ingest_files`/`ingestFiles` against files larger than 8 MiB that the `python3` runtime (CPython WASM) cannot `open()`. Oversized files now raise `ValidationError` (code `EFILE_TOO_LARGE_FOR_CPYTHON`) before anything is sent; pass `allow_oversized=True` (Python) / `allowOversized: true` (TS) to ingest anyway — the bytes stay usable from bash and `js-exec`, only `python3 open()` can't read them. Split into <8 MiB chunks to read large files from `python3`.

---
"sql-fs-api": minor
---

Add `paths` param to `fs_ingest` MCP tool. Pass `{ relativePath: absoluteHostPath }` and the server reads bytes directly from the host filesystem — no base64 encoding, no file content generated as output tokens. Matches py-sdk `ingest_files()` performance. `files` (inline base64) is kept for small generated content but is now the exception path.

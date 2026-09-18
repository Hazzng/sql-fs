---
"sql-fs-api": minor
---

Add file access to MCP — `file_read`, `file_write`, `file_edit` — plus `PATCH /v1/sandboxes/:id/files/*path` for exact-string edits.

MCP previously had no file tools at all, so agents had to reach every file through `bash_exec`: `cat` to read, heredocs to write, `sed -i` to edit. That means shell quoting for every path and payload, unbounded output on a large read, and — worst — `sed` silently patching the wrong line when the pattern is not unique.

`file_edit` (and the matching `PATCH` route) replaces an exact string. `oldString` must match once unless `replaceAll` is true; an ambiguous match is rejected with `EDIT_NOT_UNIQUE` rather than applied to an arbitrary occurrence, so an agent working from a stale read cannot patch the wrong place. Rejections leave the file byte-identical, non-UTF-8 files are refused instead of being corrupted by lossy decoding, and an accepted edit preserves everything it did not match — the file's mode and a leading UTF-8 BOM included. On transaction-capable backends (Postgres) the read-modify-write runs in one script-tx scope, so a concurrent reader never observes the file mid-edit; backends without script-tx (in-memory) apply it directly. An edit whose result would exceed the write limit is refused from the projected size, before the new content is built. Editing this way moves ~1800x fewer bytes than read-modify-rewrite on a 128 KB source file, and keeps the file out of an agent's context window twice over.

`file_read` returns structured content with size and line count, takes `offset`/`limit` to page a large file, refuses non-UTF-8 (`NOT_TEXT`), and bounds both the file it will open (`MAX_MCP_READ_FILE_BYTES`, 16 MB) and the bytes it returns (`MAX_MCP_READ_RESPONSE_BYTES`, 1 MB). `file_write` writes a whole file, creating parent directories, and refuses to clobber a directory on every backend rather than depending on the filesystem to catch it.

HTTP and MCP share one implementation in `src/api/lib/file-ops.ts` — the edit contract, parent-directory creation and the write cap — so the two surfaces cannot drift on what an edit means. Whole-file writes stay per-surface. The route is documented in the OpenAPI spec.

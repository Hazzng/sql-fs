---
"sql-fs-api": patch
---

Size a `file_read` page against the reply the transport actually sends, and stop splitting the whole file to count its lines.

The budget measured the JSON the tool builds, but that string is serialized a second time inside the MCP JSON-RPC result, which re-escapes every backslash the first pass added. Content that escapes badly paid that twice: a page of NUL bytes trimmed to the 1 MiB cap left as 1,223,335 bytes on the wire, 170 KiB over. The page is now sized on the embedded form, so the cap describes what is sent.

`file_read` also called `split("\n")` on the whole file to count lines and take a page, allocating one array slot per line — about 16 million of them for a newline-heavy file at the 16 MiB read limit, for a reply capped at 1 MiB. Lines are counted and located by scanning instead, so only the requested range is materialized.

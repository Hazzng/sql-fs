---
"sql-fs-api": patch
---

Enforce the file-write limit on `PUT /v1/sandboxes/:id/files/*path` as the body streams, instead of trusting `Content-Length`.

The route read the declared length, then buffered the whole body with `arrayBuffer()` and checked its size after the fact. A chunked upload carries no `Content-Length` at all and an under-declared one is free to lie, so either could be buffered up to the global 256 MB backstop — four times the route's own cap — before being rejected. The cap is now counted off the stream, which aborts the request at the limit. A declared length only ever shortens the work — a request claiming more than the cap is refused unread — but it is never taken as proof of what the body actually carries. An upload cut off at the cap cancels the incoming stream rather than leaving it open with nobody draining it. Oversized uploads still get the same 413 `PAYLOAD_TOO_LARGE` response.

---
"sql-fs-api": patch
---

Budget the whole `file_read` reply against `MAX_MCP_READ_RESPONSE_BYTES`, and normalize the path MCP tools echo back.

The cap was applied to the content string alone, so the JSON envelope, the metadata and the echoed `path` were all added on top of a content page that had already filled it — a plain read came back 128 bytes over the limit. `toAbsolute` also only prefixed a slash rather than normalizing, and the backends resolve `..` themselves, so a caller could read `/f.txt` through a 250 KB path of redundant components and have every byte of it echoed back in the reply.

Content is now sized against what is left after the envelope, paths are normalized before use, and the path argument is bounded at `PATH_MAX`. The read-cap tests assert the serialized reply rather than the content length, which is what the cap was always meant to describe.

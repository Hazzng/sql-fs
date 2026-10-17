---
"sql-fs-api": patch
---

Add `SQL_FS_MAX_INGRESS_WAIT_MS`, the time a request or MCP listener waits for ingress capacity before it gets a 503 `EWORKER_BUSY`. The default stays 250 ms, the previous fixed value. An invalid value stops startup.

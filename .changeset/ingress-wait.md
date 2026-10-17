---
"sql-fs-api": patch
---

Add `SQL_FS_MAX_INGRESS_WAIT_MS`, the time a request or MCP listener waits for ingress capacity before it gets a 503 `EWORKER_BUSY`. The default stays 250 ms, the previous fixed value. Like the other ingress settings, an empty value uses the default. With workers on, any other invalid value, including a wait above 2147483647 ms, stops startup. `SQL_FS_WORKER_QUEUE_WAIT_MS` now rejects values above 2147483647 ms too, because Node would run such a timer after 1 ms.

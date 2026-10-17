---
"sql-fs-api": patch
---

Add `SQL_FS_MAX_INGRESS_WAIT_MS`, the time a request or MCP listener waits for ingress capacity before it gets a 503 `EWORKER_BUSY`. The default ingress wait rises from 250 ms to 1000 ms, so one replica can absorb a short burst instead of refusing it. `SQL_FS_WORKER_QUEUE_WAIT_MS` keeps its 250 ms default. An invalid value stops startup.

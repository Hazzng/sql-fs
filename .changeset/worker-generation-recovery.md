---
"sql-fs-api": patch
---

Keep reservations local to each worker pool so nested operations in separate pools cannot bypass admission or share request outcomes. Keep the captured worker identity and generation during asynchronous recovery so retired-worker cleanup preserves replacement residency. Centralize request outcome history and generation retirement in worker ownership without replaying unknown executions.

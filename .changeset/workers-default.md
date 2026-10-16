---
"sql-fs-api": minor
---

Run scripts in worker threads by default. Set `SQL_FS_WORKERS_ENABLED=false` to keep inline mode. Any value other than `true` or `false` now stops startup.

Inline mode now caps exec output at `SQL_FS_WORKER_OUTPUT_BYTES` (default 64 MiB), down from 256 MiB, so both modes share one limit. The default `SQL_FS_WORKER_MESSAGE_BYTES` is now the output cap plus 1 MiB, and an explicit value still wins.

A rolling deploy that mixes this version with older replicas must meet the worker rollout prerequisites in docs/CONFIGURATION.md first.

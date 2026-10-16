---
"sql-fs-api": minor
---

Run scripts in worker threads by default. Set `SQL_FS_WORKERS_ENABLED=false` to keep inline mode. Any value other than `true` or `false` now stops startup.

Inline mode now caps exec output at `SQL_FS_WORKER_OUTPUT_BYTES` (default 64 MiB), down from 256 MiB, so both modes share one limit. The default `SQL_FS_WORKER_MESSAGE_BYTES` grows with the output cap: 65 MiB, or the output cap plus 1 MiB if that is larger. An explicit value still wins.

To upgrade replicas that run with workers off, deploy with `SQL_FS_WORKERS_ENABLED=false` first, then remove the setting once no older replica remains. docs/CONFIGURATION.md describes the two-stage rollout.

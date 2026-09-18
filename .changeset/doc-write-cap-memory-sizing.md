---
"sql-fs-api": patch
---

Record the container sizing the single-file write cap implies.

Load testing on Linux measured a write costing roughly 7x the file size over baseline, held in `external` rather than the V8 heap — so `--max-old-space-size` does not bound it and the cgroup OOM-kills the process instead. At the 50 MiB default a single legal write requires a 768 MiB container; 512 MiB is killed by one request.

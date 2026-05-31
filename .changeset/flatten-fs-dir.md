---
"sql-fs-api": patch
---

Flatten `src/fs/sql-fs/` to `src/sql-fs/`. The intermediate `fs/` directory had no purpose — `sql-fs` was its only child. No behaviour change.

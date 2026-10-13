---
"sql-fs-api": patch
---

Preserve the original execution or commit error when script-scope rollback also fails, including explicit worker scope completion. Share scope completion across local execution, worker adapters, and file writes while keeping nested scope ownership and lease checks before commit.

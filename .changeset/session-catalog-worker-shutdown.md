---
"sql-fs-api": patch
---

Keep session lifetime, tenant storage, and runtime admission under separate state owners. Reject and disconnect a worker session if shutdown begins while its initial attachment is pending.

---
"sql-fs-api": patch
---

Write a whole file through one shared, transactional path on both the MCP `file_write` tool and `PUT /v1/sandboxes/:id/files/*`.

Each surface spelled the write out for itself — `ensureParentDir` then `writeFile`, outside any scope — which on a SQL backend is two independent transactions: a failed write left the directories it created behind, and a lease lost between them committed anyway while the caller was told the write had not happened and should be retried. The two copies had also drifted: MCP refused a write over a directory, `PUT` did not, so the same request silently clobbered a directory on the in-memory backend and raised `EISDIR` on Postgres.

Both now call `writeFileAtPath`, which owns its script-tx scope the way `editFile` already does, so parents and file commit together, a lost lease rolls the whole write back, and `PUT` answers a directory target with `400 EISDIR` like the MCP tool.

---
"sql-fs-api": patch
---

Fence stale sandbox writers with durable epochs (F2-L2).

A writer whose distributed lease lapsed before its first write could commit over a live writer's changes: it based its mutation on a stale in-memory pathCache entry while the content-addressed blob read missed the newer commit. `sandboxes.version` is now the fencing token — script scopes pin it under the advisory lock and every composite mutation (`writeFile`, `mkdir`, `rm`, `mv`) conditionally advances it, so a stale scope's commit fails with `ESTALE` instead of silently winning. Sandbox deletion persists a tombstone epoch so ID reuse cannot reset the fence.

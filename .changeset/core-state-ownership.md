---
"sql-fs-api": patch
---

Modularize filesystem, PostgreSQL, session, and worker behavior around state owners. Preserve primary execution and commit errors when rollback fails, and reject worker sessions attached after shutdown begins.

Keep reservations and recovery tied to their worker pool and captured generation, preserving replacement residency. Treat post-exec coherence failures as unknown outcomes and retire the affected worker without replaying execution.

Reject pending blob writes across script-scope transitions and cache reads from condemned scopes. Preserve both aliases when renaming between hard links to the same inode, reject file/directory rename mismatches, and report EISDIR when ingest targets the root directory.

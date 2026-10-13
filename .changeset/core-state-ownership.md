---
"sql-fs-api": patch
---

Modularize filesystem, PostgreSQL, session, and worker behavior around state owners. Preserve primary execution and commit errors when rollback fails, and reject worker sessions attached after shutdown begins.

Keep reservations and recovery tied to their worker pool and captured generation, preserving replacement residency. Treat post-exec coherence failures as unknown outcomes because writes may already have applied. Retire the affected worker without replaying execution; callers must inspect sandbox state and reconcile external effects before retrying.

Reject pending blob writes across script-scope transitions and cache reads from condemned scopes. Preserve both aliases when renaming between hard links to the same inode, reject file/directory rename mismatches, and report EISDIR when ingest targets the root directory.

Enable symbolic links by default, retaining `allowSymlinks: false` for callers that explicitly disable them and bounded cycle resolution. Resolve relative link targets from their containing directory in PostgreSQL, cap total traversal at 40 links, and include target strings in session metadata-cache estimates.

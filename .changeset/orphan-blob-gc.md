---
"sql-fs-api": minor
---

feat(gc): multi-tenant orphan-blob garbage collection via `pnpm db:gc`.

Restores the `pnpm db:gc` CLI as a real, multi-tenant orphan-blob sweep for an external scheduler (cron / k8s CronJob). Orphan blobs (rows in `blobs` referenced by zero `inodes`) previously accumulated forever.

- New migration `0006` adds `blobs.last_referenced_at` (instant, catalog-only — legacy rows stay NULL and are treated as ancient/collectible). Every blob reference (insert + dedup re-adoption) now bumps it via `ON CONFLICT (sha256) DO UPDATE`; that row lock serializes a re-adopting writer against GC's `DELETE`, closing the dedup re-adoption race (silent content loss).
- `gcOrphanBlobs` rewritten to a null-safe `NOT EXISTS` anti-join with a grace window (`minAgeMs`), returning the deleted sha256s. It runs with no sandbox context (RLS escape) so the anti-join sees every inode; a blob referenced by another sandbox survives.
- Deleted blobs are purged from the tenant-scoped Redis blob cache (`RedisBlobCache.mdel`, fail-open).
- New env `BLOB_GC_MIN_AGE_MS` (default 3h) sets the grace window; `pnpm db:gc -- --min-age-ms 0` collects all orphans now, `--tenant <id>` restricts to one tenant.

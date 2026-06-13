---
"sql-fs-api": minor
---

fix(blob): commit the CAS blob upsert in its own short, self-committing
transaction (own connection, no advisory lock) BEFORE the inode/dirent composite,
and run the composite without its `blob_insert` CTE. This removes hot-blob
contention (F6): previously the `ON CONFLICT (sha256) DO UPDATE SET
last_referenced_at = now()` tuple lock on a deduplicated hot blob (empty file,
`.gitkeep`, common lockfiles) was held for the whole script, serializing
unrelated sandboxes within one tenant DB and risking pool-exhaustion → 503. The
touch stays unconditional so the GC grace window protects the freshly-committed
blob until its inode commits; the blob-gc REPEATABLE READ + 40001 re-adoption
handshake is preserved. Applies to `writeFile`, `appendFile`, and `bulkIngest`.

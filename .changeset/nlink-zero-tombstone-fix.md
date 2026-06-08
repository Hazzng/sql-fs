---
"sql-fs-api": patch
---

fix(fs): delete inodes when their link count reaches zero (no `nlink=0` tombstones).

The Postgres `rmComposite`, `writeFileComposite`, and `mvComposite` paths decremented an inode's `nlink` and deleted it (when it hit 0) within a single CTE statement. Postgres applies **only the UPDATE** when a row is both updated and deleted in one statement, so the inode was left at `nlink=0` instead of being removed — a tombstone that still referenced `content_sha256`. This pinned the blob (defeating the new orphan-blob GC, whose anti-join saw the tombstone) and leaked inode rows on every file delete, overwrite, and move-overwrite.

Each path now splits the work into two mutually-exclusive branches against the statement snapshot — delete when `nlink <= 1`, decrement when `nlink > 1` — so each inode row is touched exactly once. `gcOrphanBlobs` additionally ignores `nlink = 0` inodes so blobs pinned by tombstones left behind by older builds become collectible. Hardlinked inodes are unaffected (still decremented, not deleted, while other links remain).

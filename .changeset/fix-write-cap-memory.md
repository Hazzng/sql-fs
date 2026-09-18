---
"sql-fs-api": patch
---

Default the single-file write limit to the contentCache cap (50 MiB) instead of 64 MiB.

The two are coupled by a memory cliff rather than by preference: a file the LRU accepts is retained once, while one it rejects is retained twice over, and again per pool connection that read it. Load testing measured the break exactly at the cache cap — 50 MiB costs 50 MB of live memory, 51 MiB costs 102 MB — so the 64 MiB default meant one large read pinned 256 MB per warm session for the full `SESSION_IDLE_MS`. Raising `MAX_FILE_WRITE_BYTES` past the cache cap is still possible, and now buys larger writes at roughly four times the memory each.

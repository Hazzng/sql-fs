---
"sql-fs-api": minor
---

fix(cache): writeFile now evicts the displaced inode's contentCache entry on overwrite (including empty-file overwrite), preventing orphaned LRU weight (F9a, #138).

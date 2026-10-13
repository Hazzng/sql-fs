---
"sql-fs-api": patch
---

Report post-exec coherence failures as unknown outcomes when the script may have committed, and retire the affected worker before another request uses it.

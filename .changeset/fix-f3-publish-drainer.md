---
"sql-fs-api": minor
---

Heal stranded cross-replica version publishes after a Redis INCR failure (F3): a background drainer and reap-time best-effort publish flush the bump even if no further client traffic arrives or the session is idle-evicted.

---
"sql-fs-api": minor
---

perf(cache): O(1) pathCache byte accounting to avoid full-map scans (F9e, #142)

SqlFs now maintains an incremental `#pathCacheBytes` counter, adjusted on
every pathCache set/delete and reset on `reload()`/`ready()`, and exposes
`getPathCacheBytes()`. SessionManager's path-cache memory budget calls it
instead of re-walking the entire pathCache (`Σ path.length + 100`) on every
dirty exec. The value equals the previous full-walk exactly. Falls back to
the full walk for backends that do not expose the counter.

The `#childrenByParent` children index (part B of #142) is deferred to a
follow-up; it is benchmark-gated and (A) delivers the higher-value, lower-risk
win without touching readdir correctness.

---
"sql-fs-api": patch
---

Update the ACA deployment example with early HTTP concurrency scaling, bounded five-second queues, faster readiness probes, a drain grace period and an immutable image reference. Keep blob caching off in the example so control Redis does not also carry blob traffic.

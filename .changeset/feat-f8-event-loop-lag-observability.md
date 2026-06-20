---
"sql-fs-api": minor
---

feat(observability): event-loop lag monitoring for the Redis leases (F8).

The exec-lock writer lease, the RW-lock writer flag, and the RW-lock reader ZSET
scores are all kept alive by `setTimeout` heartbeats that silently assume timers
fire on schedule. A long event-loop stall (a V8 GC pause or a pathological
synchronous bash stretch) can fire a renewal past the lease, voiding it — Lock 3
keeps Postgres consistent, so this was always an observability gap, not a
correctness bug, but nothing measured it.

New `src/api/event-loop-monitor.ts` (purely observational, no behavior change):

- A `perf_hooks.monitorEventLoopDelay` histogram started at boot, sampled every
  `EVENT_LOOP_MONITOR_INTERVAL_MS` (default 10s) and logged as
  `event:"event_loop_lag"` (`p50Ms`/`p99Ms`/`maxMs`/`meanMs`), then reset.
- Per-heartbeat gap measurement wired into all three lease sites: each heartbeat
  reports actual-minus-expected fire time as `event:"heartbeat_gap"` at
  `severity:"warn"` (gap > renewMs) or `"critical"` (gap > leaseMs), tagged with
  the lock kind (`exec`/`rw-writer`/`rw-reader`) and key.

Alert thresholds are documented in DEVELOPER.md ("Lock observability"). End-to-end
smoke tests reproduce a >lease stall on each lease and assert the critical
heartbeat_gap fires (with a no-stall control proving no false positives).

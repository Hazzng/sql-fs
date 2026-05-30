---
"sql-fs-api": patch
---

Support just-bash 3.0.x (bump `just-bash` to `^3.0.1`).

just-bash 3.0.x's `DefenseInDepthBox` now freezes `Error.stackTraceLimit`
(`writable: false`) on the host realm for the duration of every `bash.exec()`
— defense-in-depth defaults to on, so this applies even when callers don't opt
in. On 2.14.x the same hardening was scoped to worker threads and never took
effect on the host. The `postgres` driver assigns to `Error.stackTraceLimit`
inside `cachedError()` on every query, so any Postgres I/O issued from inside an
exec threw `TypeError: Cannot assign to read only property 'stackTraceLimit'`,
breaking all reads/writes through the Postgres backend.

`PostgresDialect` now re-arms `Error.stackTraceLimit` writability immediately
before each query via the shared `db()` accessor. The box only re-applies its
patches on the refCount `0 → 1` transition and our own exec holds refCount ≥ 1
for its whole duration, so the restored writability is stable for the rest of
the exec; just-bash restores the original descriptor on deactivation, so the
host global is not permanently weakened.

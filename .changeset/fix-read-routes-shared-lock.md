---
"sql-fs-api": patch
---

Make `GET /v1/sandboxes/:id/files/*` and `GET /v1/sandboxes/:id/tree` take the **shared** session lock instead of the exclusive write lock, so concurrent reads of one sandbox run in parallel.

Both handlers went through `withOwnedSessionOrRehydrate`, which takes the exclusive distributed exec lock and the per-session RWLock in exclusive mode — so two simultaneous GETs on the same sandbox serialized against each other exactly as if each were a write. This was chronology, not a safety decision: the handlers date from `ffa3fe8` (2026-04-25) and `withOwnedSessionRead` did not exist until `34228c1` (2026-05-10), which wired the shared path into `exec.ts` and `mcp/tools.ts` only. MCP `file_read` does byte-for-byte the same `stat` + `readFileBuffer` work on the shared path, so the same read had two lock modes depending on which door the caller used. `ensureFreshCache` was already called identically on both paths.

**What this does not buy, stated plainly: a GET still waits behind an in-flight writer.** A shared reader excludes an exclusive writer — that is what an RW lock is for — and the shared path is, if anything, marginally slower on that route (the issue measured 13 ms slower against one in-flight 5 s writer; a 3 s exec on the load-test harness still blocked `GET /files` for 2764 ms and `GET /tree` for 2723 ms after this change). Anyone expecting this to fix "my GET was blocked for seconds by somebody's exec" will be disappointed; that belongs to the exec-disconnect and acquire-timeout work.

**What it does buy is reader-reader parallelism, and the effect is large.** Measured on the two-replica harness against one warm sandbox, three runs each, wall time for a burst of N concurrent requests:

| | before | after |
|---|---|---|
| `GET /files` C=12 | 131 / 98 / 100 ms | 6 / 6 / 7 ms |
| `GET /files` C=32 | 148 / 183 / 144 ms | 9 / 8 / 7 ms |
| `GET /tree` C=12 | 119 / 103 / 128 ms | 4 / 2 / 3 ms |
| `GET /tree` C=32 | 160 / 166 / 143 ms | 5 / 5 / 5 ms |

C=1 is unchanged (~2 ms), as it must be. There is a second-order win too: an in-flight GET no longer raises the *writer* flag, which under writer-priority also held off queued readers and made a real writer wait for a drain cycle.

Safety is unchanged rather than traded away. Writers and readers stay mutually exclusive; the per-session RWLock is writer-priority, so a stream of GETs cannot starve an exec; and the read-only FS scope only rejects the 11 mutating methods, none of which these handlers call. Atomicity of a read against a concurrent multi-file write comes from RW-lock exclusion plus the script-tx, both of which the shared path keeps — the harness's `concurrency.mjs` still reports zero torn reads and all checks passing.

One pre-existing wart is now reachable from two more routes and is worth a follow-up rather than a blocker: `ensureFreshCache` runs *outside* the in-process lock on both paths, so on the shared path reader B can `reload()` while reader A is mid-`stat` and swap the pathCache under it. That needs the Redis version GET to move or throw, and yields a consistent-but-newer snapshot rather than corruption. It already ships on every MCP read tool and every `readOnly` exec; this widens exposure, it does not introduce it.

Verified by five unit tests that all fail against the previous code (two assert the routes reach `SessionManager.withSessionRead` and never `withSessionOrRehydrate`; two assert two concurrent GETs are inside the session lock simultaneously; one pins the limitation above — a shared reader still serializes behind an exclusive writer). Not verified: the cross-replica shared-lock path — the measurements above are single-replica bursts against replica A, so distributed `ACQUIRE_SHARED` fan-in under multi-replica read load is untested here. Nor is the reader-vs-reader cache-swap window reproduced; it is reasoned from the code, not observed.

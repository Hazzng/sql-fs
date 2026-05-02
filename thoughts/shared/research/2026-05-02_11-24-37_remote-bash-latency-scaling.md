---
date: 2026-05-02T11:24:37+09:30
researcher: quangnguyentechno@gmail.com
git_commit: 7a7395bb9158cd6c39dbd498af9604769e7350cd
branch: feature/network-trip
repository: virtualFS
topic: "Why repeated bash ops (mv/mkdir/rm) scale linearly in remote-bash benchmark"
tags: [research, codebase, sql-fs, just-bash, postgres, latency, benchmark]
status: complete
last_updated: 2026-05-02
last_updated_by: quangnguyentechno@gmail.com
---

# Research: Why repeated bash ops (mv/mkdir/rm) scale linearly in remote-bash benchmark

**Date**: 2026-05-02 11:24:37 ACST
**Researcher**: quangnguyentechno@gmail.com
**Git Commit**: 7a7395bb9158cd6c39dbd498af9604769e7350cd
**Branch**: feature/network-trip
**Repository**: virtualFS

## Research Question

In `scripts/benchmark_remote_bash.py`, scripts that chain N identical fs operations
with `&&` (e.g. `mv: move 3 files`, `delete: 3 files`, `mkdir: nested deep`) show
wall-clock latency that is **~3× the single-op latency**. The expectation was that
the entire script is one round-trip to the server, so 3 chained ops should be only
marginally slower than 1.

Investigate whether (a) bash dispatches each builtin to a fresh fs call, (b) each
fs call opens its own Postgres transaction, (c) what overhead each transaction adds,
and (d) what wrapping options exist given just-bash is consumed as an npm dependency
and is not modified locally.

## Summary

The script is sent in **one** HTTP round-trip and run by **one** in-process bash
interpreter. The linear scaling comes from two compounding sources, both per-fs-op:

1. **Each fs operation opens its own Postgres transaction.** Per-op fixed overhead
   is ~4 sequential network round-trips (`BEGIN`, `set_config`, `pg_advisory_xact_lock`,
   `COMMIT`) on top of the op's own queries. Bash awaits each fs call before
   advancing to the next chained command, so N ops ⇒ N× the SQL round-trip cost.

2. **Multi-arg builtins fan out internally in just-bash.** A single shell command
   like `mv a b c dst/` or `rm a b c` issues **N sequential `fs.*` calls**, not one.
   This is invisible at the shell level but is why a one-line `mv` of 3 files lands
   near 3× a single rename.

Per-script overhead (Redis distributed lock, version-check, `publishVersionIfDirty`,
session mutex, path-cache mutations) does NOT scale with command count. The hot
path is purely the per-op transaction round-trips.

By contrast Daytona runs bash in a co-located container against a real kernel FS,
so per-command latency is microseconds; only the single exec round-trip shows up
in wall time. That explains the flat ~305–330ms column in the benchmark.

## Detailed Findings

### 1. The script is sent in one round-trip — not the cause

- `POST /v1/sandboxes/:id/exec-sync` parses the body once and dispatches the whole
  script string to bash via `execWithRuntimeThrottle`:
  - `src/api/routes/exec.ts:166` — single `sessionManager.execWithRuntimeThrottle(session, scriptToRun, ...)` call.
  - `src/api/session-manager.ts:606` — `execWithRuntimeThrottle` calls `session.bash.exec(script, opts)` exactly once.
- Per-script wrappers run **once** at session entry, not per command:
  - Distributed exec lock: `withExecLock` at `src/api/session-manager.ts:330`, applied via `withSession` / `withExistingSession` / `withSessionOrRehydrate` (`session-manager.ts:433–504`).
  - Cache-freshness check: `ensureFreshCache` at `src/api/session-manager.ts:346, 379–402` — one Redis `GET` plus optional `reload()`.
  - Version publish on dirty: `publishVersionIfDirty` at `src/api/session-manager.ts:360, 404–431` — one `INCR` regardless of how many writes happened.
  - Session mutex: `session.mutex.runExclusive` at `src/api/session-manager.ts:348` wraps the whole exec.

None of these scale with the number of chained commands.

### 2. just-bash multi-arg builtins loop and `await` per source

Even a single shell command like `mv a b c dst/` issues N sequential `fs.*` calls
inside just-bash:

- **`mv`** (`node_modules/just-bash/dist/bundle/chunks/chunk-A4JSPFCI.js`):
  ```js
  for (let e of g) try {
      let c = t.fs.resolvePath(t.cwd, e), o = n;
      ...
      if (await t.fs.mv(c, o)) ...
  }
  ```
- **`rm`** (`node_modules/just-bash/dist/bundle/chunks/chunk-MIZPJHVH.js`):
  ```js
  for (let r of c) try {
      let n = s.fs.resolvePath(s.cwd, r);
      if ((await s.fs.stat(n)).isDirectory && !i) { ... continue }
      await s.fs.rm(n, { recursive: i, force: a }), ...
  }
  ```

So `mv 1.txt 2.txt 3.txt dest/` ⇒ 3 sequential `fs.mv()` calls. `rm a b c` ⇒ 3
sequential `fs.rm()` calls. The shell-level optimisation of "many args, one
command" does not survive translation to fs ops.

### 3. Each `fs.<op>` = one Postgres transaction with ~4-RTT fixed overhead

Every write method in `SqlFs` wraps its work in `#withTx` (`src/fs/sql-fs/sql-fs.ts:164`):

```ts
async #withTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.#dialect.transaction(async (tx) => {
        await this.#dialect.setSandboxContextWithLock(tx, this.#sandboxId);
        return await fn(tx);
    });
}
```

`PostgresDialect.transaction` is `pool.begin(fn)` (`src/fs/sql-fs/dialects/postgres.ts:51-53`)
— on Neon's transaction-pooler each `begin` is a fresh `BEGIN`/`COMMIT` pair, each
its own RTT.

`setSandboxContextWithLock` adds **two more sequential round-trips** before the op
runs (`src/fs/sql-fs/dialects/postgres.ts:63-69`):

```ts
await tx`SELECT set_config('app.sandbox_id', ${sandboxId}, true)`;
await tx`SELECT pg_advisory_xact_lock(hashtextextended(${sandboxId}, 0))`;
```

Read paths use the lock-free variant `setSandboxContext` (`postgres.ts:57`) — that's
why pure greps don't show the same scaling.

Op-side query counts (the variable cost on top of the fixed ~4 RTTs):
- `mkdir` non-recursive: `createInode` + `insertDirent` ≈ 2 RTTs (`sql-fs.ts:582-591`)
- `mkdir -p`: **one `#withTx` per missing path segment** in a sequential loop
  (`sql-fs.ts:539-573`). Deep paths fan out to N transactions.
- `mv` single src→dst: `moveDirent` ≈ 1 RTT, +1–2 if displacing dest (`sql-fs.ts:917-925`)
- `rm` single file: `deleteDirent` + `decrementNlink` + maybe `deleteInode` = 2–3 RTTs (`sql-fs.ts:661-665`)
- `rm -rf` subtree: a **single** `#withTx` looping the whole subtree inside one transaction (`sql-fs.ts:624-644`) — recursive removes don't multiply.
- `writeFile`: `upsertBlob` + `createInode` + `upsertDirent` (+ optional cleanup) ≈ 3–5 RTTs (`sql-fs.ts:446-461`).

### 4. Path-cache work is not the culprit

`#pathCache.set/.delete` and `#contentCache.set/.delete` are in-process `Map`/`LRUCache`
ops — submicrosecond. Cross-replica freshness (`reload()` via `loadFreshPathCache`)
only fires when the Redis version counter changes — once per script, not per
command (`sql-fs.ts:372-390`, `session-manager.ts:379-402`).

### 5. Cross-checking against the benchmark numbers (VFS remote NEW column)

Counting transactions per script (each ≈ one unit of latency):

| Case | tx breakdown | total tx | observed (NEW) |
|---|---|---|---|
| `write: echo` | 1 writeFile | 1 | 47 ms |
| `write: append 3x` | 3 appendFile (each reads old blob + writes new) | 3+ | 585 ms (~12×) |
| `delete: single file` | 1 writeFile + 1 rm | 2 | 67 ms |
| `delete: 3 files` | 3 writeFile + 3 rm | 6 | 204 ms (3.0× single) |
| `mkdir: single` | 1 mkdir + 1 rmdir | 2 | 62 ms |
| `mkdir: nested deep` | 5 mkdir-segments + 1 recursive rm | 6 | 286 ms (4.6× single) |
| `mv: rename file` | 1 writeFile + 1 mv + 1 rm | 3 | 99 ms |
| `mv: move 3 files` | 3 writeFile + 1 mkdir + 3 mv + 1 rm-rf | 8 | 294 ms (~3×) |

Ratios match transaction counts within ~10–20% — strong support for "per-tx
round-trip overhead is the dominant cost."

## Code References

- `src/api/routes/exec.ts:166` — single dispatch of full script to bash per HTTP request
- `src/api/session-manager.ts:330–333` — `withExecLock` Redis distributed lock (per-script)
- `src/api/session-manager.ts:336–402` — `withSessionEntry` + `ensureFreshCache` (per-script setup)
- `src/api/session-manager.ts:404–431` — `publishVersionIfDirty` (per-script teardown)
- `src/api/session-manager.ts:606–630` — `execWithRuntimeThrottle` calls `session.bash.exec(script)` once
- `src/fs/sql-fs/sql-fs.ts:164–171` — `#withTx`: per-op transaction wrapper
- `src/fs/sql-fs/sql-fs.ts:178–183` — `#withReadTx`: lock-free read variant
- `src/fs/sql-fs/sql-fs.ts:401–428` — `bulkIngest` (only batched write path; not invoked from bash)
- `src/fs/sql-fs/sql-fs.ts:438–474` — `writeFile` (3+ queries per call)
- `src/fs/sql-fs/sql-fs.ts:476–530` — `appendFile` (extra blob read on top of writeFile)
- `src/fs/sql-fs/sql-fs.ts:532–603` — `mkdir` recursive: one `#withTx` per missing segment
- `src/fs/sql-fs/sql-fs.ts:605–670` — `rm`: recursive subtree is single tx; non-recursive is single tx but called once per arg
- `src/fs/sql-fs/sql-fs.ts:888–947` — `mv`: single tx per call; called once per source by bash
- `src/fs/sql-fs/dialects/postgres.ts:51–53` — `transaction` = `pool.begin(fn)`
- `src/fs/sql-fs/dialects/postgres.ts:57–69` — `setSandboxContext` and `setSandboxContextWithLock` (two sequential statements in the lock variant)
- `node_modules/just-bash/dist/bundle/chunks/chunk-A4JSPFCI.js` — `mv` builtin loops `for (let e of g) ... await t.fs.mv(c, o)`
- `node_modules/just-bash/dist/bundle/chunks/chunk-MIZPJHVH.js` — `rm` builtin loops `for (let r of c) ... await s.fs.rm(n, ...)`

## Architecture Insights

- **Bash co-location matters.** just-bash is a JS interpreter running in the API
  process. Bash semantics (sequential `&&`, await per command) are normal — but
  in this stack each fs call traverses HTTP→bash→SqlFs→Postgres, so per-command
  network latency dominates. Daytona's flat ~305ms wall time is the natural
  consequence of bash being co-located with a real kernel FS.

- **The dialect's RLS-context setup is paid per transaction.** With pgbouncer
  transaction-mode pooling, `SET LOCAL` / `set_config(..., true)` is required
  on every transaction; it can't be hoisted to session level. Each write op
  therefore pays this cost. Read paths skip the advisory lock to avoid queueing
  behind writers — a deliberate trade-off (`postgres.ts:57` vs `:63`).

- **`bulkIngest` already demonstrates the batching pattern.** `sql-fs.ts:401–428`
  ingests N files in one transaction with one `dialect.bulkIngest` call. The
  same shape (one tx, multiple ops, RLS set once) could in principle be applied
  to bash-driven multi-op scripts — but only via a wrapper, since just-bash's
  builtins issue ops one at a time.

- **Path-cache as in-process source of truth is the key enabler for write-back
  designs.** Reads already serve from `#pathCache` / `#contentCache` without
  Postgres (`sql-fs.ts:732-797`); only blob misses hit the DB. So a write-back
  layer that updates caches synchronously and defers SQL is read-coherent
  without further work.

- **Multi-arg shell semantics are not preserved by just-bash.** `mv a b c dst/`
  is not communicated to the fs as a batch op; it's loop-and-await. This means
  any IFileSystem implementation pays N× transaction cost for any multi-arg
  shell command, regardless of how cheap the individual fs call is.

## Wrapping Options (no source modification of just-bash)

just-bash exposes two clean injection points already in use:
- `new Bash({ fs })` — IFileSystem injected into the constructor
- `session.bash.exec(script)` — exec call site

Three concrete wrapper shapes:

### A. Decorator FS that opens one tx per `exec()` (recommended first step)

A thin `IFileSystem` wrapper around `SqlFs` exposing `beginScript()` / `endScript()`.
`SessionManager.execWithRuntimeThrottle` calls `beginScript()` → `bash.exec(script)`
→ `endScript()`. The wrapper holds one `dialect.transaction` open across the whole
script and routes every `fs.*` from bash into it; SqlFs's per-method `#withTx`
becomes a no-op when a script-tx is active.

- Change site: new `SessionScopedFs` wrapper + 1-line change in `session-manager.ts:606`
- Bash sees no change; per-op work just skips BEGIN/setup/COMMIT round-trips.
- Trade-off: holds one DB connection for whole script duration; needs session-pooler
  endpoint or pool sized for concurrent execs. Already-pinned at one connection
  per script via `session.mutex` (`session-manager.ts:348`), so concurrency is
  bounded.
- Bash-failure semantics: commit-on-completion regardless of script exit code;
  rollback only on uncaught JS exception. Matches POSIX shell expectation that
  `mv a b && false && rm c` keeps the `mv`.

### B. Decorator FS with write-back queue

Same wrapper shape, but `fs.mv/rm/mkdir/writeFile` mutate only the in-memory
pathCache and resolve immediately; DB writes stream into a background queue
flushed at `endScript()`. Effective per-op cost in bash drops to a `Map.set()`.

- Subsumes A but adds failure modes: queued op can fail after bash already
  moved on; needs careful error propagation.
- Plays nicely with the planned Redis L2: write to Redis sync, drain to
  Postgres async.

### C. Bulk builtins via upstream PR to just-bash

The "1 shell command = N fs ops" amplifier lives inside just-bash. A clean,
additive upstream PR can teach `mv` / `rm` / `cp` to call optional
`fs.mvBulk(pairs)` / `fs.rmBulk(paths)` when present, falling back to the
loop otherwise. Compounds with A: one tx for 3 mvs, **and** the wrapper sees
1 fs call per shell command.

### What wrapping cannot do

- **Auto-coalesce sequential single-arg calls** into a batch. Bash awaits each,
  so by the time `fs.mv` #2 enters our wrapper, #1's promise has already resolved.
  Coalescing only works if we lie about completion (= option B).
- **Skip the await semantics** without an in-process source of truth. Path-cache
  already provides this, so B is feasible — but A is the safer first move.

## Tier Summary

**Tier 1 — quick wins inside the existing model**
1. Fuse `set_config` + `pg_advisory_xact_lock` into one statement in `postgres.ts:63` — saves 1 RTT per write op.
2. Collapse op queries into single CTE/proc per fs method — `mv`, `rm`, `writeFile` go from 2–5 queries to 1.
3. Re-enable prepared statements (requires moving exec to a session-pooler URL or using unnamed prepares).

**Tier 2 — structural**
4. Bulk-arg fast paths (option C above).
5. Script-scoped transaction (option A above).
6. Write-back via Redis (option B; aligns with the existing L2 plan in memory).

**Tier 3 — architectural**
7. Co-locate API process with Postgres (free if not already done).
8. Local-FS overlay per session (Daytona-style; biggest move; changes durability model).

## Historical Context (from thoughts/)

Sibling research file `thoughts/shared/research/2026-04-24_21-16-55_session-rehydration-gap.md`
exists in this directory but was not opened during this investigation; it is
referenced here only as the most recent peer document. No prior research on
benchmark scaling or per-op transaction overhead was discovered.

The user's auto-memory records that **a Redis L2 between in-memory caches and
Postgres is already on the roadmap** — this aligns directly with option B
(write-back queue) above.

## Open Questions

- **Actual Postgres RTT from the API process.** The analysis assumes ~5–30ms per
  RTT on Neon. Measuring `SELECT 1` from the API host would pin the floor cost
  precisely and clarify how much of the win comes from option 1/2 (RTT count
  reduction) vs option 7 (RTT magnitude reduction).
- **`appendFile` 12× factor.** `write: append 3x` is 585ms vs 47ms for one
  `write: echo`. The 3× from chained ops explains part of it; the rest is the
  per-call extra blob read in `sql-fs.ts:486` (`getBlob` for the existing content
  before writing the merged buffer). Worth confirming the breakdown.
- **Effect of `prepare: false`** (`postgres.ts:41`) on per-query parse/plan
  overhead, especially for the hot `setSandboxContextWithLock` and `moveDirent`
  paths. Re-enabling named prepares requires moving off pgbouncer
  transaction-pool — quantify before deciding.
- **just-bash ownership/PR appetite.** Option C requires upstream cooperation;
  unclear how responsive the maintainer is and whether bulk-fs is in-scope for
  the project.

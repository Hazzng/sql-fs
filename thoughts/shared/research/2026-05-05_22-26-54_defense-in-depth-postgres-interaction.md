---
date: 2026-05-05T22:26:54+09:30
researcher: Harry Nguyen
git_commit: effe298e8b608097b637c8dac82c7db1bc637e33
branch: main
repository: virtualFS
topic: "How just-bash defenseInDepth interacts with SqlFs/Postgres calls"
tags: [research, codebase, just-bash, defense-in-depth, sql-fs, postgres, security]
status: complete
last_updated: 2026-05-05
last_updated_by: Harry Nguyen
---

# Research: How just-bash defenseInDepth interacts with SqlFs/Postgres calls

**Date**: 2026-05-05 22:26:54 ACST
**Researcher**: Harry Nguyen
**Git Commit**: effe298e8b608097b637c8dac82c7db1bc637e33
**Branch**: main
**Repository**: virtualFS

## Research Question

A user reports that when testing `SqlFs` plugged into `just-bash`, they had to disable `defenseInDepth`; otherwise calls into Postgres throw errors. Hypothesis: `defenseInDepth` blocks the `setTimeout`/`setImmediate` globals that the `postgres` driver relies on. Trace through the codebase to:

1. Where (and whether) `defenseInDepth` is configured when we create Bash sandboxes.
2. The execution flow `Bash.exec → IFileSystem → SqlFs → postgres`.
3. Whether Postgres operations actually run inside the `defenseInDepth`-restricted context.
4. How the bug manifests in production.

## Summary

**The bug is real, but it does not manifest in the `virtualfs-api` service today** because `defenseInDepth` is never enabled at the only `new Bash(...)` call site (`src/api/session-manager.ts:299`). It manifests only for downstream consumers (or local tests) that compose `just-bash` with `defenseInDepth: true` and pass our `SqlFs` as the filesystem.

The hypothesis is correct. `defenseInDepth` monkey-patches `setTimeout`, `setImmediate`, `Function`, `eval`, `process`, and dynamic `import` during script execution (just-bash `Bash.d.ts:121–146`). The `postgres` driver (porsager/postgres v3) uses `setTimeout`/`clearTimeout` for connect / idle / lifetime timers and `setImmediate`/`clearImmediate` for batched writes (see `node_modules/postgres/src/connection.js:1042–1062`, `node_modules/postgres/src/index.js:372`, `node_modules/postgres/src/connection.js:250, 256, 427, 440`). Because there is **no worker / thread boundary between the bash script execution context and the SqlFs → postgres call** — the `IFileSystem` runs in the same JS event loop as the interpreter — postgres timer calls happen while the globals are patched, and `defenseInDepth` raises `WorkerSecurityViolationError`.

just-bash exposes the intended escape hatch via `requireDefenseContext` / `runInDefenseBox` (`node_modules/just-bash/dist/types.d.ts:174–178, 189`) and `DefenseInDepthBox.runTrustedAsync(...)`, plus `createDefenseAwareCommandContext` (`dist/interpreter/defense-aware-command-context.d.ts`). `SqlFs` does not currently wrap its `postgres` calls in those helpers, so any caller that turns `defenseInDepth` on will hit the violation.

## Detailed Findings

### 1. Where `defenseInDepth` is configured in our codebase

It isn't. The only place we instantiate `Bash` is:

- `src/api/session-manager.ts:299–303` — constructs the per-sandbox Bash with `{ fs, python, javascript }` only. No `defenseInDepth` field is passed, so the option is `undefined` and the protection layer stays off.

There are zero other references to `defenseInDepth`, `SecurityViolation`, `DefenseInDepthBox`, or `requireDefenseContext` anywhere under `src/`.

The type is declared in just-bash:

- `node_modules/just-bash/dist/Bash.d.ts:121–147` — `defenseInDepth?: DefenseInDepthConfig | boolean` with JSDoc explicitly noting it monkey-patches `Function`, `eval`, `setTimeout`, `process`, etc.
- `node_modules/just-bash/dist/sandbox/Sandbox.d.ts:32–35` — `SandboxOptions.defenseInDepth` defaults to `true` for the higher-level `Sandbox` wrapper. We use `Bash` directly, not `Sandbox`, so we don't inherit that default — but anyone wrapping our `SqlFs` via `Sandbox` would.

### 2. Execution flow Bash → SqlFs → postgres

1. HTTP request arrives at `src/api/routes/exec.ts`. The handler resolves a session and calls `session.bash.exec(script)` via `execWithRuntimeThrottle` (`session-manager.ts:626–665`). The exec timeout uses host `setTimeout` (`exec.ts:160, 248`) — that one is fine because it runs outside the interpreter.
2. `Bash.exec` runs the parsed script in the same Node event loop. Builtins / commands invoke methods on the `fs` we passed in.
3. `fs` is a `SqlFs` constructed in `src/fs/sql-fs/index.ts → createPostgresSandboxFs` (called from `session-manager.buildFs`, `session-manager.ts:245–265`).
4. `SqlFs.readFile` / `writeFile` / etc. (`src/fs/sql-fs/sql-fs.ts`) call `dialect.transaction(...)` or `dialect.getBlobNoTx(...)`.
5. `PostgresDialect` (`src/fs/sql-fs/dialects/postgres.ts:40–52`) uses `postgres(connectionString, { prepare: false })` — the porsager/postgres client. `transaction()` calls `db.begin(fn)`.
6. The driver internally schedules timers and immediates as part of normal operation.

There is **no worker_threads boundary, no `vm` context, no separate isolate** between steps 2 and 6. They share globals.

### 3. Does Postgres run inside the restricted context?

Yes — when `defenseInDepth` is on. The interpreter installs the monkey patches around the script's async execution (the violation logic is compiled into `node_modules/just-bash/dist/bin/chunks/worker.js:58–82, 519–1456` and the `js-exec-worker.js` mirror). Anything called synchronously or via awaited promises from a builtin is inside that scope, including:

- The first connection from our pool (lazy connect in `postgres` triggers `setTimeout` for `connectTimer`).
- Any `idle_timeout` / `max_lifetime` rearm during query execution.
- `setImmediate(nextWrite)` used to batch writes for prepared messages.

The driver uses **module-scope references to the timer globals**, not `globalThis.setTimeout`, but `defenseInDepth` patches the globals before module evaluation occurs in the protected scope, so the captured references are already the patched ones (or, more importantly, when the driver does `setTimeout(...)` from within the patched async context, the lookup resolves to the patched function). Either way, the violation handler fires.

just-bash itself acknowledges this: commands that legitimately need real timers can opt out via `Command.runInDefenseBox` / `CommandContext.requireDefenseContext` (`node_modules/just-bash/dist/types.d.ts:174–189`) and `DefenseInDepthBox.runTrustedAsync(...)`. `SqlFs` is not a "command"; it's the `IFileSystem` plumbing, so those flags don't directly apply to fs methods — but the same `runTrustedAsync` API is what we'd need to wrap our DB calls in.

### 4. How the bug manifests

Scenarios:

- **Production virtualfs-api today:** Not affected. `session-manager.ts:299` passes no `defenseInDepth`, so the patches never run, and the `postgres` driver uses unpatched timers happily.
- **Downstream consumer enables it:** If anyone instantiates `new Bash({ fs: sqlFs, defenseInDepth: true })` (the JSDoc example at `Bash.d.ts:135`), the first SqlFs operation that triggers postgres I/O — typically the first `cat`/`ls` after sandbox boot, or our own `loadAllPaths` path-snapshot warmup — throws `WorkerSecurityViolationError` complaining about `setTimeout` (or `setImmediate` for write batching). The user reports exactly this.
- **Wrapping with `Sandbox` instead of `Bash`:** `SandboxOptions.defenseInDepth` defaults to `true` (`Sandbox.d.ts:32–35`). A consumer who picks the higher-level wrapper gets the bug by default and has to opt out explicitly.
- **Tests that mimic that setup:** Same as above. The user's repro path.

What blows up first: `PostgresDialect.connect()` does `postgres(connectionString, ...)` — but porsager's client lazily opens connections on first query. So the violation typically fires on the first `dialect.transaction(...)` call from `SqlFs.loadAllPaths` (eager pathCache hydration during `createSandboxFs`) **before** any user script runs… *unless* our factory is called outside the interpreter scope. Looking at `session-manager.ts:245–265`, `buildFs` is awaited **before** `new Bash(...)`, so pathCache hydration runs in the host context and would succeed even with `defenseInDepth` later. The first failure surface is therefore the first DB-touching fs call **during** `bash.exec` — e.g. a write that flushes through `writeFileTx`, or a `readFile` for a blob not yet in `contentCache`.

## Code References

- `src/api/session-manager.ts:299–303` — `new Bash({ fs, python, javascript })` — the sole construction site, no `defenseInDepth`.
- `src/api/session-manager.ts:245–265` — `buildFs` → `createPostgresSandboxFs`; runs in host context before Bash exec.
- `src/api/routes/exec.ts:160, 248` — host-side exec timeout `setTimeout` (unaffected).
- `src/fs/sql-fs/dialects/postgres.ts:40–52` — `postgres(connectionString, { prepare: false })` and `transaction` via `db.begin`.
- `src/fs/sql-fs/sql-fs.ts` — every IFS method funnels into `dialect.transaction`, hence into postgres timers.
- `node_modules/just-bash/dist/Bash.d.ts:121–147` — `defenseInDepth` config + JSDoc listing patched globals.
- `node_modules/just-bash/dist/sandbox/Sandbox.d.ts:32–35` — `SandboxOptions.defenseInDepth` defaults to `true`.
- `node_modules/just-bash/dist/types.d.ts:174–189` — `CommandContext.requireDefenseContext`, `Command.runInDefenseBox`.
- `node_modules/just-bash/dist/interpreter/defense-aware-command-context.d.ts:1–6` — `createDefenseAwareCommandContext` helper.
- `node_modules/just-bash/dist/bin/chunks/worker.js:58–82, 519–1456` — compiled `WorkerSecurityViolationError` and rule list (covers `setTimeout`, `setImmediate`, dynamic import, `process.mainModule/execPath/connected`).
- `node_modules/postgres/src/connection.js:250, 256, 427, 440` — `setImmediate(nextWrite)` / `clearImmediate` for batched writes.
- `node_modules/postgres/src/connection.js:1042–1062` — `timer()` helper using `setTimeout`/`clearTimeout` for `idleTimer`, `lifeTimer`, `connectTimer`.
- `node_modules/postgres/src/index.js:372` — query/connection destruction `setTimeout`.

## Architecture Insights

- **Single shared event loop.** Our design relies on running `IFileSystem` calls in the same JS context as the bash interpreter. This is fine for performance (no IPC), but it means **any global-tampering security layer the interpreter installs will affect our DB driver too.** This is a non-obvious coupling between just-bash's secondary security layer and our DB choice.
- **`postgres` (porsager) is timer-heavy.** `pg` (node-postgres) uses sockets directly and would also use timers, so swapping drivers wouldn't help. Any TCP-based driver will trip the same patches.
- **just-bash's intended escape hatch (`runTrustedAsync`) targets commands, not fs methods.** Adopting it inside `SqlFs` would mean importing `DefenseInDepthBox` from just-bash and wrapping every dialect call — viable, but creates a circular concern (the fs has to know about the interpreter that will run on top of it). A cleaner fix is to detect that `defenseInDepth` is active at construction time and route DB calls through `runTrustedAsync` only then, leaving consumers who don't enable it untouched.
- **Production has been getting away with it.** Because we don't enable `defenseInDepth` ourselves, this has been a latent bug for any consumer following just-bash's own JSDoc example. The CLAUDE.md "Security" guidance focuses on RLS / sandbox isolation / null prototypes — it doesn't mention defense-in-depth, which matches the fact that we never wired it up.

## Open Questions

- Do we want to enable `defenseInDepth` ourselves at `session-manager.ts:299`? If yes, we have to fix the timer-blocking issue first.
- Should `SqlFs` defensively wrap its dialect calls in `DefenseInDepthBox.runTrustedAsync(...)` when available, so consumers can opt in safely without modifying our code? That introduces a soft dependency on `DefenseInDepthBox` being exported from `just-bash`.
- Does the same issue affect MySQL (`mysql2`) and Azure SQL (`mssql`/tedious) dialects? Both libraries also use sockets+timers; almost certainly yes — worth verifying before publishing a fix only for postgres.
- Does `auditMode: true` (`Bash.d.ts:141`) silence the throw and just log? If so, it's a viable workaround for the user pending a real fix.
- Is `js-exec` / `python3` worker FS access (which goes back to the parent through a bridge) subject to the same patches? Those workers have their own copies of `WorkerSecurityViolationError` (`worker.js:519–1456`, `js-exec-worker.js:496–1433`) — needs a follow-up if FS calls cross that boundary.

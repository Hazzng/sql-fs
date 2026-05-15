---
date: 2026-05-14T20:27:13+09:30
researcher: Harry Nguyen
git_commit: dd7e7fd84c7256457ca28225d8118072ff9b8e0a
branch: main
repository: virtualFS
topic: "Issue #64 — Why `exec-sync-batch` / `bash_exec_batch` does not parallelize even on the readOnly path"
tags: [research, codebase, batch-exec, parallelism, rw-lock, read-only, async-local-storage, session-manager]
status: complete
last_updated: 2026-05-14
last_updated_by: Harry Nguyen
---

# Research: Why `exec-sync-batch` / `bash_exec_batch` doesn't parallelize on the readOnly path (Issue #64)

**Date**: 2026-05-14 20:27:13 ACST
**Researcher**: Harry Nguyen
**Git Commit**: `dd7e7fd84c7256457ca28225d8118072ff9b8e0a`
**Branch**: `main`
**Repository**: virtualFS

---

## Research Question

[Issue #64](https://github.com/Hazzng/virtualFS/issues/64) asks: why does `POST /v1/sandboxes/:id/exec-sync-batch` (and MCP `bash_exec_batch`) still execute scripts **sequentially** even when the call enters via `readOnly: true`, despite the parallel-readOnly bash-exec feature already shipping (Issue #60, commits 34228c1 → 0.3.1)?

We need to:

1. Document the exact code path scripts in a batch traverse today.
2. Pinpoint where the serialization is and why it was chosen.
3. Enumerate the invariants that must hold so a parallel fan-out within a batch is provably safe.
4. List the concrete changes required to honor Issue #64's proposal — and the tests that already constrain the design.

---

## Summary

The bottleneck is exactly one `for` loop: `src/api/lib/batch-exec.ts:27`. It awaits each `sessionManager.execWithRuntimeThrottle(...)` sequentially regardless of whether the call entered via the read or write path. The session-level RW lock is acquired **once** by `withSessionRead` outside the loop and held for the whole batch — every script in a readOnly batch already runs inside a single shared-lock grant with `readOnlyContext` active. None of the per-script state would need to change to fan out in parallel.

Everything that would have made parallel-within-batch unsafe is already designed away by the Issue #60 work:

- The shared lock is held across the whole batch (`session.lock.runShared(...)` at `session-manager.ts:558`).
- `SqlFs.beginReadOnlyScope()` is **reference-counted** (`sql-fs.ts:580-589`); parallel scripts within the same outer scope don't need their own begin/end.
- `readOnlyContext` (an `AsyncLocalStorage`) is set up **once per `withSessionRead`** (`session-manager.ts:579`). `Promise.all(scripts.map(runOne))` fan-out automatically inherits the same `ctx` in every branch, so violations across siblings are attributed to *this batch* and remapped to a single `EREADONLY_VIOLATION` at the end.
- `scriptTx.beginScope/endScope` is **already skipped** on the read path (`session-manager.ts:1116-1130`) — the comment in-source explicitly cites parallel-reader races as the reason.
- `pythonSem` / `jsSem` (`session-manager.ts:238-294`, `1042-1105`) are global FIFO semaphores; concurrent acquisition is already safe and excess scripts queue cleanly.

The serial-within-batch behavior was a deliberate tradeoff parked in Open Question #4 of the 2026-05-10 RW-lock design doc — the team shipped parallel **across** requests first and left intra-batch parallelism for a follow-up. Issue #64 is that follow-up.

The required change is small: thread a `readOnly` signal into `executeBatch` (either via parameter or by sniffing `readOnlyContext.getStore()`), branch the loop body to `Promise.all` with a pre-sized result array, cap concurrency, and update the MCP docstring. Only one existing test (`exec-batch.test.ts:107-127`) relies on intra-batch sequential ordering — and that test exercises the **write** path, which must stay serial, so it is unaffected.

---

## Detailed Findings

### 1. The serialization point — `src/api/lib/batch-exec.ts`

The entire function is 78 lines and the loop is the only execution mechanic:

```ts
// src/api/lib/batch-exec.ts:17-78
export async function executeBatch(
    sessionManager: SessionManager,
    session: Session,
    scripts: readonly BatchScriptEntry[],
    totalTimeoutMs: number,
    outerSignal?: AbortSignal,
): Promise<BatchScriptResult[]> {
    const results: BatchScriptResult[] = [];
    const batchStart = Date.now();

    for (const entry of scripts) {              // ← THE LOOP
        if (outerSignal?.aborted) break;
        const remaining = totalTimeoutMs - (Date.now() - batchStart);
        ...
        const execResult = await sessionManager.execWithRuntimeThrottle(session, entry.script, {
            signal: controller.signal,
        });                                     // ← THE await
        ...
        results.push({ id: entry.id, stdout, stderr, exitCode });
    }
    return results;
}
```

Key observations:

- **The function knows nothing about read vs write.** Whether `withSessionRead` (shared lock) or `withSessionOrRehydrate` (exclusive lock) called it, the loop body is identical.
- **`results.push(...)`** preserves input order *by virtue of* the sequential loop. Parallel execution must switch to indexed assignment into a pre-sized array — `results[i] = ...` — to keep result-order stable.
- **Per-script timeout** uses `totalTimeoutMs - (Date.now() - batchStart)` (line 30). Each script gets a per-script `AbortController` with a `setTimeout` for the remaining budget. In a parallel world, all in-flight scripts can share a single batch-deadline timer + one shared `AbortController`; alternatively, each parallel script can still get its own timer derived from the same global deadline.
- **`outerSignal` cancellation** is handled per-iteration with `addEventListener("abort", ...)` (line 45) — fan-out can keep one shared listener that aborts every in-flight controller at once.
- **Error path** (`catch` at line 64) handles three sub-cases: timeout, outer-disconnect, and "internal error". In a parallel world this stays per-runOne with the same three branches.

### 2. The two call sites — both already route on `readOnly`

Both entry points already branch between read and write runners before calling `executeBatch`. The branch is the only piece of `readOnly` logic in the batch path today; everything else is identical to the unary exec handlers.

#### HTTP route `POST /v1/sandboxes/:id/exec-sync-batch` — `src/api/routes/exec.ts:343-393`

```ts
const runner = body.readOnly ? withOwnedSessionRead : withOwnedSessionOrRehydrate;
results = await runner<BatchScriptResult[]>(
    sessionManager, tenant, sandboxId, c.get("owner"),
    async (session) => executeBatch(sessionManager, session, body.scripts, totalTimeoutMs, disconnectController.signal),
);
```

- The schema `batchExecBodySchema` (`exec.ts:37-49`) already accepts `readOnly: z.boolean().optional()`.
- A `disconnectController` is wired to `c.req.raw.signal` and forwarded as the 5th arg of `executeBatch` so a client abort fans out to all in-flight scripts.
- `EREADONLY_VIOLATION` → HTTP 422 mapping is already in the catch block (lines 379-389).

#### MCP tool `bash_exec_batch` — `src/api/mcp/tools.ts:266-345`

```ts
// mcp/tools.ts:296-301
const runner = args.readOnly ? withOwnedSessionRead : withOwnedSessionOrRehydrate;
const results = await runner(sessionManager, tenant, args.id, owner, async (session) =>
    executeBatch(sessionManager, session, args.scripts, totalTimeoutMs),
);
```

- The Zod schema (`tools.ts:281-293`) already exposes `readOnly` to MCP clients.
- The MCP handler does **not** pass an outer signal (4 args, not 5). For parity with HTTP, a `disconnectController` derived from the MCP context's cancellation signal could be added — independent of Issue #64, but worth a note.
- The tool **description** at `tools.ts:268-279` is the docstring Issue #64 calls out: it still says scripts run "sequentially within a single request" and never mentions the parallel option. This needs to be updated as part of this work.

### 3. What `withSessionRead` already guarantees for the whole batch

`SessionManager.withSessionReadEntry` (`src/api/session-manager.ts:546-633`) is the single function that sets up the read-only environment around `executeBatch`. It does all of the following **once, for the whole batch** — never per-script:

```ts
// session-manager.ts:546-633 (condensed)
await this.ensureFreshCache(tenantId, sandboxId, session);
return session.lock.runShared(async () => {                    // ← shared lock held for batch
    const roFs = asReadOnlyFs(session.fs);
    const ctx: ReadOnlyContext = { violated: false };           // ← one ctx for the batch
    session.inFlight++;
    let scopeOpened = false;
    try {
        if (roFs !== undefined) {
            roFs.beginReadOnlyScope();                          // ← refcount++
            scopeOpened = true;
        }
        let result: T;
        try {
            result = await readOnlyContext.run(ctx, () => fn(session));   // ← ALS active for fn
        } catch (err) {
            // Audit and remap EREADONLY → EREADONLY_VIOLATION
            ...
        }
        if (ctx.violated) {
            logAudit("read_only_violation", { tenantId, sandboxId });
            throw Object.assign(new Error("EREADONLY_VIOLATION: ..."), { code: "EREADONLY_VIOLATION" });
        }
        return result;
    } finally {
        if (scopeOpened && roFs !== undefined) roFs.endReadOnlyScope();  // ← refcount--
        session.inFlight--;
    }
});
```

The `fn(session)` in this block **is** the call to `executeBatch`. Crucially:

- The shared lock (both per-session `RWLock` and Redis distributed RW lock via `withExecLockShared`, `session-manager.ts:474-477`) is held continuously across all scripts. Parallelizing the loop **does not change** how long the lock is held — that was Open Question #4's concern, and the answer is "the hold duration is unchanged; only the wall-clock to completion shrinks."
- `beginReadOnlyScope()` is called once (refcount=1). Concurrent scripts in `Promise.all` simply run inside that same scope — they neither begin nor end it themselves.
- `readOnlyContext.run(ctx, ...)` wraps the `fn(session)` call **before** any `Promise.all` fan-out happens inside it. `AsyncLocalStorage` is propagated across `await` and `Promise.all` branches, so **every parallel script in the batch sees the same `ctx`**. A write attempt by any one of them sets `ctx.violated = true`, which is correctly checked after `Promise.all` resolves.
- `SqlFs.#assertWritable` (`sql-fs.ts:591-597`) reads the ctx out of ALS and sets `ctx.violated = true` per call, throwing `EREADONLY` synchronously inside the offending script. The script returns a non-zero exit (or, for shell redirections, the raw error escapes — which is why the route layer also catches `EREADONLY` directly and remaps to `EREADONLY_VIOLATION`).

This is *exactly* the "readOnlyContext attribution already isolates the violator from siblings" behavior the Issue #64 description leans on.

### 4. `execWithRuntimeThrottle` — why concurrent invocation is already safe

`src/api/session-manager.ts:1108-1153`:

```ts
async execWithRuntimeThrottle(session, script, opts) {
    const usesPython = session.runtimeOptions.python && PYTHON_INVOCATION_REGEX.test(script);
    const usesJs     = session.runtimeOptions.javascript && JS_INVOCATION_REGEX.test(script);

    const inReadOnlyScope = readOnlyContext.getStore() !== undefined;   // ← parallel-safe gate
    const execFn = async () => {
        if (!inReadOnlyScope && session.scriptTx !== undefined) {
            session.scriptTx.beginScope();                              // ← skipped on readOnly
            try {
                const result = await session.bash.exec(script, opts);
                await session.scriptTx.endScope();
                return result;
            } catch (err) {
                await session.scriptTx.abortScope();
                throw err;
            }
        }
        return session.bash.exec(script, opts);
    };

    if (!usesPython && !usesJs) return execFn();
    // semaphore acquire/release in finally — FIFO queueing
    ...
}
```

The in-source comment at line 1112-1115 spells out the parallel-safety reasoning:

> `readOnly` execs skip `scriptTx` entirely: the FS rejects all writes via `EREADONLY` before any DB call, so the per-script transaction has nothing to commit, and `beginScope/endScope` on the shared `SessionScopedFs` would race across concurrent parallel readers.

So the only concern that *would* break under intra-batch parallelism — `SessionScopedFs.beginScope/endScope` racing across scripts — is already explicitly avoided on the read path. The codebase has already paid the design cost.

The Python/JS semaphores (`session-manager.ts:1042-1105`) are explicitly designed to take multiple concurrent acquisitions. A batch of 10 readOnly `python3 …` scripts will simply queue past `MAX_CONCURRENT_PYTHON` (default 5) FIFO — no deadlock risk because slot acquisition is non-reentrant and release happens in `finally`.

### 5. `session.bash.exec` concurrency — the single residual assumption

`node_modules/just-bash/dist/Bash.d.ts:222` declares `exec` without any concurrency guarantee. The Issue #60 work assumed `Bash.exec` is concurrency-safe across multiple in-flight calls on the same `Bash` instance, and shipped behind that assumption. The "20 parallel readOnly requests in ~430ms" probe Issue #64 cites is the field validation of that assumption.

Intra-batch parallelism reuses the same `session.bash` instance that cross-request parallelism already uses — so it inherits exactly the same assumption, no more, no less. If `Bash.exec` *were* unsafe for concurrent calls, parallel-across-requests would already be broken, which it isn't.

### 6. What is NOT held across the batch (and why that's fine)

- **`scriptTx` scope**: skipped on the read path (above). No begin/end races.
- **`publishVersionIfDirty`**: skipped on the read path (`session-manager.ts:546-633` finally — no version publish). Read-only batches don't bump the version counter; the next writer's publish covers any missed-cache concerns by defense-in-depth.
- **`ensureFreshCache`**: called once before entering the shared lock (`session-manager.ts:557`). Single-flighted across the cohort via `session.freshCacheInflight`. Within a single batch, the cache is reloaded at most once at batch entry, and parallel scripts share the result.

### 7. Why this lives in Open Question #4 and not in the original feature

The 2026-05-10 RW-lock research doc (`thoughts/shared/research/2026-05-10_13-03-37_parallel-readonly-bash-exec.md`) §"Open Questions" #4 says:

> **`exec-sync-batch` in read-only mode** — A batch of scripts with `readOnly: true` would hold the shared lock for the duration of the entire batch, blocking writers for longer. Is this the desired behavior? The alternative is to acquire/release shared mode per script in the batch, but that introduces version-staleness gaps between scripts.

The team interpreted this as a tradeoff about **lock hold duration** vs **cache consistency**, and chose to defer. Issue #64 reframes it differently: the lock-hold-duration tradeoff is unchanged either way (we still hold the lock for the batch), but we leave wall-clock latency on the floor by not fanning out. Both concerns can be satisfied by:

- Keeping a single shared-lock grant across the whole batch (unchanged).
- Replacing the sequential loop with `Promise.all` for the readOnly path (the change).

### 8. The one test that constrains us — `exec-batch.test.ts`

`src/api/tests/unit/exec-batch.test.ts:107-127` (`"shares filesystem state across sequential scripts"`):

```ts
body: JSON.stringify({
    scripts: [
        { id: "write", script: "echo batch-test > /tmp/batch.txt" },
        { id: "read",  script: "cat /tmp/batch.txt" },
    ],
}),
// expects results[1].stdout === "batch-test\n"
```

This test **does not set `readOnly: true`**, so it stays on the exclusive-lock write path and continues to use the sequential loop. The "shared FS state across sequential scripts" guarantee is preserved as the *write-path atomicity guarantee* — which Issue #64 explicitly says we keep.

Other ordering assertions in the file (`exec-batch.test.ts:80-81`, `:102-104`, `:125-126`, `:183-186`) all index by position into `results[]`. They will keep passing as long as the parallel implementation writes into a pre-sized array indexed by input position, instead of `push`-ing.

The timeout test at `exec-batch.test.ts:129+` uses fake timers and a mocked `bash.exec` that blocks the first call indefinitely. Under sequential semantics, the second script never runs and is marked `timeout`. Under parallel semantics with a shared budget, both scripts would start, both would be in-flight when the budget expires, and the shared `AbortController` would abort both — the test's expected outcome (`results[0].error === "timeout"`, `results[1].error === "timeout"`) still holds. But this is also a write-path test (no `readOnly`), so even if behavior diverged, the test would remain on the serial branch.

**Net constraint on the design:** parallel readOnly batches need pre-sized indexed result writes and a shared abort/budget controller, but no existing test changes shape.

### 9. Concurrency cap — why and what value

The issue calls for `MAX_BATCH_PARALLELISM` (default `min(scripts.length, 16)`). Two reasons:

- **Runtime-semaphore fairness across tenants**: a single 50-script readOnly batch where all scripts call `python3` could in theory queue 50 waiters on `pythonSem` (default cap 5), starving other tenants' Python execs for the duration of the batch. A per-batch cap of 16 caps that fairness damage; the semaphore queue (also 100-deep) absorbs the rest.
- **Bash instance pressure**: the `Bash.exec` concurrency assumption above is "safe under cross-request parallelism" — practical, not unbounded. Capping intra-batch fan-out at 16 keeps the actual fan-in on a single `Bash` instance similar to what production load already exercises.

No deadlock risk: the cap is a strict upper bound on simultaneous `runOne` calls; semaphore acquisition inside `runOne` happens after the cap has admitted the script, so a script holding the cap-slot but waiting for a semaphore slot cannot block the next batch-slot from being filled by a non-python/non-js sibling.

---

## What needs to change to honor Issue #64

Concrete, minimal change set (no API surface change beyond the MCP docstring; no schema change):

1. **`src/api/lib/batch-exec.ts`** — replace the body of `executeBatch` with a branch:
   - **Read path** (detect via `readOnlyContext.getStore() !== undefined`, or accept an explicit `readOnly: boolean` param): build a pre-sized `results: BatchScriptResult[]` of length `scripts.length`, a shared `AbortController` wired to `outerSignal` and the batch deadline, and a small concurrency limiter (`MAX_BATCH_PARALLELISM = Math.min(scripts.length, 16)`). Run `runOne(entry, index)` under that limiter, writing into `results[index]`. Per-script timeout becomes `totalTimeoutMs - elapsed` from the shared batch start.
   - **Write path**: unchanged `for` loop.
2. **`src/api/mcp/tools.ts:268-279`** — update the `bash_exec_batch` description to read something like: "Scripts run in parallel within a single request when `readOnly: true`, sequentially otherwise (atomicity)." The atomicity wording at lines 273-279 stays for the write path.
3. **Optional**: the MCP handler at `mcp/tools.ts:294-301` doesn't pass a 5th-arg signal to `executeBatch`. If we want disconnect cancellation parity with HTTP, wire an `AbortController` from the MCP cancellation signal. Not strictly required by Issue #64.
4. **New integration probe** (acceptance criterion in the issue): 10 readOnly scripts with `sleep 0.5; echo ok` finish in wall-clock < 2 s (was ~5 s). The probe likely belongs in `src/api/tests/integration/` next to the existing cross-replica RW-lock tests, or as a new scenario in `scripts/stress-test.ts:581+` (already exercises `withSessionRead`).

The detection-via-AsyncLocalStorage option is the cleanest because `executeBatch` is *always* called inside `readOnlyContext.run(...)` when on the read path — no call-site changes needed at all. If we'd rather be explicit, threading a parameter through `routes/exec.ts:373-375` and `mcp/tools.ts:298-301` is also straightforward.

---

## Safe parallelization invariants (checklist)

The parallel readOnly branch is safe iff, **at the boundary of `executeBatch`**:

- [x] The shared lock is already held for the duration of the batch (`session.lock.runShared` wraps the call). — `session-manager.ts:558`
- [x] The Redis distributed RW lock is already held in shared mode for the duration of the batch (`withExecLockShared`). — `session-manager.ts:474-477`
- [x] `SqlFs` read-only depth has been incremented once; mutating syscalls will throw `EREADONLY` regardless of which parallel script attempts them. — `sql-fs.ts:580-589, 591-597`
- [x] `readOnlyContext` is active with a single `{ violated }` cell, and `AsyncLocalStorage` propagates across `Promise.all` fan-out. — `session-manager.ts:579`, `read-only-context.ts:19`
- [x] `scriptTx` is *not* opened by any of the parallel scripts (`execWithRuntimeThrottle` skips it when `readOnlyContext.getStore() !== undefined`). — `session-manager.ts:1116-1130`
- [x] `publishVersionIfDirty` is *not* called by readers; the read path's finally never publishes. — `session-manager.ts` read-entry finally
- [x] `pythonSem` / `jsSem` are global FIFO and tolerate concurrent acquisition; over-cap acquires queue. — `session-manager.ts:238-294, 1042-1105`
- [ ] `session.bash.exec` is concurrency-safe across siblings on the same `Bash` instance. — *Same assumption Issue #60 already shipped under*; no in-source documentation in just-bash, but the cross-request probe (20× concurrent in ~430ms) validates it.
- [ ] Result-order stability. — *Requires* pre-sized indexed writes (`results[i] = ...`) instead of `push`.
- [ ] Per-batch concurrency cap to avoid one batch starving runtime semaphores cross-tenant. — *New code* (`MAX_BATCH_PARALLELISM`).

Bottom three rows are the only ones the implementation needs to add. Everything else is already in place.

---

## Code References

| File | Lines | Description |
|---|---|---|
| `src/api/lib/batch-exec.ts` | 17-78 | `executeBatch` — the for loop is the only serialization point |
| `src/api/lib/batch-exec.ts` | 27 | The `for (const entry of scripts)` loop |
| `src/api/lib/batch-exec.ts` | 48 | The `await sessionManager.execWithRuntimeThrottle(...)` |
| `src/api/routes/exec.ts` | 37-49 | `batchExecBodySchema` — already accepts `readOnly` |
| `src/api/routes/exec.ts` | 343-393 | `POST /exec-sync-batch` handler — runner branch on `body.readOnly` |
| `src/api/routes/exec.ts` | 373-375 | The `executeBatch` invocation (5-arg with disconnect signal) |
| `src/api/mcp/tools.ts` | 266-345 | `bash_exec_batch` tool definition |
| `src/api/mcp/tools.ts` | 268-279 | Tool docstring — needs "parallel on readOnly" update |
| `src/api/mcp/tools.ts` | 281-293 | Zod schema — already accepts `readOnly` |
| `src/api/mcp/tools.ts` | 296-301 | Runner branch + `executeBatch` invocation (4-arg, no signal) |
| `src/api/session-manager.ts` | 474-477 | `withExecLockShared` — Redis distributed RW lock (shared) |
| `src/api/session-manager.ts` | 546-633 | `withSessionReadEntry` — per-session shared lock, RO scope, ALS setup |
| `src/api/session-manager.ts` | 558 | `session.lock.runShared(...)` — held for the whole batch |
| `src/api/session-manager.ts` | 570-571 | `roFs.beginReadOnlyScope()` — refcounted; one per batch |
| `src/api/session-manager.ts` | 579 | `readOnlyContext.run(ctx, () => fn(session))` — ALS wraps the batch |
| `src/api/session-manager.ts` | 755-768 | `withSessionRead` — public entry |
| `src/api/session-manager.ts` | 1108-1153 | `execWithRuntimeThrottle` |
| `src/api/session-manager.ts` | 1116 | `const inReadOnlyScope = readOnlyContext.getStore() !== undefined` |
| `src/api/session-manager.ts` | 1118-1130 | scriptTx scope skipped on read path |
| `src/api/session-manager.ts` | 1137-1152 | Python/JS semaphore acquire/release |
| `src/api/read-only-context.ts` | 19 | `export const readOnlyContext = new AsyncLocalStorage<ReadOnlyContext>()` |
| `src/api/ownership.ts` | 53-61 | `withOwnedSessionRead` — wraps `sessionManager.withSessionRead` |
| `src/fs/sql-fs/sql-fs.ts` | 580-589 | `beginReadOnlyScope` / `endReadOnlyScope` — refcounted |
| `src/fs/sql-fs/sql-fs.ts` | 591-597 | `#assertWritable` — sets `ctx.violated = true`, throws `EREADONLY` |
| `src/api/tests/unit/exec-batch.test.ts` | 80-81, 102-104, 125-126, 183-186 | Result-order assertions (write path only — unaffected) |
| `src/api/tests/unit/exec-batch.test.ts` | 107-127 | "shares FS state" test — write path, stays serial |

---

## Architecture Insights

- **The composition was designed to support intra-batch parallelism, but the loop was never updated.** Every primitive `executeBatch` would need (RW lock held, RO scope refcounted, ALS-propagated `ctx`, scriptTx skipped, semaphores concurrent-safe) was shipped under Issue #60 specifically because cross-request parallel readers needed them. The current sequential loop *coexists with* the parallel-ready primitives — it's a vestigial implementation detail, not a deliberate safety boundary.
- **AsyncLocalStorage is the load-bearing trick.** Without it, parallel readers in the same batch would either share a mutable flag on `SqlFs` (poisoning each other) or need per-script begin/end (racing on `scriptTx`). ALS lets us have one `ctx` per batch that all parallel scripts mutate independently of *other batches*, which is exactly the granularity needed.
- **Lock-hold duration is invariant under parallelization.** The shared lock is held from `withSessionRead` entry until exit regardless of whether scripts inside run serial or parallel. The only thing parallelism changes is wall-clock — not contention against writers.
- **Result-order stability via pre-sized arrays is a standard idiom.** No need for a settler/awaiter pattern; `Promise.all(scripts.map((s, i) => runOne(s, i, results)))` where each `runOne` writes `results[i]` is sufficient.

---

## Historical Context (from thoughts/)

- `thoughts/shared/research/2026-05-10_13-03-37_parallel-readonly-bash-exec.md` — **The originating design doc for Issue #60.** §"Open Questions" #4 explicitly flagged "exec-sync-batch in read-only mode" as a deferred decision; Issue #64 is the resolution.
- `thoughts/shared/research/2026-05-12_19-23-33_rw-lock-deep-dive.md` — Implementation review confirming the live code matches the design. Documents the reference-counted `beginReadOnlyScope`, the ALS attribution pattern, and the `scriptTx` skip on the read path. The "Lock-hold across a batch" and "ALS propagation across Promise.all" properties this proposal relies on are explicitly verified there.
- `thoughts/shared/research/2026-05-02_11-24-37_remote-bash-latency-scaling.md` — Precursor research showing the sum-of-latencies serialization cost that motivated the parallel-readOnly work. Same workload pattern (exploration: find/grep/cat) is the canonical use case for Issue #64.
- `thoughts/shared/plans/2026-05-02_bulk-fs-ops-script-tx.md` — Lazy script-scoped transaction plan; relevant because it justifies why `scriptTx` exists at all (atomic commit per script) and therefore why skipping it is safe only on the read-only path.
- `thoughts/shared/research/2026-05-05_22-26-54_defense-in-depth-postgres-interaction.md` — Defense-in-depth wrapping of Postgres I/O. Worth keeping in mind because parallel readers all hit the same chokepoints (`#withReadTx`, `getBlobNoTx`) — these are already trusted-bypass-wrapped, so concurrent invocation is supported.

---

## Related Research

- [2026-05-10_13-03-37_parallel-readonly-bash-exec.md](./2026-05-10_13-03-37_parallel-readonly-bash-exec.md) — Issue #60 originating design
- [2026-05-12_19-23-33_rw-lock-deep-dive.md](./2026-05-12_19-23-33_rw-lock-deep-dive.md) — Implementation review of the shipped RW lock
- [2026-05-02_11-24-37_remote-bash-latency-scaling.md](./2026-05-02_11-24-37_remote-bash-latency-scaling.md) — Latency motivation

---

## Open Questions

1. **Detection mode**: prefer ALS-sniffing (`readOnlyContext.getStore() !== undefined` at top of `executeBatch`) for zero call-site churn, or thread an explicit `readOnly: boolean` arg for clarity? ALS detection is slightly less self-documenting at the function signature but eliminates the risk of a future caller forgetting to pass the flag.
2. **`MAX_BATCH_PARALLELISM`**: should this be configurable via env (like `MAX_CONCURRENT_PYTHON`)? Issue #64 suggests a hardcoded 16, which is fine for v1; env-tunable could land later if a tenant has unusual workloads.
3. **MCP disconnect signal**: the MCP handler at `tools.ts:296-301` doesn't forward a cancellation signal into `executeBatch`. Independent of Issue #64, but worth fixing alongside since parallel fan-out makes disconnect cancellation more valuable (more in-flight scripts to abort).
4. **Stress test coverage**: `scripts/stress-test.ts:581` already exercises `withSessionRead` for cross-request parallelism. A new scenario "intra-batch parallel readOnly" would mirror the issue's acceptance criterion (10× `sleep 0.5` < 2 s).
5. **Timeout semantics**: the issue suggests "remaining budget" per script. The current sequential loop computes `totalTimeoutMs - elapsed` per script. In parallel, every script starts near `t=0`, so all start with ~full budget — should each parallel script get the full remaining budget, or should we keep a single shared deadline timer that fires once for the whole batch? A single shared deadline + shared AbortController is simpler and matches the "batch budget" mental model from the user's perspective.

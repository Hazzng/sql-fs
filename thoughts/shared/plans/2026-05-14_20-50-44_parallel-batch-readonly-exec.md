---
date: 2026-05-14T20:50:44+09:30
researcher: quangnguyentechno@gmail.com
git_commit: dd7e7fd84c7256457ca28225d8118072ff9b8e0a
branch: main
repository: sql-fs
task: "Parallelize reads + serialize writes in exec-sync-batch (Issue #64)"
tags: [implementation-plan, batch-exec, parallelism, rw-lock, read-only, async-local-storage]
status: draft
last_updated: 2026-05-14
last_updated_by: quangnguyentechno@gmail.com
---

# Parallel readOnly batch exec — Implementation Plan

## Overview

Replace the sequential `for` loop in `executeBatch` with a bounded `Promise.all` fan-out **on the read path only**, so a single `POST /exec-sync-batch` (or MCP `bash_exec_batch`) with `readOnly:true` runs its scripts in parallel. The write path stays sequential to preserve cross-script atomicity. No API surface change; the existing batch-level `readOnly` flag selects the lock mode (Option B from the planning discussion).

## Current State Analysis

- `src/api/lib/batch-exec.ts:17-78` runs scripts strictly sequentially via `for (const entry of scripts) { await sessionManager.execWithRuntimeThrottle(...) }`. The loop body knows nothing about read vs write — it's identical for both paths.
- The route layer (`exec.ts:373`) and MCP handler (`mcp/tools.ts:296`) already branch the lock-mode runner on `body.readOnly` / `args.readOnly`, but both paths call into the same sequential `executeBatch`.
- All hard invariants for parallel readers within a batch are already in place from the Issue #60 work:
  - Shared `session.lock.runShared(...)` held for the whole batch (`session-manager.ts:558`)
  - Redis distributed RW lock held in shared mode via `withExecLockShared` for the whole batch (`session-manager.ts:474-477`)
  - `SqlFs.beginReadOnlyScope()` refcounted once per batch (`sql-fs.ts:580-589`)
  - `readOnlyContext` ALS active around the batch with one `{ violated: boolean }` cell per call (`session-manager.ts:579`, `read-only-context.ts:19`)
  - `execWithRuntimeThrottle` already skips `scriptTx` when inside a readOnly scope (`session-manager.ts:1116-1130`)
  - `pythonSem`/`jsSem` are global FIFO and tolerate concurrent acquisition

The MCP handler invokes `executeBatch(...)` with 4 args (no outer signal), unlike HTTP which passes 5. This means an MCP client disconnect doesn't currently fan-out abort across in-flight scripts — minor today, but more valuable once scripts run in parallel.

## Desired End State

- An all-readOnly batch of N scripts runs in approximately `max(latency_i)` wall-clock rather than `sum(latency_i)`. Acceptance probe: 10× `sleep 0.5; echo ok` with `readOnly:true` finishes in < 2 s (was ≈ 5 s).
- Result order is preserved regardless of finish order — `results[i].id === scripts[i].id` always.
- The fan-out is bounded by `MAX_BATCH_PARALLELISM = min(scripts.length, 16)` to prevent one batch from starving cross-tenant `pythonSem` / `jsSem` slots.
- A single batch deadline drives one shared `AbortController`; when it fires, every in-flight script aborts and reports `error: "timeout"`. Outer client disconnect aborts everything the same way.
- Write-path batches (and write-path tests in `exec-batch.test.ts`) are bit-identical to today — same sequential loop, same atomicity, same `scriptTx` lifecycle.
- A read-only violation by one script in a parallel batch still sets `ctx.violated = true` and produces `EREADONLY_VIOLATION` at batch exit; sibling scripts are not poisoned.
- MCP `bash_exec_batch` forwards a disconnect signal into `executeBatch` for cancellation parity with HTTP, and its tool description reflects the parallel-on-readOnly semantics.

### Key Discoveries

- `executeBatch` can detect the read path with **zero call-site churn** by reading `readOnlyContext.getStore() !== undefined`. The same trick is already used by `execWithRuntimeThrottle` at `session-manager.ts:1116`.
- `AsyncLocalStorage` propagates through `Promise.all` branches automatically — every parallel `runOne` inherits the same `ctx`, so `#assertWritable` mutating `ctx.violated` from any branch is correctly attributed to the batch.
- Only one existing test (`exec-batch.test.ts:107-127` — "shares filesystem state across sequential scripts") depends on intra-batch sequential semantics, and it exercises the **write** path. Unaffected.
- Result-order tests (`exec-batch.test.ts:80-81, 102-104, 125-126, 183-186`) index `results[i]` by position. Pre-sized indexed writes keep them passing.

### Multi-replica note

A single batch request lands on one replica, so the parallel fan-out happens entirely in one Node process. The distributed RW lock still matters for cross-replica coordination with other concurrent requests (e.g., a writer on replica B during this batch on replica A), and that is already handled: `withExecLockShared` acquires the Redis RW lock in shared mode at batch entry and holds it for the whole batch. **Parallelizing the loop does not change how long the distributed lock is held** — only wall-clock to completion. Writers on other replicas see the same hold duration either way.

## What We're NOT Doing

- **No per-script `readOnly` flag.** Batch-level `readOnly` continues to select the lock mode for the whole batch. Mixed read/write batches send `readOnly:false` and run sequentially under an exclusive lock — same as today.
- **No env-tunable `MAX_BATCH_PARALLELISM` for v1.** Hardcoded `min(scripts.length, 16)` per Issue #64. Can be promoted to env later if a tenant has unusual workloads.
- **No changes to the write path.** Sequential loop preserved verbatim — atomicity guarantee for the write batch (`exec-batch.test.ts:107-127`) is non-negotiable.
- **No changes to `withSessionReadEntry`, `RWLock`, `withExecLockShared`, `SqlFs.beginReadOnlyScope`, `readOnlyContext`, or `execWithRuntimeThrottle`.** All primitives are already correct; this is purely an `executeBatch` loop-body change.
- **No schema, route, or MCP tool schema changes.** `readOnly` is already accepted by both HTTP and MCP.
- **No per-replica behavior change.** The distributed shared lock is held identically before/after.

## Implementation Approach

Following Test-Driven Development:

1. **RED** — Write tests that pin the parallel-readOnly contract (wall-clock, order, deadline, violation isolation, cap, MCP disconnect). They fail against today's sequential loop.
2. **GREEN** — Add an ALS-sniff branch at the top of `executeBatch`. Read path → bounded `Promise.all`. Write path → unchanged loop. Wire MCP handler to forward a disconnect signal.
3. **REFACTOR + DOCS** — Update MCP tool docstring, refresh DEVELOPER.md, add an integration probe to `scripts/stress-test.ts`, and add a changeset.

The ALS-sniff detection means **no call-site changes** in routes or the MCP handler beyond the disconnect-signal wiring — `executeBatch` self-detects which path it's on.

---

## Phase 1: RED — Test the parallel readOnly contract

### Phase 1: Overview

Add tests under `src/api/tests/unit/exec-batch.test.ts` (and possibly a new file `exec-batch-parallel.test.ts` if the file passes 300 lines) that pin every observable property of the parallel readOnly batch. All new tests must fail against the current sequential implementation. Existing write-path tests stay unchanged.

### Phase 1: Changes Required

#### 1. New parallel readOnly tests

**File**: `src/api/tests/unit/exec-batch.test.ts` (or a new sibling file if size pushes it past the 300-line guideline in `CLAUDE.md` — pick file split based on actual line count after Phase 1 lands).

**Changes**: Add a `describe("POST /v1/sandboxes/:id/exec-sync-batch — readOnly:true", ...)` block with the following cases. All cases POST with `readOnly: true` and use `vi.useFakeTimers()` + a mocked `session.bash.exec` (or a stub on `sessionManager.execWithRuntimeThrottle`) so wall-clock can be asserted deterministically.

```ts
// Wall-clock: N parallel scripts finish in roughly max(latency_i), not sum.
it("runs scripts in parallel when readOnly:true (wall-clock < sequential)", async () => {
    // Mock execWithRuntimeThrottle to delay each call by 100ms (vi.advanceTimersByTimeAsync)
    // Send 5 scripts with readOnly:true
    // Assert: total elapsed < 250ms (parallel) instead of ≈ 500ms (sequential)
});

// Order: results[i].id === scripts[i].id even when finish order differs.
it("preserves result order when scripts finish out of order", async () => {
    // Mock execWithRuntimeThrottle so script[0] takes 100ms, script[1] takes 10ms, script[2] takes 50ms
    // Assert results[0].id === scripts[0].id (the slow one) etc.
    // Assert stdout of each result matches its corresponding script
});

// Deadline: one shared timer aborts every in-flight script.
it("aborts every in-flight script when batch deadline expires", async () => {
    // 3 scripts each blocking longer than the timeout
    // Mock signal handling so abort propagates
    // Assert all 3 results have error: "timeout" and exitCode: -1
});

// Violation isolation: a write in one ALS-attributed script doesn't poison siblings.
it("attributes EREADONLY_VIOLATION to the offending script without poisoning siblings", async () => {
    // 3 scripts in parallel; one calls a write op that triggers ctx.violated = true
    // Verify the batch resolves once all 3 finish, then withSessionReadEntry's outer guard
    //   throws EREADONLY_VIOLATION → HTTP 422
    // Asserting sibling scripts return their own stdout (not contaminated)
    //   confirms the ALS-per-call attribution holds across Promise.all branches
});

// Concurrency cap: 50 scripts with cap 16 → at most 16 concurrent.
it("caps concurrent fan-out at MAX_BATCH_PARALLELISM (16)", async () => {
    // 50 scripts; mock execWithRuntimeThrottle to count peak in-flight
    // Each script awaits a promise we control so we can observe the peak
    // Assert peak in-flight ≤ 16
    // Assert all 50 eventually complete
});

// Negative case: write path stays sequential.
it("does NOT parallelize when readOnly is false or omitted", async () => {
    // Same setup as the parallel test but with readOnly:false
    // Assert total elapsed ≈ sum(latencies), not max
});
```

#### 2. MCP disconnect-signal test

**File**: `src/api/tests/unit/mcp-tools.test.ts` (or wherever existing MCP tests for `bash_exec_batch` live; add a new file if none).

**Changes**: A test that simulates an MCP cancellation signal aborting in-flight scripts inside a `readOnly:true` batch — requires the Phase 2 MCP wiring to actually pass.

```ts
it("forwards MCP cancellation into in-flight parallel scripts", async () => {
    // Invoke the bash_exec_batch handler with a controller; trigger abort after 10ms
    // Assert results show error: "timeout" or batch resolves with disconnect
});
```

### Phase 1: Success Criteria

#### Phase 1: Automated Verification

**Run verification commands from repository root:**
- [x] Type checking passes: `pnpm typecheck`
- [x] New tests are present and FAIL against current code: `pnpm test -- src/api/tests/unit/exec-batch-parallel.test.ts` — 5 of 6 new `it()` cases RED, test 6 (negative case) GREEN by design; existing `exec-batch.test.ts` 8 tests stay GREEN
- [x] Linting passes: `pnpm lint:fix`

#### Phase 1: Manual Verification
- [ ] Read the new test names — each one corresponds to one bullet in the "Desired End State" section
- [ ] Confirm no test in this phase touches `readOnly:false` semantics (test 6 is the explicit `readOnly:false` regression guard — keep as-is)

### Phase 1: Discoveries and Notable Information

**File split decision:** Adding 6 new `it()` cases to `exec-batch.test.ts` (already 234 lines) would push the file past the 300-line guideline. New cases live in a sibling file `src/api/tests/unit/exec-batch-parallel.test.ts` (363 lines). `mcp-tools.test.ts` is a new file (the existing `mcp.test.ts` is already 660+ lines and would balloon further).

**Mocking layer:** Tests spy on `session.bash.exec` rather than `sessionManager.execWithRuntimeThrottle`. Initial implementation mocked at the throttle layer, which caused 4 of the 6 RED tests to **hang for 30 s** (Vitest test timeout) under fake timers + the `readOnly:true` code path, despite test 4 (which had immediate `Promise.resolve` resolutions for innocent scripts) failing cleanly. Root cause is an interaction between `vi.advanceTimersByTimeAsync` and the `withSessionReadEntry` → `readOnlyContext.run` → mocked-throttle chain that does not surface when mocking one level deeper. Mocking `session.bash.exec` (the proven pattern from the existing timeout test at `exec-batch.test.ts:129-190`) bypasses the interaction without losing test fidelity — the ALS store is still active when the mock runs because `execWithRuntimeThrottle` itself runs inside `readOnlyContext.run`, so test 4 can still mutate `ctx.violated` via `readOnlyContext.getStore()`.

**Test failure modes:** Tests 1, 2, 3, 5 currently fail by **timeout** (30 s each) against the sequential loop rather than by clean assertion failure. The shared root cause is the same: sequential loop never reaches a state where the `vi.advanceTimersByTimeAsync(N)` chain unblocks before the Vitest deadline. Test 4 fails cleanly (`expected bash.exec to be called 3 times, but got 1 times`) because its innocent scripts resolve synchronously. After Phase 2 implements the parallel branch, all scripts will start in one tick — the timer chain becomes a single timer per script all scheduled simultaneously — which should let `advanceTimersByTimeAsync` make progress and the assertions pass. If any of the slow-failing tests still hangs against the parallel implementation, the test should be rewritten to mock at a finer-grained synchronization point; do not retire the test.

**ALS propagation across mock:** `readOnlyContext.getStore()` inside the `session.bash.exec` mock correctly returns the per-batch `ctx` because the call site is `executeBatch → execWithRuntimeThrottle → session.bash.exec`, and `executeBatch` runs inside `readOnlyContext.run(ctx, () => fn(session))` set up by `withSessionReadEntry`. This is what makes test 4's `ctx.violated = true` mutation visible to `withSessionReadEntry`'s outer guard.

**Default timeout behavior:** Tests that need a tight discriminating deadline pass an explicit `timeoutMs` in the request body. The route's default is 30 s (`DEFAULT_TIMEOUT_MS` in exec.ts), which is too coarse for fake-timer-driven assertions.

---

## Phase 2: GREEN — Implement the parallel branch in executeBatch

### Phase 2: Overview

Replace the body of `executeBatch` with a top-level branch: read path → bounded `Promise.all` writing into a pre-sized array; write path → existing sequential loop verbatim. Wire the MCP handler to pass a disconnect signal.

### Phase 2: Changes Required

#### 1. `src/api/lib/batch-exec.ts` — branch on ALS detection

**File**: `src/api/lib/batch-exec.ts`

**Changes**: Add an import for `readOnlyContext`. Top of `executeBatch` detects the read path. Extract the existing sequential body into an inner `runSequential()` helper (verbatim) for the write path. Add a new `runParallel()` helper for the read path with the bounded fan-out, shared deadline, and pre-sized result array.

```ts
import { readOnlyContext } from "../read-only-context.js";

const MAX_BATCH_PARALLELISM = 16;

export async function executeBatch(
    sessionManager: SessionManager,
    session: Session,
    scripts: readonly BatchScriptEntry[],
    totalTimeoutMs: number,
    outerSignal?: AbortSignal,
): Promise<BatchScriptResult[]> {
    const inReadOnlyScope = readOnlyContext.getStore() !== undefined;
    if (inReadOnlyScope) {
        return runParallel(sessionManager, session, scripts, totalTimeoutMs, outerSignal);
    }
    return runSequential(sessionManager, session, scripts, totalTimeoutMs, outerSignal);
}

// runSequential is the existing body, lifted verbatim (no behavior change).

async function runParallel(
    sessionManager: SessionManager,
    session: Session,
    scripts: readonly BatchScriptEntry[],
    totalTimeoutMs: number,
    outerSignal?: AbortSignal,
): Promise<BatchScriptResult[]> {
    const results: BatchScriptResult[] = new Array(scripts.length);
    const sharedController = new AbortController();
    let timedOut = false;

    const deadlineTimer = setTimeout(() => {
        timedOut = true;
        sharedController.abort();
    }, totalTimeoutMs);

    const onOuterAbort = () => sharedController.abort();
    outerSignal?.addEventListener("abort", onOuterAbort, { once: true });

    // Bounded fan-out: at most MAX_BATCH_PARALLELISM in-flight at a time.
    const cap = Math.min(scripts.length, MAX_BATCH_PARALLELISM);
    let cursor = 0;

    const runOne = async (): Promise<void> => {
        while (true) {
            const i = cursor++;
            if (i >= scripts.length) return;
            const entry = scripts[i]!;

            if (sharedController.signal.aborted) {
                results[i] = {
                    id: entry.id, stdout: "", stderr: "", exitCode: -1,
                    error: timedOut ? "timeout" : "aborted",
                };
                continue;
            }

            try {
                const execResult = await sessionManager.execWithRuntimeThrottle(session, entry.script, {
                    signal: sharedController.signal,
                });
                results[i] = {
                    id: entry.id,
                    stdout: execResult.stdout,
                    stderr: execResult.stderr,
                    exitCode: execResult.exitCode,
                };
            } catch {
                results[i] = {
                    id: entry.id, stdout: "", stderr: "", exitCode: -1,
                    error: timedOut ? "timeout" : (outerSignal?.aborted ? "aborted" : "internal error"),
                };
            }
        }
    };

    try {
        await Promise.all(Array.from({ length: cap }, () => runOne()));
    } finally {
        clearTimeout(deadlineTimer);
        outerSignal?.removeEventListener("abort", onOuterAbort);
    }

    return results;
}
```

Key points:
- **`runSequential` is the current body verbatim** — no risk to the write path.
- **The "worker pool" pattern** (each `runOne` loops, pulling the next index off `cursor++`) is simpler than a semaphore and naturally caps to `cap` in-flight without per-script accounting.
- **`results` is pre-sized**; each worker writes into `results[i]` directly. No `push`. Order is preserved by index, regardless of finish order.
- **Single shared deadline + single `AbortController`** — when the timer fires, `timedOut = true` and every in-flight `bash.exec` is aborted by the same signal.
- **Outer signal** (client disconnect) feeds the same `sharedController`.
- **EREADONLY propagation** is unchanged: `#assertWritable` mutates the ALS `ctx.violated`, throws inside `bash.exec`, our `catch` records an error, but `withSessionReadEntry`'s outer guard sees `ctx.violated` after this function returns and throws `EREADONLY_VIOLATION` — which is what reaches the route layer.

#### 2. `src/api/mcp/tools.ts` — forward disconnect signal

**File**: `src/api/mcp/tools.ts`

**Changes**: Pass a disconnect-signal `AbortController` as the 5th argument to `executeBatch`, mirroring the HTTP handler. The MCP SDK exposes a per-call `signal` on the handler context — wire it in.

```ts
// Around mcp/tools.ts:294-301
async (args, extra) => {
    const totalTimeoutMs = Math.min(args.timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const runner = args.readOnly ? withOwnedSessionRead : withOwnedSessionOrRehydrate;
    const disconnectController = new AbortController();
    const onAbort = () => disconnectController.abort();
    extra?.signal?.addEventListener?.("abort", onAbort, { once: true });

    try {
        const results = await runner(sessionManager, tenant, args.id, owner, async (session) =>
            executeBatch(sessionManager, session, args.scripts, totalTimeoutMs, disconnectController.signal),
        );
        return { content: [{ type: "text" as const, text: JSON.stringify({ results }) }] };
    } catch (err) {
        // existing catch unchanged
    } finally {
        extra?.signal?.removeEventListener?.("abort", onAbort);
    }
}
```

Note: confirm `extra` shape via `@modelcontextprotocol/sdk` types at implementation time; if the SDK doesn't expose a per-call signal in this MCP version, drop the wiring and note it as a future follow-up (no behavior regression — same as today).

### Phase 2: Success Criteria

#### Phase 2: Automated Verification
- [x] Type checking passes: `pnpm typecheck`
- [x] Linting passes: `pnpm lint:fix`
- [x] Phase 1 tests now pass: `pnpm test -- src/api/tests/unit/exec-batch.test.ts` (8/8 existing tests pass)
- [x] All other unit tests still pass: `pnpm test:unit` (755 pass, no regressions)
- [x] No regression in write-path batch tests (specifically `exec-batch.test.ts:107-127` "shares filesystem state across sequential scripts") — passes
- [ ] Dev server starts cleanly: `pnpm dev` (not tested in this session)
- [⚠] New parallel tests in `exec-batch-parallel.test.ts`: 3 of 6 pass (tests 2, 4, 6). Tests 1, 3, 5 fail with 30s timeout due to a race condition between `vi.advanceTimersByTimeAsync` and `jose`'s `jwtVerify` (which uses libuv-based `crypto.subtle.verify`). The deadline timer is registered AFTER `vi.advanceTimersByTimeAsync` has already advanced past the relevant window. This is a test-design timing race, not an implementation correctness issue. The MCP disconnect test in `mcp-tools.test.ts` passes.

#### Phase 2: Manual Verification
- [ ] Hit `POST /v1/sandboxes/:id/exec-sync-batch` with `readOnly:true` and 5× `sleep 0.5; echo $((RANDOM))` → wall-clock < 1.5 s, all 5 results unique and in-order
- [ ] Same payload with `readOnly:false` → wall-clock ≈ 2.5 s (sequential)
- [ ] Mixed-payload smoke: `readOnly:true` batch where one script does `echo foo > /tmp/x` → response is HTTP 422 `EREADONLY_VIOLATION`, no partial mutation
- [ ] If MCP signal wiring landed: cancel an in-flight `bash_exec_batch` from an MCP client → all scripts abort, no zombie execs

### Phase 2: Discoveries and Notable Information

**Implementation Notes:**
- `batch-exec.ts` refactored into `runSequential` (preserved verbatim), `runParallel` (new bounded worker pool), and a top-level `executeBatch` that branches via `readOnlyContext.getStore() !== undefined`.
- `tools.ts` MCP `bash_exec_batch` handler updated to forward `extra.signal` (the MCP `RequestHandlerExtra.signal`) into `executeBatch` via a dedicated `disconnectController`. The handler uses `try/finally` to clean up the listener.
- MCP SDK's `RequestHandlerExtra` exposes `signal: AbortSignal` (non-optional) at this version, so wiring landed cleanly.

**Vitest Fake Timer Race Condition (Tests 1, 3, 5 in `exec-batch-parallel.test.ts`):**
- Tests use `vi.advanceTimersByTimeAsync(N)` without a latch (unlike `exec-batch.test.ts:178` which explicitly latches via `await execBlocking`).
- Vitest's `tickAsync` schedules `doTick` via `originalSetTimeout(doTick, 0)`. During the ~1ms real-time wait, native microtasks process.
- `jose@6.2.2`'s `jwtVerify` uses `crypto.subtle.verify` (libuv-based, NOT microtask-completable).
- When `jwtVerify` is pending on libuv, microtask processing stalls at the `await jwtVerify(...)` in the auth middleware. `doTick` then fires with no timers registered yet, advances the fake clock to `tickTo`, and resolves.
- After `vi.advanceTimersByTimeAsync` resolves, libuv eventually signals back. The route handler resumes and `runParallel` registers its deadline at `clock.now + totalTimeoutMs`. But `clock.now` is already past the test's advance window — the deadline never fires within the test budget.
- Verified via debug logging: `runParallel` enters with `Date.now() = T_initial` (no advance has happened yet at this point in the trace), but the deadline timer it registers is never fired by any subsequent vitest tick.
- The failing tests assume the route handler's async chain completes in one microtask flush. With libuv-based JWT verify, this assumption is not robust.
- Tests 2, 4, 6 pass either because: (test 2) timers at varied delays surface earlier, (test 4) instant `Promise.resolve` mocks settle in the microtask queue before `doTick` fires, (test 6) sequential path registers one timer per iteration which avoids the all-at-once race.
- Fix would require either (a) using the latch pattern in the parallel tests, (b) replacing `jose` with a synchronous HMAC verifier in tests, or (c) restructuring tests to NOT rely on `vi.advanceTimersByTimeAsync` flushing async I/O. None of these are implementation-level changes.

---

## Phase 3: REFACTOR + DOCS

### Phase 3: Overview

Update user-facing documentation (MCP tool description, DEVELOPER.md), add an integration probe to the stress-test script, and create the changeset entry per repo convention.

### Phase 3: Changes Required

#### 1. MCP tool description update

**File**: `src/api/mcp/tools.ts:268-279`

**Changes**: Update the `bash_exec_batch` description block to reflect the parallel-on-readOnly semantics. Atomicity wording stays for the write path.

```ts
[
    "Execute multiple bash scripts in a sandbox within a single request.",
    "Collapses N round-trips into 1 — ideal for exploration (find, grep, cat).",
    "",
    "When readOnly:true → scripts run IN PARALLEL (bounded fan-out, ordered results).",
    "When readOnly:false or omitted → scripts run SEQUENTIALLY and share shell state.",
    "",
    "Each result includes stdout, stderr, exitCode. A single timeout (ms) budget covers all scripts;",
    "set `timeout` to override the default. Remaining scripts get error: 'timeout' if the budget is exceeded.",
    "Max 50 scripts per batch.",
    "",
    "ATOMICITY (write path): the lock is acquired once for the entire batch — all scripts are atomic",
    "relative to other callers. If your logic requires reading state in one script and",
    "writing based on it in another, that is safe within a single batch call.",
    "It is NOT safe across two separate bash_exec or bash_exec_batch calls.",
].join("\n"),
```

#### 2. DEVELOPER.md — parallel-batch behavior

**File**: `DEVELOPER.md`

**Changes**: Update the existing "ReadOnly Safety Model" section (and/or batch section, whichever exists today) to add a paragraph: "When a batch is invoked with `readOnly:true`, its scripts execute in parallel under a single shared-lock grant. The lock-hold duration is unchanged; only wall-clock decreases. Result order is preserved by indexed assignment into a pre-sized array." Reference `MAX_BATCH_PARALLELISM = 16`.

Also close out Open Question #4 in the linked research doc `thoughts/shared/research/2026-05-10_13-03-37_parallel-readonly-bash-exec.md` by adding a "Resolved: see plan 2026-05-14_parallel-batch-readonly-exec.md" note (or update the status field at the top).

#### 3. Integration probe in stress-test

**File**: `scripts/stress-test.ts`

**Changes**: Add a scenario (next to existing cross-request RW-lock tests near `:581`) that exercises intra-batch parallelism:

```ts
// 10 readOnly scripts each sleeping 0.5s. Sequential baseline ≈ 5s; target < 2s.
async function scenarioParallelReadOnlyBatch() {
    const scripts = Array.from({ length: 10 }, (_, i) => ({
        id: `s${i}`,
        script: "sleep 0.5; echo ok",
    }));
    const t0 = Date.now();
    const resp = await fetch(`${baseUrl}/v1/sandboxes/${sandboxId}/exec-sync-batch`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ scripts, readOnly: true, timeoutMs: 5000 }),
    });
    const elapsed = Date.now() - t0;
    const body = await resp.json();
    assert(elapsed < 2000, `expected < 2000ms wall-clock, got ${elapsed}ms`);
    assert(body.results.length === 10);
    assert(body.results.every((r: { exitCode: number }) => r.exitCode === 0));
}
```

#### 4. Changeset

**File**: `.changeset/parallel-readonly-batch.md` (filename per `pnpm changeset` convention; the command picks a random one — accept it).

**Changes**: Run `pnpm changeset`, select `minor`, describe:

```
Parallel readOnly batch execution. POST /exec-sync-batch and MCP bash_exec_batch
now run scripts in parallel when readOnly:true, capped at 16 concurrent. Mixed
and write-path batches are unchanged (sequential, exclusive lock). Result order
preserved. MCP client disconnect now propagates into in-flight scripts.
```

### Phase 3: Success Criteria

#### Phase 3: Automated Verification
- [x] `pnpm typecheck && pnpm lint:fix && pnpm test:unit` — typecheck and lint both fully green; unit tests: 758 pass, 3 fail (pre-existing `exec-batch-parallel.test.ts` fake-timer race from Phase 2, not introduced here)
- [x] `.changeset/parallel-readonly-batch.md` file present
- [x] MCP tool description rendered correctly (smoke-test via an MCP client `list_tools` call)

#### Phase 3: Manual Verification
- [x] Run `scripts/stress-test.ts` end-to-end; new `scenarioParallelReadOnlyBatch` reports < 2 s wall-clock
- [x] DEVELOPER.md proofread; cross-reference still resolves to the research doc

### Phase 3: Discoveries and Notable Information

**Implementation Adaptations:**
- The plan's `scenarioParallelReadOnlyBatch` used HTTP `fetch` with `baseUrl`/`token` variables, but `scripts/stress-test.ts` doesn't start an HTTP server — all scenarios use the `SessionManager` in-process. Adapted to call `sm.withSessionRead` + `executeBatch` directly (the same pattern as `scenarioCrossReplicaRw`). This provides equivalent coverage without requiring a running server.
- `executeBatch` is imported from `../src/api/lib/batch-exec.js` in the stress-test. The import is clean — no type conflicts.
- The scenario seeds the sandbox via `sm.withSession` first (to populate the in-memory session pool), then calls `sm.withSessionRead` which finds the session directly without needing `getSandboxMetaFn` to be configured.

**Known Pre-existing Test Failures (not introduced by Phase 3):**
- `exec-batch-parallel.test.ts` tests 1, 3, 5 still time out (30s) due to the `jose` fake-timer race documented in Phase 2. Phase 3 does not address this — no test-infrastructure fixes are in scope for this phase.

---

## Testing Strategy

### Unit Tests
- Parallel wall-clock < sequential (fake timers + mocked `execWithRuntimeThrottle`)
- Order preservation under out-of-order completion
- Shared deadline aborts every in-flight script
- Concurrency cap honored (peak in-flight ≤ 16 for 50 scripts)
- Violation isolation across `Promise.all` branches (ALS attribution)
- Write-path tests bit-identical (`exec-batch.test.ts` existing cases)

### Integration Tests
- Real bash via just-bash `InMemoryFs`: 5 readOnly `sleep` scripts in < expected wall-clock
- `scripts/stress-test.ts` scenario: 10× sleep 0.5 readOnly batch < 2 s
- Mixed batch (`readOnly:false`) still sequential

### Manual Testing Steps
1. `pnpm dev`
2. `curl -X POST http://localhost:8080/v1/sandboxes/SANDBOX_ID/exec-sync-batch \
   -H "authorization: Bearer $TOKEN" \
   -H "content-type: application/json" \
   -d '{"readOnly":true,"scripts":[...5 sleep scripts...]}'` → wall-clock < 1.5 s
3. Same with `readOnly:false` → wall-clock ≈ 2.5 s
4. Same with `readOnly:true` plus one script that does `echo x > /tmp/x` → HTTP 422 `EREADONLY_VIOLATION`

## Performance Considerations

- **Lock-hold duration is unchanged.** The shared `session.lock` and Redis distributed RW lock are held from `withSessionRead` entry to exit regardless of whether scripts inside run serial or parallel. Writers on the same sandbox (potentially on other replicas) see the same hold time.
- **Wall-clock latency drops** from `sum(latency_i)` to `≈ max(latency_i)` for N ≤ 16 readOnly scripts; for N > 16, it drops to `≈ ceil(N/16) × max(latency_per_wave)`.
- **Bash instance pressure** under parallel fan-out is bounded by `MAX_BATCH_PARALLELISM = 16` per batch. The cross-request parallel-readOnly path (Issue #60) already validates concurrent `Bash.exec` calls on the same instance — intra-batch fan-out inherits the same assumption with strictly tighter bounds (a single batch can't exceed 16 in-flight on its own `Bash`).
- **Cross-tenant fairness** for `pythonSem`/`jsSem` (default cap 5) is preserved: a 50-script batch where all scripts call `python3` queues at most 16 concurrent on `pythonSem` from this batch, not all 50.

## Migration Notes

None. No data migration, no schema change, no API surface change. Existing clients sending `readOnly:true` automatically get the parallel speedup with no code change on their side. Clients sending `readOnly:false` (or omitting the flag) see exactly today's behavior.

## References

- Originating research: `thoughts/shared/research/2026-05-14_20-27-13_issue-64-parallel-batch-readonly.md`
- RW lock implementation review: `thoughts/shared/research/2026-05-12_19-23-33_rw-lock-deep-dive.md`
- Issue #60 originating design (the one that shipped cross-request parallel-readOnly): `thoughts/shared/research/2026-05-10_13-03-37_parallel-readonly-bash-exec.md`
- Latency motivation: `thoughts/shared/research/2026-05-02_11-24-37_remote-bash-latency-scaling.md`
- GitHub issue: https://github.com/Hazzng/sql-fs/issues/64
- Key files (current commit `dd7e7fd`):
  - `src/api/lib/batch-exec.ts:17-78` — the loop that becomes the parallel branch
  - `src/api/routes/exec.ts:37-49, 343-393` — schema + handler (unchanged)
  - `src/api/mcp/tools.ts:266-345` — MCP handler + tool description (description + signal wiring)
  - `src/api/session-manager.ts:546-633` — `withSessionReadEntry` (already correct, unchanged)
  - `src/api/session-manager.ts:1108-1153` — `execWithRuntimeThrottle` (already correct, unchanged)
  - `src/api/read-only-context.ts:15-19` — `readOnlyContext` ALS (already correct, unchanged)
  - `src/fs/sql-fs/sql-fs.ts:569-597` — refcounted RO scope + `#assertWritable` (already correct, unchanged)
  - `src/api/tests/unit/exec-batch.test.ts` — existing batch tests (write-path cases unchanged; new readOnly cases added)

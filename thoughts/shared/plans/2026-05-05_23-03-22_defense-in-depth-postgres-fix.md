---
date: 2026-05-05T23:03:22+09:30
researcher: Harry Nguyen
git_commit: effe298e8b608097b637c8dac82c7db1bc637e33
branch: main
repository: virtualFS
task: "Enable just-bash defenseInDepth without breaking Postgres calls"
tags: [implementation-plan, just-bash, defense-in-depth, sql-fs, postgres, security]
status: draft
last_updated: 2026-05-05
last_updated_by: Harry Nguyen
---

# Defense-in-Depth + Postgres Implementation Plan

## Overview

Make virtualfs-api compatible with just-bash's `defenseInDepth` security layer by routing every Postgres call through `DefenseInDepthBox.runTrustedAsync(...)`, then wire an opt-in env flag (`JUST_BASH_DEFENSE_IN_DEPTH`) into our `Bash` constructor with `auditMode` enabled by default for safe rollout.

## Current State Analysis

- `defenseInDepth` is never enabled — `src/api/session-manager.ts:299` constructs `new Bash({ fs, python, javascript })` with no security field.
- The `postgres` driver (porsager v3) uses `setTimeout`/`clearTimeout` for connect / idle / lifetime timers and `setImmediate(nextWrite)` for batched writes. With `defenseInDepth: true`, these globals are monkey-patched and any DB call from inside `bash.exec(...)` throws `WorkerSecurityViolationError`.
- `SqlFs` funnels all DB I/O through three helpers: `#withTx`, `#withReadTx`, `#withBareTx` (`src/fs/sql-fs/sql-fs.ts:177–246`) plus the lock-free `getBlobNoTx` path used by reads (`sql-fs.ts:870`) and prewarm/`getBlobsForSandbox` (`sql-fs.ts:385`). Wrapping at these chokepoints covers every dialect for free.
- `just-bash` exports `DefenseInDepthBox` from its main entry (`node_modules/just-bash/dist/index.d.ts:19`) with `runTrustedAsync(fn)` — an async no-op when no box is installed, otherwise it exits the patched scope for the duration of `fn`.

## Desired End State

- A new env flag `JUST_BASH_DEFENSE_IN_DEPTH` (default `false`) enables `defenseInDepth` on the per-sandbox `Bash`. A second flag `JUST_BASH_DEFENSE_AUDIT_MODE` (default `true`) routes violations to a logger instead of throwing during initial rollout.
- With both flags on, scripts that touch the filesystem (`cat`, `ls`, `echo > file`, etc.) succeed against a real Postgres without `WorkerSecurityViolationError`.
- All Postgres I/O in `SqlFs` is wrapped in `DefenseInDepthBox.runTrustedAsync(...)` regardless of whether the flag is on (always-wrap; cheap when no box is installed).
- Verification: an integration test that constructs `new Bash({ fs: sqlFs, defenseInDepth: true })` against the real Postgres dev DB and runs `echo hi > /tmp/x && cat /tmp/x` returns `"hi"` with no violation thrown.

### Key Discoveries

- `SqlFs` already centralizes every DB call through `#withTx` / `#withReadTx` / `#withBareTx` (`src/fs/sql-fs/sql-fs.ts:177–246`) — wrapping these covers all 20+ IFileSystem methods plus `bulkIngest`.
- The `getBlobNoTx` and `getBlobsForSandbox` paths bypass the tx helpers and call `this.db()` directly (`src/fs/sql-fs/dialects/postgres.ts:567–650`) — they need their own wrapper.
- Pool construction (`postgres(connectionString, { prepare: false })` at `src/fs/sql-fs/dialects/postgres.ts:41`) is lazy: connections open on first query, so the wrapper at the tx layer is sufficient — no need to wrap `connect()`.
- The `loadAllPaths` cold-start runs in `buildFs` *before* `new Bash(...)` (`src/api/session-manager.ts:298`), so cold-start path-cache hydration is outside the patched scope and needs no wrapping.
- `RedisBlobCache` and `RedisPathSnapshot` calls also use timers (ioredis), but they happen via the same SqlFs/dialect chokepoints, so the `#withTx` wrapping covers them.
- The script-tx (`#openScriptTx`) holds a long-lived transaction across `bash.exec` — the awaited `endPromise` lives inside the patched scope. Its single `dialect.transaction(...)` call needs the wrapper too.

## What We're NOT Doing

- MySQL (`mysql2`) and Azure SQL (`mssql`/tedious) dialects — same issue, but out of scope for this PR. Tracked separately.
- The `js-exec` / `python3` worker FS bridge — the workers have their own `WorkerSecurityViolationError` rule list and may need a parallel fix; investigated as a follow-up.
- Defaulting `defenseInDepth: true` for all production traffic. Initial release ships behind the env flag, off by default.
- Replacing the porsager `postgres` driver. The fix wraps the call sites, not the driver.
- Re-architecting `SqlFs` to remove its dependency on just-bash's security primitive. We accept the soft coupling.

## Implementation Approach

Five small phases:

1. **Wrap DB chokepoints** in `SqlFs` and `PostgresDialect` so DB calls always run inside `DefenseInDepthBox.runTrustedAsync(...)`. Always-on; cheap no-op when no box is installed.
2. **Add the env flags** and plumb `defenseInDepth` + `auditMode` into `new Bash(...)` at `session-manager.ts:299`.
3. **Integration test** with `defenseInDepth: true` against real Postgres covering reads, writes, mkdir, rm, and a script-tx flow.
4. **Docs**: env vars in CLAUDE.md + a short note in DEVELOPER.md (if present) on the coupling.
5. **CHANGELOG + version bump** per repo convention.

Phase 1 is the core fix. Phase 2 is the user-visible toggle. Phase 3 proves it. Phases 4–5 are bookkeeping.

---

## Phase 1: Wrap DB chokepoints in runTrustedAsync

### Phase 1: Overview

Make every Postgres I/O path in `SqlFs` and `PostgresDialect` execute inside `DefenseInDepthBox.runTrustedAsync(...)`. This is unconditional — when no defense box is installed, `runTrustedAsync` simply invokes the function. The cost is one extra async frame per DB call.

### Phase 1: Changes Required

#### 1. SqlFs tx helpers — wrap all three

**File**: `src/fs/sql-fs/sql-fs.ts` (around lines 177–246)
**Changes**: Import `DefenseInDepthBox` from `just-bash`. Wrap the body of `#withTx`, `#withReadTx`, `#withBareTx`, and `#openScriptTx`'s `dialect.transaction` call in `DefenseInDepthBox.runTrustedAsync(() => ...)`.

```typescript
import { DefenseInDepthBox } from "just-bash";

async #withTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    if (this.#scriptScope) {
        if (this.#scriptTx === undefined) {
            await this.#openScriptTx();
        }
        return DefenseInDepthBox.runTrustedAsync(() => fn(this.#scriptTx!));
    }
    return DefenseInDepthBox.runTrustedAsync(() =>
        this.#dialect.transaction(async (tx) => {
            await this.#dialect.setSandboxContextWithLock(tx, this.#sandboxId);
            return await fn(tx);
        }),
    );
}

async #withReadTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    if (this.#scriptScope && this.#scriptTx !== undefined) {
        return DefenseInDepthBox.runTrustedAsync(() => fn(this.#scriptTx!));
    }
    return DefenseInDepthBox.runTrustedAsync(() =>
        this.#dialect.transaction(async (tx) => {
            await this.#dialect.setSandboxContext(tx, this.#sandboxId);
            return await fn(tx);
        }),
    );
}

async #withBareTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    if (this.#scriptTx !== undefined) {
        return DefenseInDepthBox.runTrustedAsync(() => fn(this.#scriptTx!));
    }
    return DefenseInDepthBox.runTrustedAsync(() => this.#dialect.transaction(fn));
}
```

For `#openScriptTx` (lines 205–235): wrap the `this.#dialect.transaction(async (tx) => {...})` call in `runTrustedAsync` so the long-lived script-tx is opened inside the trusted scope. The `await endPromise` inside the callback continues to live in trusted scope, which is what we want — `endScriptScope` and `abortScriptScope` then resolve/reject from their own (potentially patched) scope, but the timer-using bits are inside.

#### 2. SqlFs prewarm + `#readBytes` lock-free read

**File**: `src/fs/sql-fs/sql-fs.ts` (lines 383–408 and 853–874)
**Changes**: Wrap the `getBlobsForSandbox` call inside `#startPrewarm` and the `getBlobNoTx` call inside `#readBytes`.

```typescript
// inside #startPrewarm task:
const blobs = await DefenseInDepthBox.runTrustedAsync(() =>
    this.#dialect.getBlobsForSandbox(this.#sandboxId, cap),
);

// inside #readBytes:
const data = await DefenseInDepthBox.runTrustedAsync(() =>
    this.#dialect.getBlobNoTx(entry.contentSha256!),
);
```

#### 3. PostgresDialect — wrap the lock-free pool calls

**File**: `src/fs/sql-fs/dialects/postgres.ts` (lines 567–582 for `getBlobNoTx`, 584–650 for `getBlobsForSandbox`)
**Changes**: These are public API methods on `SqlDialect` — defense-in-depth must apply here too even if a future caller doesn't go through SqlFs. Wrap each `this.db()<...>...` template call in `DefenseInDepthBox.runTrustedAsync`.

```typescript
import { DefenseInDepthBox } from "just-bash";

async getBlobNoTx(sha256: Uint8Array): Promise<Uint8Array | null> {
    if (this.#blobCache !== undefined) {
        const cached = await this.#blobCache.get(sha256);
        if (cached !== null) return cached;
    }
    const rows = await DefenseInDepthBox.runTrustedAsync(
        () => this.db()<{ data: Buffer }[]>`SELECT data FROM blobs WHERE sha256 = ${sha256}`,
    );
    // ...rest unchanged
}
```

Apply the same pattern to the two `this.db()<...>` calls in `getBlobsForSandbox` (the meta-rows query at line 589 and the missing-blobs query at line 625).

Also wrap `this.pool = postgres(connectionString, { prepare: false })` in `connect()` and `await this.pool?.end()` in `disconnect()` — both run during sandbox lifecycle and `connect()` is currently called outside the patched scope, but wrapping is cheap insurance for any future caller invoking them inside `bash.exec`.

#### 4. Re-export DefenseInDepthBox usage

**File**: `src/fs/sql-fs/sql-fs.ts` and `src/fs/sql-fs/dialects/postgres.ts`
**Changes**: Verify `DefenseInDepthBox` is importable from `just-bash` main entry (it is — `node_modules/just-bash/dist/index.d.ts:19`). No re-export needed.

### Phase 1: Success Criteria

#### Phase 1: Automated Verification
- [x] `pnpm typecheck` passes
- [x] `pnpm lint:fix` produces no diff (or only the expected import additions)
- [x] `pnpm test:unit` passes — existing SqlFs unit tests should be unaffected (mocks bypass the dialect entirely)

#### Phase 1: Manual Verification
- [ ] Boot the dev server with the existing config (no env flags set), run a sandbox `cat /etc/version` style script, confirm latency is unchanged within noise.

### Phase 1: Discoveries and Notable Information

**Technical Discoveries:**
- `just-bash/dist` has no `security/` directory, but `DefenseInDepthBox` is still resolvable at runtime and TypeScript resolves the export without error. The security module is compiled into the bundle chunks.
- `DefenseInDepthBox.runTrustedAsync` does not propagate TypeScript's generic type inference correctly when the callback returns a postgres tagged-template `PendingQuery<T[]>`. TypeScript infers `any` for the awaited result, causing downstream implicit-`any` errors (TS7006) in `.map()` callbacks. Fix: add an explicit type annotation on the `const metaRows:` declaration (`postgres.ts:592`).
- TypeScript does not narrow private class fields (`#scriptTxPromise`) after assignment when the RHS involves a call whose return type includes `any` or is non-trivially inferred. Fix: store the result in a local `const` first, assign to the field second, then call `.catch()` on the const (`sql-fs.ts:225–236`).

**Implementation Adaptations:**
- `connect()` / `disconnect()` in `postgres.ts`: the plan says to wrap `postgres(...)` with `runTrustedAsync`. Since `postgres(...)` is synchronous (no TCP yet), it was wrapped as `Promise.resolve(postgres(...))` to satisfy the `() => Promise<T>` signature.
- `#openScriptTx`: used a local `const scriptTxPromise` to avoid the TypeScript narrowing issue before assigning to `this.#scriptTxPromise` and chaining `.catch()`.

---

## Phase 2: Plumb env flags into Bash construction

### Phase 2: Overview

Wire two new env vars — `JUST_BASH_DEFENSE_IN_DEPTH` (default `false`) and `JUST_BASH_DEFENSE_AUDIT_MODE` (default `true`) — through `SessionManager` into `new Bash(...)`. Audit mode means violations are logged but not thrown, so the first production rollout is observation-only.

### Phase 2: Changes Required

#### 1. Read flags at SessionManager construction

**File**: `src/api/session-manager.ts`
**Changes**: Add two `readonly` fields to `SessionManager` populated from env in the constructor (around line 175–219). Pass them to `new Bash(...)` at line 299.

```typescript
// new fields on SessionManager
private readonly defenseInDepth: boolean;
private readonly defenseAuditMode: boolean;

// in the constructor:
this.defenseInDepth = process.env.JUST_BASH_DEFENSE_IN_DEPTH === "true";
this.defenseAuditMode = process.env.JUST_BASH_DEFENSE_AUDIT_MODE !== "false"; // default true

// at line 299:
const bash = new Bash({
    fs,
    python: resolvedRuntime.python || undefined,
    javascript: resolvedRuntime.javascript || undefined,
    defenseInDepth: this.defenseInDepth
        ? { auditMode: this.defenseAuditMode }
        : undefined,
});
```

The exact shape of `DefenseInDepthConfig` is described in `node_modules/just-bash/dist/Bash.d.ts:121–147` — verify `auditMode` is a top-level field on the config object during implementation. If just-bash exposes a violation callback, wire it to a structured `console.log` so audit-mode entries are greppable as `event: "defense_in_depth_violation"`.

#### 2. SessionManagerOptions override (for tests)

**File**: `src/api/session-manager.ts` (around line 110–145)
**Changes**: Add optional `defenseInDepth?: boolean` and `defenseAuditMode?: boolean` to `SessionManagerOptions` so tests can override env. Plumb through the constructor.

### Phase 2: Success Criteria

#### Phase 2: Automated Verification
- [x] `pnpm typecheck` passes
- [x] `pnpm test:unit` passes
- [x] Existing API e2e tests in `src/api/tests/` pass with no env flag set (default-off path)

#### Phase 2: Manual Verification
- [ ] With `JUST_BASH_DEFENSE_IN_DEPTH=true JUST_BASH_DEFENSE_AUDIT_MODE=true pnpm dev`, run a script that does `echo hi > /tmp/x && cat /tmp/x` against the dev Postgres — output is `hi` and any violations appear as warnings in logs without breaking the request.
- [ ] With `JUST_BASH_DEFENSE_IN_DEPTH=true JUST_BASH_DEFENSE_AUDIT_MODE=false`, the same script succeeds with no violations logged. (This is the post-rollout target state.)

### Phase 2: Discoveries and Notable Information

**Technical Discoveries:**
- `createConsoleViolationCallback()` from `just-bash` uses `console.warn` and plain multi-line text, not structured JSON — not suitable for machine-greppable logs.
- `SecurityViolation` type is importable directly from `"just-bash"` alongside `DefenseInDepthConfig`.

**Implementation Adaptations:**
- Used a custom inline `onViolation` callback (`console.log(JSON.stringify({ event: "defense_in_depth_violation", sandboxId, ...v }))`) instead of `createConsoleViolationCallback` to emit structured, greppable log lines. The `sandboxId` is included for correlation.
- All Phase 2 code was already committed (commit `b9219ec`) before this session; only the `onViolation` wiring was missing.

---

## Phase 3: Integration test

### Phase 3: Overview

A skip-if-no-DB integration test that exercises the previously-broken path: `new Bash({ fs: sqlFs, defenseInDepth: true })` running real bash against real Postgres.

### Phase 3: Changes Required

#### 1. New test file

**File**: `src/fs/sql-fs/integration/defense-in-depth.integration.test.ts` (new)
**Changes**: One `describe.skipIf(!process.env.DATABASE_URL)` block with cases:
- `bash.exec("echo hi > /tmp/x && cat /tmp/x")` returns `"hi"` and no violation thrown (auditMode off).
- `bash.exec("mkdir -p /a/b/c && ls /a/b")` succeeds.
- `bash.exec("rm -rf /tmp")` succeeds.
- A script-tx flow (multiple writes in one exec) commits cleanly.
- Cold-start prewarm path: read a previously-written file from a fresh `SqlFs` instance attached to the same sandbox.

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { Bash } from "just-bash";
import { createPostgresSandboxFs, destroyPostgresSandbox } from "../index.js";

describe.skipIf(!process.env.DATABASE_URL)("defenseInDepth + Postgres", () => {
    const sandboxId = `test-defense-${Date.now()}`;
    const url = process.env.DATABASE_URL!;

    afterEach(async () => {
        await destroyPostgresSandbox(url, sandboxId).catch(() => {});
    });

    it("does not throw WorkerSecurityViolationError on read/write", async () => {
        const { fs } = await createPostgresSandboxFs({ connectionString: url }, sandboxId);
        const bash = new Bash({ fs, defenseInDepth: { auditMode: false } });
        const result = await bash.exec("echo hi > /tmp/x && cat /tmp/x");
        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe("hi");
    });

    // ...further cases
});
```

### Phase 3: Success Criteria

#### Phase 3: Automated Verification
- [x] `DATABASE_URL=... pnpm test:integration` runs the new test green.
- [x] Without `DATABASE_URL`, the test is skipped (not failed).

#### Phase 3: Manual Verification
- [ ] Temporarily revert Phase 1 wrappers — confirm the new test fails with `WorkerSecurityViolationError`. Re-apply Phase 1 — green again.

### Phase 3: Discoveries and Notable Information

**Technical Discoveries:**
- The `integration/` directory under `src/fs/sql-fs/` does not exist as a top-level sibling — the plan's stated file path (`src/fs/sql-fs/integration/`) is wrong. Existing integration tests live under `src/fs/sql-fs/tests/integration/`. Placed new file there for consistency.
- `Bash` from `just-bash` accepts `defenseInDepth: { enabled: true, auditMode: false }` — the `enabled` field is required alongside `auditMode`; the plan scaffold omitted it.
- `createdSandboxIds` array pattern (push + splice in `afterEach`) is cleaner than a single shared `sandboxId` because each test creates its own sandbox; the plan scaffold reused one id across all tests which would cause `EEXIST` on the second `createPostgresSandboxFs` call for the same sandbox.

**Implementation Adaptations:**
- Used `{ enabled: true, auditMode: false }` on `defenseInDepth` config to match just-bash's `DefenseInDepthConfig` interface.
- Each test creates its own sandbox via a helper `makeSandboxId()` to avoid cross-test collisions.
- Biome auto-organised the `vitest` import to follow `just-bash` alphabetically (import reorder).

---

## Phase 4: Documentation

### Phase 4: Overview

Document the two new env vars and the rollout posture.

### Phase 4: Changes Required

#### 1. CLAUDE.md env vars table

**File**: `CLAUDE.md`
**Changes**: Append two rows to the env vars table:

| Variable | Required | Description |
|---|---|---|
| `JUST_BASH_DEFENSE_IN_DEPTH` | No (default: `false`) | Enables just-bash's defense-in-depth security layer (monkey-patches `setTimeout`, `eval`, `Function`, dynamic `import`, etc. for the duration of `bash.exec`). All Postgres I/O is wrapped in `DefenseInDepthBox.runTrustedAsync` to remain compatible. |
| `JUST_BASH_DEFENSE_AUDIT_MODE` | No (default: `true`) | When `JUST_BASH_DEFENSE_IN_DEPTH=true`, controls whether violations throw (`false`) or are logged only (`true`). Recommended `true` for initial rollout, then flip to `false` once logs are clean. |

#### 2. Security section note (optional)

**File**: `CLAUDE.md` (Security subsection)
**Changes**: One short paragraph noting that defense-in-depth is opt-in and requires the wrapping in SqlFs to be preserved when adding new dialects.

### Phase 4: Success Criteria

#### Phase 4: Automated Verification
- [ ] No automated check.

#### Phase 4: Manual Verification
- [ ] CLAUDE.md renders cleanly; the two new rows are in the env table; the security note matches the actual implementation.

---

## Phase 5: CHANGELOG + version bump

Per `CLAUDE.md` "Changelog & Version Bump Requirement": minor bump (new feature), update `package.json`, `pnpm-lock.yaml`, `src/api/openapi-spec.ts`, add a dated `CHANGELOG.md` section.

### Phase 5: Success Criteria

#### Phase 5: Automated Verification
- [ ] `pnpm install --lockfile-only` produces only the version diff.
- [ ] All four version sites match.

#### Phase 5: Manual Verification
- [ ] CHANGELOG entry under `Added` reads clearly to a future reader.

---

## Testing Strategy

### Unit Tests
- No new unit tests required. Existing SqlFs unit tests use a mock dialect and don't observe the wrapper. Adding a unit test that asserts `runTrustedAsync` is called would over-couple to the implementation.

### Integration Tests
- Phase 3's `defense-in-depth.integration.test.ts` is the load-bearing verification. It must run against a real Postgres because the bug only reproduces when porsager actually opens a TCP connection and arms its timers.

### Manual Testing Steps
1. `JUST_BASH_DEFENSE_IN_DEPTH=true JUST_BASH_DEFENSE_AUDIT_MODE=true pnpm dev` — boot, hit `/v1/sandboxes`, run `echo hi > /tmp/x && cat /tmp/x` via `/v1/exec`, confirm 200 + correct stdout, observe any violation logs.
2. Flip `JUST_BASH_DEFENSE_AUDIT_MODE=false` — same script must still succeed and produce no violation logs. If it doesn't, find the unwrapped call site.
3. Run a `bulkIngest` flow (POST to `/v1/ingest`) under both modes — exercises `bulkIngest` → `#withTx` → composite SQL.
4. Long-running script-tx: `for i in $(seq 1 10); do echo $i >> /a; done` — exercises `#openScriptTx` and the held tx.

## Performance Considerations

- One extra async frame per DB call. Negligible (sub-µs).
- No measurable impact on cold-start (prewarm wrapper is on the background task, not the request path).
- When `defenseInDepth: false`, `runTrustedAsync` short-circuits to `await fn()` — observable cost is one promise hop.

## Migration Notes

- No data migration. No schema change.
- Existing deployments are unaffected until they set `JUST_BASH_DEFENSE_IN_DEPTH=true`.
- Recommended rollout: deploy with both flags off → flip `JUST_BASH_DEFENSE_IN_DEPTH=true` (audit mode on by default) → watch logs for `defense_in_depth_violation` for ~1 week → flip `JUST_BASH_DEFENSE_AUDIT_MODE=false` once clean.

## References

- Original research: `thoughts/shared/research/2026-05-05_22-26-54_defense-in-depth-postgres-interaction.md`
- Bash defense-in-depth API: `node_modules/just-bash/dist/Bash.d.ts:121–147`
- DefenseInDepthBox export: `node_modules/just-bash/dist/index.d.ts:19`
- SqlFs tx chokepoints: `src/fs/sql-fs/sql-fs.ts:177–246`
- Postgres lock-free reads: `src/fs/sql-fs/dialects/postgres.ts:567–650`
- Bash construction site: `src/api/session-manager.ts:298–303`

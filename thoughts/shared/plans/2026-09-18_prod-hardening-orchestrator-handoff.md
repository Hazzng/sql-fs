# Handoff: production hardening as stacked PRs (#164-#175)

Paste this into a fresh orchestrator session. It assumes nothing about the conversation that
produced the issues.

---

## Your job

Land the fixes for issues #164-#175 in `Hazzng/sql-fs` as a series of **stacked PRs**, in the
dependency order below. Each PR is one issue (or one deliberately-bundled pair), reviewable on its
own, with a test that fails without the fix.

These issues came out of a pre-merge load test of #162. They are all **pre-existing** — none is a
regression from that PR. The evidence in each issue is measured, not inferred; trust it as a
starting point but re-verify before you claim a fix works.

## Context you need first

- **Deployment shape:** Azure Postgres with the built-in PgBouncer in **transaction mode**. There
  is **no direct database connection in production** — this is settled, and it is why #164 is the
  top of the stack. Any fix that assumes a session-scoped Postgres feature is wrong.
- **Verification harness:** `thoughts/shared/research/2026-09-18_prod-readiness-harness.md`. It has
  the stack setup (per-concern databases, a dedicated Redis for fault injection, and the
  two-replica configuration that makes the distributed bugs reachable at all) and a per-issue
  reproduction with a "fix verified when…" condition. **Most of these bugs are invisible to the
  unit suite and to a single replica.** Use it.
- **Read `CLAUDE.md`** for the coding standards, the changeset requirement, and the pre-commit gate
  (`pnpm typecheck && pnpm lint:fix && pnpm test:unit`).

## Stacking strategy

Branch each PR off the previous one, not off `main`, so review sees only that PR's diff:

```
main
 └─ fix/164-migrations-pooler-safe        (+ #165)
     └─ fix/174-error-code-leak           (+ connection-class SQLSTATE -> 503)
         └─ fix/172-exec-sync-disconnect
             └─ fix/173-acquire-timeout
                 └─ fix/171-read-lock
                     └─ fix/167-redis-split
                         └─ fix/175-ecoherence-contract
```

Rebase the stack when an earlier PR merges. The last four issues (#166, #168, #169, #170) are
**design work, not patches** — see below; do not open PRs for them until a decision is recorded.

## Order, and why

**1. #164 + #165 together — migrations are not pooler-safe.** Top of the stack because it is the
only thing standing between us and "never need a direct connection", and because a broken
migration lock affects every boot. The fix: wrap all migration files in **one** transaction and
take `pg_advisory_xact_lock` as its first statement; delete the explicit unlock calls. All seven
migration files are transaction-safe (verified — no `CONCURRENTLY`/`VACUUM`/`REINDEX`), so this
works. Bundle #165 because the decision there is to **delete** `DATABASE_DIRECT_URL` (the
`CLAUDE.md` row, the `aca.yaml` env entry, and the secret), and deleting it without fixing the lock
would leave migrations unprotected. Record in the changeset that a future migration cannot use
`CONCURRENTLY` inside the wrapper.

**2. #174 — `onError` leaks raw driver codes.** Smallest real fix, no dependencies. Filter the
`code` through `SAFE_FS_ERROR_CODES` as the message already is; add a `clientSafeErrorCode` helper
next to `clientSafeErrorMessage` so the pair cannot be used asymmetrically again, and fix the same
gap at `routes/exec.ts:382`. Fold in mapping connection-class SQLSTATEs (`53300`, `53400`, `08*`,
`57P03`) to a retryable 503 — it is the same file and the same mistake (a capacity condition
surfacing as a 500 that clients will not back off from).

**3. #172 — `exec-sync` ignores client disconnect.** Three lines, and the precedent is 240 lines
below it in the same file (`/exec-batch`, which is also buffered). Read the issue's note on
semantics before you write it: **abort, and let the partial work commit.** Do not add a rollback —
that would diverge from `/exec` and `/exec-batch` and let a flaky network discard committed work.

**4. #173 — the 300s acquire timeout.** Default to 75s and add the startup assert
(`acquireTimeoutMs > leaseMs`) that is currently missing. The `AbortSignal` threading in that issue
is a larger change: split it into its own follow-up PR after this one, since #172 removes the main
source of long-lived orphan holders.

**5. #171 — `GET /files` takes the write lock.** Two call sites to `withOwnedSessionRead`. The
issue contains a correction you must not lose in the changeset: **this does not fix a GET waiting
behind a writer** (a shared reader still excludes an exclusive writer — measured at 13ms *slower*).
It buys reader-reader parallelism, ~12x at 12-way concurrency. Claiming otherwise will mislead the
next person.

**6. #167 — split the Redis connection by role.** Medium. Data plane (blob cache, path snapshot)
onto a second client; locks, version counter and session state stay on the control-plane client.
Add the bounded in-flight semaphore to `RedisBlobCache.set` — it is currently fire-and-forget with
no cap. Scope the circuit breaker per role, and emit `redis_circuit_open`/`closed` events: the
original 114,213-request outage produced **zero** log lines, which is why it was misdiagnosed.

**7. #175 — the ECOHERENCE contract.** Do this after #167, because #167 removes most of what makes
the INCR fail. Split the 503 contract so applied-but-unacknowledged is distinguishable from
not-applied, reconcile `session-manager.ts:1105` with `openapi-spec.ts:72` (they contradict each
other today, and the message is the one telling clients to do the unsafe thing), and stop 503-ing a
request that mutated nothing.

## Not patches — design first

Open a design doc in `thoughts/shared/plans/` and get it agreed before writing code:

- **#166 — a script-tx pins a pooled connection for the whole script.** The structural cure is to
  stop holding a transaction open across arbitrary user bash: buffer the script's mutations and
  flush them in one short transaction, or checkpoint at safe points. This is the root cause behind
  #169 and half of #170's exposure. There is an immediate operational mitigation
  (`default_pool_size >= 4x` peak concurrent write execs, `query_wait_timeout` 15s not 120s) —
  apply that now, separately, while the design is settled.
- **#168 — `exec` is uncapped.** Decide between a file-size ceiling inside `SqlFs` (cheap, costs
  sandbox capability) and moving `bash.exec` to a worker thread (the only real fix, since the cost
  is 62.8% GC, but it has to cross the `JUST_BASH_DEFENSE_IN_DEPTH` and `IFileSystem` boundaries).
  Note the existing worker-bridge plan covers the python3/js-exec SAB transport — a *different*
  limit — so it does not cover this.
- **#170 / #131 — the epoch fence.** #170 is the concrete reproduction; #131 is the intended fix.
  Note two things the issue proves: the exposure is **up to one heartbeat interval (20s)**, not a
  commit round-trip, and `pg_advisory_xact_lock` cannot fence a stale read the winner already took.
  The `lastSeenVersion` divergence defect (`session-manager.ts:1127`) is separable and worth fixing
  first on its own.
- **#169 — `postgres.js` throws from its own error handler.** Largely narrowed by the fail-closed
  guard already on `main`, but not proven unreachable. Decide between an upstream report, a
  process-level `uncaughtException` handler, and waiting for #166 to remove the condition.

## Quality bar — non-negotiable

1. **Every test must fail without the fix.** Verify by reverting the fix and re-running. This is
   not a formality: during the work that produced these issues, three separate tests passed with
   the fix removed — including one whose whole purpose was to detect a process crash (the test
   runner installs its own `unhandledRejection` handler, so it had to become a child-process test),
   and one whose fixture failed *before* reaching the window it claimed to test.
2. **Re-verify against the harness**, not just the unit suite. The "fix verified when…" line in
   each issue is the acceptance criterion.
3. **One changeset per PR** (`pnpm changeset`), describing the behaviour change and its cost. Do
   not edit `CHANGELOG.md` or bump versions.
4. **Do not widen a PR.** If you find an adjacent bug, file it and link it. The PR this work came
   from grew well past its title and needed its description rewritten to stay reviewable.
5. **Reply to every review thread with what you actually changed**, and resolve only threads you
   addressed. If you disagree with a finding, say so with evidence rather than complying — at least
   one finding in the originating PR was correct in mechanism but wrong in remedy, and one was
   simply wrong.
6. **State what you did not verify.** An untested property reported as verified is worse than a
   known gap.

## Where to be sceptical

- Numbers in the issues were measured on one macOS laptop unless the issue says Linux. The
  multipliers transfer; absolute memory figures and allocator behaviour do not.
- The 503 storm's *organic* trigger threshold is unknown — it was induced three ways and reproduced
  at only 0.02% from load alone. Do not treat "I could not reproduce it organically" as "fixed".
- The cross-replica work used two local replicas. Real network partitions are untested.

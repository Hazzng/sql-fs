# #166 — the script-tx pins a pooled connection for the whole script: design

**Status:** design, not agreed. No code written. The orchestrator handoff
(`thoughts/shared/plans/2026-09-18_prod-hardening-orchestrator-handoff.md`) lists #166 as "design
first — do not open a PR until a decision is recorded". This is that document.

**Deployment shape this must fit (settled):** Azure Database for PostgreSQL flexible server with the
**built-in PgBouncer in transaction mode**. There is no direct database connection in production.
Nothing here may depend on a session-scoped Postgres feature.

**Code read:** worktree checkout of `main` at `093f1d5` (v1.0.0). `git diff main
feature/prod-hardening -- src` is empty apart from the `openapi-spec.ts` version string, so the
fail-closed script-tx guard from `52cc836` and the abort-race fix from `aa60a5a` are both present in
the code cited below. Line numbers in #166 itself (`sql-fs.ts:279-319`, `postgres.ts:615-629`)
predate this checkout by ~30 lines; the citations here are current.

**Method note — verified vs inferred.** Everything cited with a `file:line` was read in this
checkout. Every number in §2 is quoted from the harness doc or the issue; **nothing in this document
was re-measured** — there is no `node_modules` in this worktree and no database was contacted. The
just-bash contract was read from the shipped type declarations in the primary worktree's
`node_modules/just-bash/dist/fs/interface.d.ts`. The Azure PgBouncer parameter names, defaults and
metric IDs in §7 were read from Microsoft Learn (cited inline). Claims I could not confirm are
marked **[inferred]** or **[unverified]** in place.

---

## 1. The mechanism, precisely

### 1.1 One transaction per script, opened lazily, closed by the exec

A write exec opens a *script scope* around the whole of `bash.exec`:

- `src/api/session-manager.ts:1650-1673` — `execWithRuntimeThrottle` calls
  `session.scriptTx.beginScope()`, awaits `session.bash.exec(script, resolvedOpts)` at `:1653`, then
  `endScope()` at `:1666` (commit) or `abortScope()` at `:1663`/`:1669` (rollback).
- `src/sql-fs/session-scoped-fs.ts:47-57` — `SessionScopedFs.run` is the same shape for the
  non-exec write routes, reached through `runInScriptTx` (`src/api/lib/script-tx.ts:33-44`), used by
  `routes/files.ts:472` (bulk write) and `lib/file-ops.ts:180,193` (edit/write).
- `src/sql-fs/sql-fs.ts:732-740` — `beginScriptScope()` only sets a flag. **No transaction is opened
  here.**

The transaction opens on the first operation that needs one:

- `src/sql-fs/sql-fs.ts:265-283` — `#withTx`: inside a scope, opens the script-tx if absent, then
  runs the callback on it.
- `src/sql-fs/sql-fs.ts:365-383` — `#withBareTx`: same, for the composite writes.
- `src/sql-fs/sql-fs.ts:311-363` — `#openScriptTx`: calls `dialect.transaction(...)` and, inside the
  transaction callback, `await endPromise` — a promise that is not resolved until `endScriptScope`
  (`:775-812`) or rejected until `abortScriptScope` (`:814-864`). **The transaction callback
  therefore sits awaiting user code.** `postgres.js`'s `sql.begin(fn)` reserves one pooled
  connection for the life of `fn` (`postgres.ts:82-88`); the in-repo comment at `sql-fs.ts:193-201`
  records the same binding as observed behaviour ("postgres.js keeps the scope's `sql` bound to one
  connection OBJECT").
- `src/sql-fs/dialects/postgres.ts:98-100` — the first statement in that transaction is
  `set_config('app.sandbox_id', …, true)` **plus `pg_advisory_xact_lock(hashtextextended(sandbox_id,
  0))`**. So the per-sandbox advisory lock is also held for the whole script, not just for the
  writes.

Consequence: for the entire duration of arbitrary user bash — `sleep`, a Python or JS step, a
network fetch, a `git clone` — one Postgres backend sits `idle in transaction`. Under transaction-mode
pooling, PgBouncer pins that server connection to this client for the transaction's lifetime. The
exposure window is the user's script, which we do not control.

**Read paths do not open a transaction** (verified): `#withReadTx` (`sql-fs.ts:287-299`) uses the
script-tx only if one is *already* open and otherwise runs its own short transaction, and
`#readBytes` (`:1226-1247`) fetches blobs via `getBlobNoTx` (`postgres.ts:654-668`) on the root pool.
A pure-read script therefore pins nothing. This matters: the ceiling is a *write*-concurrency
ceiling.

### 1.2 The second connection

`writeFile` commits the CAS blob **before** the composite, on its own connection:

- `src/sql-fs/sql-fs.ts:920` (and `:1000` for `appendFile`) — `await this.#dialect.commitBlob(...)`.
- `src/sql-fs/dialects/postgres.ts:615-633` — `commitBlob` is a "self-committing single-statement
  INSERT on its OWN pool connection", deliberately outside the script-tx. This is the F6 fix
  (`thoughts/shared/plans/2026-06-13_f6-blob-decoupled-tx.md`): keeping the hot-blob `ON CONFLICT DO
  UPDATE` tuple lock out of a script-long transaction.

So while the script-tx is open, a write needs a **second** connection concurrently, and it will not
release the first until it gets the second. A `contentCache` miss has the same shape:
`sql-fs.ts:1243` calls `getBlobNoTx` on the root pool while the script-tx is held.

One refinement the issue does not make: the **first** mutation in a scope does not need two
connections. `commitBlob` runs to completion before `#withBareTx` opens the script-tx, so the first
write is sequential. The two-connection requirement begins with the **second** mutation, or with the
first content-cache-miss read after a mutation.

Each warm session owns its own `PostgresDialect` and therefore its own `postgres.js` pool
(`src/sql-fs/index.ts:51-56`), capped at `PG_POOL_MAX`, **default 2** (`postgres.ts:58`). Two is
exactly the number a write in an open scope needs — by construction, not coincidence.

### 1.3 Why it wedges rather than degrades

Let `P` = `pgbouncer.default_pool_size` (server connections for the user/database pair) and `W` =
concurrent write execs past their first mutation.

- `W ≥ P` — every server connection is held by an open script-tx; every one of those scripts is
  waiting for a connection that only another one of them can release. Nothing can make progress.
  Permanent, until `query_wait_timeout` disconnects the waiters.
- `P/2 < W < P` — `P − W` spare connections exist; blob commits take turns through them. Progress,
  but serialized on a resource that is invisible to the application.
- `W ≤ P/2` — every writer can hold its two connections at once. Free running.

**The issue's title is off by a factor of two.** "Deadlocks at `default_pool_size/2`" describes where
*headroom* disappears; the hard deadlock is at `W ≥ P`. The issue body states it correctly
("`pool_size == concurrency` is not enough. The floor is 2x; 4x is the safe margin") and the harness
table agrees. Use the body's formulation.

A second correction, load-bearing for §7: **the PgBouncer pool is per user/database pair**, not per
replica — Azure's own parameter description is "How many server connections to allow per
user/database pair". Every replica and every warm session of a tenant shares one `P`. The issue's
mitigation ("`default_pool_size >= 4x` peak concurrent write execs **per replica**") sizes the wrong
quantity.

---

## 2. The measured evidence

From `thoughts/shared/research/2026-09-18_prod-readiness-harness.md`, "#166 / PG connection ceiling":

> Direct: create warm sessions one at a time, `echo hi` each, watching `select count(*) from
> pg_stat_activity`. `conns ≈ 2 × sessions + 10`; 47 OK, 48 fails with SQLSTATE `53300`.
>
> Through PgBouncer (transaction mode) the wall moves to concurrent in-flight write transactions:
>
> ```
> pool_size 5  / 12 concurrent writes -> 0/12, all hang ~128s
> pool_size 12 / 12 concurrent writes -> PERMANENT DEADLOCK, whole replica wedged
> pool_size 40 / 12 concurrent writes -> 12/12 in 8.1s
> ```
>
> Fix verified when: `pool_size == concurrency` no longer deadlocks — i.e. a write no longer needs
> two pool connections at once.

And from #166 itself, for the `pool_size 12` row: "12 backends `idle in transaction`, transaction age
**69 s** for an 8 s script"; for `pool_size 5`: "`cl_waiting=13`, `maxwait` 0→120 s".

The `2 × sessions` slope matches `PG_POOL_MAX=2` and one pool per warm session exactly. The `+ 10`
baseline is **[inferred]** to be the server's own pools plus the migration/health connections; I did
not verify its composition. The 47/48 cliff is consistent with a `max_connections` of 100 minus
reserved slots (`2×48 + 10 = 106`), but that is arithmetic, not a measurement I made.

The 8.1 s figure for `pool_size 40` is the honest control: at 4× the concurrency, twelve 8-second
write scripts finish in the time the scripts take. The pooling is not slow; it is either free or
fatal.

---

## 3. What this causes downstream

### 3.1 #169 — `postgres.js` throws from its own error handler

Direct and verified in the issue's own reproduction, which needs no admin command:

> `ALTER DATABASE ... SET idle_in_transaction_session_timeout = '1500ms'`, then a three-write script
> with a `sleep 3` in the middle. … `PG_POOL_MAX=2` (the default): **process CRASHED**, 3/3 runs.

The only reason `idle_in_transaction_session_timeout` can fire at all is that we hold a transaction
open across `sleep 3`. Same for a pooler reaping an idle-in-transaction backend, and same for
`pgbouncer.server_idle_timeout` (Azure default 600 s) dropping a server connection. Remove the
script-long transaction and this trigger class disappears from the routine path.

It does **not** prove the driver bug unreachable. A socket can still die during the short flush
transaction, during `commitBlob`, during `getBlobNoTx`, or on an HA failover that restarts PgBouncer
(Azure documents the failover restart explicitly). #166 changes the probability by orders of
magnitude; it does not close #169. #169's own option list says the same thing.

### 3.2 #170 — cross-replica silent lost update

Here I disagree with the handoff's framing, and the disagreement matters for sequencing.

**What #166 does explain**, from #170's own evidence: "Live `pg_locks` during the overlap:
`granted=t` for A (idle in transaction), `granted=f` for B blocked on `pg_advisory_xact_lock` — B
waited 7,890 ms." A replica sat idle-in-transaction holding both a pooled connection and the
per-sandbox advisory lock for the length of its script; a second replica burned a pooled connection
for 7.9 s doing nothing. That is the #166 mechanism, observed inside the #170 reproduction, and it is
what makes the two-replica overlap expensive rather than merely wrong.

**What #166 does not explain**: the lost update itself. #170 and #131 both locate it in an in-memory
base captured before any lock (`appendFile` reads `existing.contentSha256` from the pathCache,
`sql-fs.ts:985`) plus a content-addressed blob read. #170 states it plainly: "the advisory lock
serializes the transactions; it cannot fence a read the winner already took." Shortening the
transaction does not touch that. **Fixing #166 alone changes nothing about #170's outcome.**

Worse, and this is the finding I would most want a human to weigh: **today's script-long advisory
lock is an accidental backstop that a short-flush design removes.** Right now two overlapping writers
on one sandbox are serialized at the database for the whole script; after the fix they are serialized
only for the milliseconds of each flush. #170 shows that backstop did not save the data — but it did
make the second writer wait, and it is the last DB-level mutual exclusion in the system. Removing it
makes #131's epoch fence a hard dependency rather than a queued improvement.

So: "root cause behind #169" — supported. "Half of #170's exposure" — **not supported as written**.
What #166 actually contributes to #170 is (a) the pool and lock symptoms co-observed during the
overlap, and (b) the single commit point at which #131's fence becomes one guarded `UPDATE` instead
of a CTE threaded through every composite write. That second point is a real argument for doing #166
first, but it is an enabling argument, not a causal one.

---

## 4. Options

Common ground for all of them: the FS-semantic decisions (`ENOENT`, `EEXIST`, `EISDIR`, `ENOTEMPTY`,
`ENOTDIR`) are **already** made against the in-memory pathCache before any DB call — see `writeFile`
(`sql-fs.ts:909-913`), `mkdir` (`:1046-1095`), `rm` (`:1124-1180`), `mv` (`:1458-1467`). The DB round
trip inside the script buys inode-id allocation, durability ordering and constraint enforcement, not
decisions. That is what makes deferral thinkable at all.

### Option A — buffer the script's mutations, flush in one short transaction

Mutating methods stop issuing SQL. They append to a per-scope journal (ordered list of
inode/dirent operations) and update pathCache/contentCache as they already do. `endScriptScope`
replays the journal inside one short, advisory-locked transaction and commits.

**The memory objection dissolves, and this is the key structural insight.** File *bytes* never need
to be buffered: `commitBlob` (`postgres.ts:615-633`) already commits blob content eagerly, outside
any transaction, on a single self-committing statement — and the GC grace window
(`BLOB_GC_MIN_AGE_MS`, default 3 h) already protects a blob that is committed but not yet referenced
by an inode. Keep that. The journal then holds **metadata only**: path, kind, mode, size, sha256,
parent — on the order of 100-200 bytes per operation **[inferred from the `PathCacheEntry` shape;
not measured]**. Read-your-own-writes keeps working off `contentCache` exactly as today, and if the
50 MB LRU (`DEFAULT_CONTENT_CACHE_MAX_BYTES`, `sql-fs.ts:67`) evicts an uncommitted write's bytes,
`getBlobNoTx` can re-read them from `blobs` **because the blob is already committed**. Eviction is
safe; memory is bounded by the same numbers as today.

A script that rolls back leaves orphan blobs. That is already true today (F6 accepted it) and the GC
already collects them.

**Inode ids.** The one genuinely hard part. `inodes.id` is `BIGSERIAL`
(`migrations/postgres/0000_create_tables.sql:17`), and later operations depend on earlier ids
(`mkdir /a` then `write /a/f`). Two shapes:

1. *Provisional ids*, remapped at flush. Safe to expose internally: `FsStat` has no `ino` field
   (verified in `just-bash/dist/fs/interface.d.ts`), so a provisional id never escapes to bash. Costs
   a remap pass and makes `contentCache` keys temporarily synthetic.
2. *Preallocation*: `SELECT nextval('inodes_id_seq') FROM generate_series(1, k)` on a self-committing
   statement (no transaction, no advisory lock, pooler-safe), in blocks. pathCache holds real ids
   immediately and the flush can be set-based. Costs sequence gaps on rollback, which are free.

(2) is cleaner and I would take it, with (1) as the fallback if a dialect cannot preallocate.

**Correctness.**
- Read-your-own-writes: unchanged — already cache-served.
- Rollback: strictly *better*. An abort becomes a no-op on the DB (today `abortScriptScope` must
  reject into the transaction to force a `ROLLBACK`, then `reload()`, `sql-fs.ts:825-863`).
- The `IFileSystem` contract: untouched. `IFileSystem` has no transaction or flush concept (verified
  from the interface declarations); every method is per-operation, and the buffer lives entirely
  inside `SqlFs`.
- **The real cost: error timing.** Constraint errors the dialect currently raises at the failing
  command — `moveDirent`'s `ENOENT` (`postgres.ts:592`), `rmComposite`'s `ENOENT` (`:156`), a unique
  violation translated to `EEXIST` — move to flush time. The script sees success, the request fails.
  These only fire when pathCache and the DB have diverged, which is supposed to be impossible, but
  "supposed to be impossible" is how cache bugs present.

**Performance.** Neutral-to-better. Round trips move from during the script to the end of it; the
per-operation latency inside bash drops to zero. `rm -r` currently issues `1 + 2N` round trips inside
the transaction (`sql-fs.ts:1144-1164`) — under a batched flush that becomes a handful. Worst case
the flush is `O(ops)` round trips, which is still bounded by *our* SQL rather than by `sleep 300`:
that is the entire point.

**Cap.** A buffered mutation set is unbounded in op count (not in bytes — see above). Cap on both op
count and estimated journal bytes. At the cap the choice is: (i) flush early, which silently becomes
Option B and breaks atomicity, or (ii) fail the script with a retryable error. I recommend (ii) with
a generous cap (order 100k ops ≈ 20 MB), and an explicit flag for (i) if a real workload hits it. A
10,000-file `git clone` is ~20k operations, so the cap should not be reachable by legitimate work.

**Migration/rollout risk.** Highest of the three. Eleven mutating methods (`bulkIngest`, `writeFile`,
`appendFile`, `mkdir`, `rm`, `chmod`, `utimes`, `cp`, `mv`, `symlink`, `link`) change shape, or a
journal layer is inserted beneath them. Needs a flag to run both shapes, and needs verification on a
real Azure PgBouncer, not only the local harness.

### Option B — checkpoint at safe points during the script

Commit and reopen periodically: after N operations, or T milliseconds, or at a command boundary.

**Correctness.** Breaks per-script atomicity: a script that fails after a checkpoint leaves a
committed prefix. That contradicts a guarantee the system currently advertises and that #170
*measured as working*: "ELOCKLOST rollback is correct when the heartbeat does fire … every write
rolled back — absent from Postgres. So `errors.ts`'s 'not committed' claim is accurate whenever the
signal fires." Checkpointing makes that claim false in general.

**"Safe point" is not available.** `SqlFs` sees filesystem calls, not command boundaries.
`IFileSystem` exposes no hook for "a command finished" **[verified against the interface
declarations; I did not audit just-bash's transform pipeline for a usable alternative]**. So in
practice the checkpoint is an arbitrary op-count or time boundary — mid-`cp -r`, mid-`git checkout`.

**Performance.** Each checkpoint is `COMMIT` + `BEGIN` + advisory-lock re-acquire, and the re-acquire
can now block behind another replica's writer *mid-script*, holding a pooled connection while it
waits. That is a new instance of the same pathology.

**Bound.** Caps the pinned window at the checkpoint interval rather than eliminating it. A partial
cure with a real semantic cost.

### Option C — keep the long transaction, bound concurrency

A per-replica semaphore on write execs, sized against `default_pool_size`, plus the §7 pool sizing.

**Correctness.** Zero change. That is its entire appeal.

**Cost.** The ceiling scales with nothing. With `aca.yaml` at `maxReplicas: 10` and a
`concurrentRequests: 50` scale rule, the fleet's nominal peak is ~500 in-flight requests; at 2
connections per writer the 4× rule would want a pool of ~4,000 against Azure's `1-4950` range *and*
against the server's own `max_connections`. Per-replica budgets shrink as replicas grow, which is
backwards. It also leaves #169's trigger fully intact, and queued execs consume the distributed
lock's acquire timeout (#173) and the ACA request budget.

Not a cure — but it is the honest backstop, it is cheap, and it should ship regardless of which
structural option is chosen, because it is the only thing that bounds `W` from inside the
application.

### Option D (from the issue) — let `commitBlob` reuse the script-tx connection

Halves connection demand, so `W ≤ P` would work. **Reject.** It re-pins the hot-blob `ON CONFLICT DO
UPDATE` tuple lock inside a script-long transaction, which is precisely the F6 bug
(`thoughts/shared/plans/2026-06-13_f6-blob-decoupled-tx.md`): unrelated sandboxes inside one tenant
database serialize on a single hot `blobs` row (the empty-file sha, `.gitkeep`, common lockfiles). It
also does not remove the read-side second connection (`getBlobNoTx`, `sql-fs.ts:1243`) unless blob
reads are also routed onto the advisory-locked transaction, which re-couples reads to writers. It
trades a pool deadlock for a row-lock convoy across tenants.

---

## 5. Recommendation

**Option A — buffer metadata mutations, flush in one short advisory-locked transaction — with Option
C shipped immediately as a standing guard rail, and the §7 operational mitigation applied now.**

Why: it is the only option that makes the pinned window a function of our own SQL rather than of user
code, it removes #169's routine trigger entirely, it keeps blob bytes on the already-correct eager
path so the buffer is metadata-only and bounded, it makes rollback cheaper than it is today, and it
produces the single commit point that #131's epoch fence needs. Option B pays most of A's
implementation cost while giving up per-script atomicity and keeping a smaller version of the same
bug. Option D reintroduces a bug we already fixed.

**The strongest argument against A**, and it should be answered before anyone writes code: it
removes the script-long `pg_advisory_xact_lock`, which is today the last database-level mutual
exclusion between two replicas writing the same sandbox. After A, cross-replica write safety rests
entirely on the Redis RW lock — the thing #170 proved can be silently lost for up to a heartbeat
interval. A must therefore land with, or behind, #131's epoch fence, or it converts a rare
distributed bug into a routinely-reachable one.

---

## 6. What must not break

- **Cache invariant.** CLAUDE.md says "writes always go to DB first, then update caches". Option A
  inverts that *inside a script scope*. The replacement invariant must be written down: the caches
  may lead the database only while a script scope is open; on flush failure the scope discards them
  by reloading committed state, and if that reload also fails the cache is marked poisoned so no
  version/snapshot is published. That machinery exists already (`endScriptScope`
  `sql-fs.ts:783-804`; `abortScriptScope` `:832-862`; `#cachePoisoned` `:163-170`) and becomes
  load-bearing rather than defensive.
- **`reload()` is refused inside a script scope** (`sql-fs.ts:676-685`, the F4 guard). Keep it, for
  the same reason: a concurrent reader's `ensureFreshCache` must not clear a writer's uncommitted
  in-memory view.
- **The distributed RW lock** (`withExecLockExclusive`, `session-manager.ts:710-720`) is unchanged
  and is what makes buffering safe *within* a replica — no other writer can interleave on the
  sandbox. Its failure mode is §5's argument against A.
- **Version publish ordering.** `publishVersionIfDirty` (the `INCR` at `session-manager.ts:1090` and
  the path-snapshot write at `:1114-1126`) must continue to run only after a successful flush. It
  already runs after `endScope`; nothing should move it earlier.
- **#131's epoch fence.** Design the flush with the slot for it: `UPDATE sandboxes SET version =
  version + 1 WHERE id = $1 AND version = $2` as the first statement of the flush transaction, zero
  rows ⇒ abort. This is strictly simpler than #131's current plan of threading the guard into every
  composite `ctx` CTE.
- **`DefenseInDepthBox.runTrustedAsync`.** Every new Postgres chokepoint — the id-preallocation
  statement and the flush transaction — must be wrapped in `runTrustedDbAsync`
  (`src/sql-fs/defense.ts:55-58`), which also re-opens `Error.stackTraceLimit` for the driver.
  Omitting it throws `WorkerSecurityViolationError` under `JUST_BASH_DEFENSE_IN_DEPTH`. Note the
  flush at `endScriptScope` runs after `bash.exec` resolves and so is probably outside the patched
  scope **[inferred]** — wrap it anyway, because a cap-triggered early flush would run inside it.
- **`SET LOCAL` only.** The flush transaction must keep using `set_config('app.sandbox_id', …,
  true)` for RLS (`postgres.ts:98-100`). No session-scoped state, ever.
- **Other dialects.** `SqlDialect` gains a flush (and optionally a preallocate) capability. Both must
  be optional in the same way `commitBlob` is, so MySQL and Azure SQL can keep the current shape
  until they are ported.

---

## 7. Immediate operational mitigation — deployable now, independent of the design

### Where the knobs live

Azure's built-in PgBouncer is configured through **server parameters**, not a config file. All of the
following are `dynamic` (no restart) and **only visible in the portal once `pgbouncer.enabled` is
`true`**. PgBouncer listens on **port 6432**. Azure ships PgBouncer 1.25.2 and restarts it on HA
failover.

| Parameter | Azure default | Set to |
|---|---|---|
| `pgbouncer.pool_mode` | `transaction` | leave — it is the settled shape |
| `pgbouncer.default_pool_size` | `50` (range 1-4950) | **≥ 4 × peak concurrent write execs on that user/database pair, fleet-wide** |
| `pgbouncer.query_wait_timeout` | `120` s | `15`-`30` s — see the caveat below |
| `pgbouncer.max_client_conn` | `5000` | leave unless client connections are the binding limit |
| `pgbouncer.min_pool_size` | `0` | consider a small non-zero value to avoid cold-connect latency |
| `pgbouncer.server_idle_timeout` | `600` s | leave |
| `pgbouncer.stats_users` | empty | set to an existing user, to enable `SHOW POOLS` |

```bash
az postgres flexible-server parameter set \
  --resource-group <RG> --server-name <SERVER> \
  --name pgbouncer.default_pool_size --value <N>
```

**Size `N` fleet-wide, not per replica.** The pool is per user/database pair and is shared by every
ACA replica and every warm session of that tenant. With `aca.yaml` at `maxReplicas: 10` and an HTTP
scale rule of `concurrentRequests: 50`, the nominal fleet peak is far beyond anything
`default_pool_size` can cover — which is the strongest practical argument that the pool knob is a
mitigation, not a fix. `N` must also fit under the server's `max_connections` alongside every other
pool and admin session on that instance.

**Complementary knobs that are ours, not Azure's, and deployable in the same change:**
- Leave `PG_POOL_MAX` at 2 (`postgres.ts:58`). Raising it multiplies per-session demand against the
  same `P`.
- Add the Option C semaphore on concurrent write execs per replica, sized `(P / 2) / replicas`. This
  is the only lever that bounds `W` from inside the application.
- Consider lowering `concurrentRequests` in `aca.yaml` so the fleet peak is a number someone has
  chosen.

**Caveat on `query_wait_timeout`, and it is not minor.** A client that exceeds it is *disconnected*,
not merely failed. The disconnected client is the one **waiting** — the root-pool connection doing
`commitBlob` or `getBlobNoTx` — not the one holding the transaction. So the fast-fail lands as a
socket death inside `postgres.js`, which is exactly the class of event #169 turns into a process
crash. Lowering this knob raises the rate of #169's trigger. Either sequence #169's crash handling
first, or start at 30 s rather than 15 s and watch the crash counter. This trade is not mentioned in
#166.

### What to measure to confirm it helped

Azure Monitor PgBouncer metrics are **disabled by default**; enable `pgbouncer.enabled` *and*
`metrics.pgbouncer_diagnostics` (both dynamic). Emitted at 1-minute granularity, 93 days of history:

- `client_connections_waiting` — the direct signal. Target ≈ 0. Any sustained non-zero value is the
  bug, pre-deadlock.
- `server_connections_active` against `default_pool_size` — headroom.
- `client_connections_total`, `num_pools` — sanity on the client side.

Server-side, and more diagnostic than any of the above:

```sql
SELECT count(*) FILTER (WHERE state = 'idle in transaction')            AS idle_in_tx,
       max(now() - xact_start) FILTER (WHERE state = 'idle in transaction') AS max_idle_tx_age
FROM pg_stat_activity;
```

`max_idle_tx_age` **is** the #166 exposure, in seconds. The harness measured 69 s for an 8 s script.
The operational mitigation will not move this number at all — only the structural fix will, and when
it lands this is the number that must collapse to milliseconds. Track it from today so there is a
before.

PgBouncer's own console, once `stats_users` is set:

```
psql "host=<server>.postgres.database.azure.com port=6432 dbname=pgbouncer user=<statsuser> sslmode=require"
SHOW POOLS;   -- watch cl_waiting and maxwait
```

Application side: rate of SQLSTATE `53300`/`08*` (should fall to zero), write-exec p99, and the
harness's own acceptance test — `pool_size == concurrency` no longer deadlocks. Note that the last
one is an acceptance criterion for the *structural* fix; the pool-sizing mitigation passes it only by
making `pool_size` large, which is not the same thing.

---

## 8. Open questions needing a human decision

1. **Is per-script all-or-nothing atomicity a contract we keep?** Option B is only on the table if
   the answer is no. `errors.ts`'s "not committed" claim, the ELOCKLOST semantics, and #170's
   verified rollback behaviour all currently depend on yes.
2. **Behaviour at the buffer cap:** fail the script with a retryable error (my recommendation), or
   auto-flush and accept partial durability? And what are the cap numbers?
3. **Is moving DB-surfaced error timing from the command to the flush acceptable?** Bash sees
   success; the request fails. This only fires on cache/DB divergence, but it changes the failure
   surface.
4. **Sequencing against #131.** A removes the script-long advisory lock, the last DB-level
   cross-replica exclusion. Does the epoch fence land first, together, or is the window acceptable in
   the interim? I would not ship A without it.
5. **What is the actual peak concurrent write-exec count per tenant database?** Nobody can size
   `default_pool_size` without it. Related: do all tenants share one `(user, database)` pair, or one
   pool each?
6. **Is `idle_in_transaction_session_timeout` non-zero on the production server?** If it is, every
   script longer than it is a guaranteed torn-commit or crash today. If it is zero, do not enable it
   until #166 lands. I could not check this.
7. **`query_wait_timeout` — 15 s or 30 s**, and does #169's crash handling ship first? See §7.
8. **Dialect parity:** must MySQL and Azure SQL get the buffered path, or is Postgres-only acceptable
   for now (with the others keeping today's shape behind the optional-capability pattern)?
9. **Id allocation:** is preallocation from the global `inodes_id_seq` acceptable (sequence gaps on
   every rollback, one sequence shared by all sandboxes in a tenant DB), or must ids stay strictly
   in-transaction?
10. **Rollout:** a flag to run both shapes side by side, and a verification run against a real Azure
    PgBouncer rather than the local docker harness. The harness's two-replica setup is local; #170's
    own standing gap note applies here too.

---

## 9. Corrections to the issue and the handoff

Recorded here so they are not propagated into the implementation PR.

1. **"deadlocks at `default_pool_size/2`" (issue title)** — the hard deadlock is at concurrency ≥
   `pool_size`; `pool_size/2` is where headroom vanishes. The issue body ("the floor is 2x") and the
   harness table are both correct; only the title is not. §1.3.
2. **"`default_pool_size >= 4x` peak concurrent write execs **per replica**"** — the pool is per
   user/database pair, shared fleet-wide. Sizing per replica under-provisions by the replica count.
   Azure's parameter description is the evidence. §1.3, §7.
3. **"Health endpoints hang with it" (issue, Impact)** — `/healthz` is a static handler with no
   database access (`src/api/server.ts:245`), so pool exhaustion cannot hang it; `/readyz` (`:246`)
   only touches Redis. The harness's measured note names `GET /v1/sandboxes`, which does hit the
   database. Whatever was observed on `/healthz` has a different cause (event-loop blocking, or the
   load generator itself) and should be re-measured before the claim is repeated — it matters,
   because it is what would or would not turn this into an ACA liveness-probe restart loop.
4. **"each in-flight write needs a **second** connection concurrently"** — true from the second
   mutation onward, and for any content-cache-miss read after a mutation. The first mutation in a
   scope is sequential, because `commitBlob` completes before `#withBareTx` opens the transaction
   (`sql-fs.ts:920` then `:922`). Minor, but it is why a single-write script never deadlocks.
5. **"root cause behind … half of #170's exposure" (handoff)** — not supported. #166 explains the
   pool and advisory-lock symptoms co-observed during #170's overlap, and it creates the single
   commit point #131's fence wants; it does not explain or fix the lost update, whose base is
   captured in memory before any lock. §3.2. Fixing #166 in isolation leaves #170 exactly as
   reproducible as it is today — and, per §5, slightly more so.
6. **Framing.** `thoughts/shared/plans/2026-05-02_bulk-fs-ops-script-tx.md:1088-1095` already
   recorded that script-tx requires a **session** pooler and that "transaction-pooler terminates
   long-lived transactions and is incompatible with script-tx". #166 is not a regression or an
   oversight; it is a design whose stated prerequisite the production deployment no longer provides.
   Saying so in the changeset will save the next reader an hour.

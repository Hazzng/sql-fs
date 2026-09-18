# Load, concurrency and multi-replica harness

Reproduces the failures the unit suite cannot see: contention, cross-replica coherence, Redis
degradation, connection loss, and memory under load. Built while validating #162; it found the
issues filed as #164–#175.

Prerequisites: `docker`, `psql`, a Postgres reachable at `127.0.0.1:5432` with a `sqlfs_app` role
that can `CREATE DATABASE`, and this repo installed (`pnpm i`).

```bash
scripts/loadtest/up.sh                                  # provision + start (idempotent)
node scripts/loadtest/scenarios/concurrency.mjs         # correctness assertions, exits non-zero on failure
node scripts/loadtest/scenarios/load.mjs                # throughput/latency ramp
node scripts/loadtest/scenarios/replica-steal.mjs       # cross-replica lost update
node scripts/loadtest/scenarios/redis-storm.mjs pause   # Redis degradation → 503 storm
scripts/loadtest/down.sh                                # stop + drop everything
```

## What `up.sh` builds, and why this shape

| | Ports | Database | Redis |
|---|---|---|---|
| Replica **A** | 8101 | `lt_shared` | `redis://…/9` |
| Replica **B** | 8102 | `lt_shared` (same) | `redis://…/9` (same) |
| Replica **FAULT** | 8103 | `lt_fault` | `:6380` (own instance) |

**A and B deliberately share one database and one Redis.** That is the whole point: on a single
replica the in-process `session.lock` serializes everything and masks the distributed bugs — the
cross-replica lost update is not expressible without two replicas on shared state.

**FAULT is isolated with its own Redis** so scenarios can stall it, fill it, or kill it without
corrupting the other measurements.

Replicas start with `--expose-gc --inspect=0` so memory work can force a GC over CDP. Logs land in
`scripts/loadtest/.run/{a,b,fault}.log`; the bearer token is `scripts/loadtest/.run/token`.

You do **not** need to source `env.sh` to run a scenario — it only exists for `up.sh`/`down.sh` and
for overrides. To change the shape:

```bash
LT_REPLICA_A=9001 LT_DB_SHARED=my_db scripts/loadtest/up.sh
# Shrink the lock window so lease races happen in seconds instead of 20s:
LT_EXTRA_ENV="REDIS_EXEC_LOCK_LEASE_MS=3000 REDIS_EXEC_LOCK_RENEW_MS=1000" scripts/loadtest/up.sh
```

## Scenarios

### `concurrency.mjs` — correctness, CI-able
Asserts rather than reports, and exits non-zero on any failure: concurrent edits all visible, no
lost update on an append counter, bulk-write atomicity (including that auto-created parents roll
back), zero torn reads under size churn, and owner isolation under parallel probing. Run this after
any change to the write path.

### `load.mjs` — throughput and latency
Concurrency ramp (1→48) over a realistic mix: 40% read, 25% write, 20% exec, 15% edit.
`--sandboxes N --seconds N` to resize. Previously measured on 1 CPU: saturates ~3,200 ops/s at
C=16–32, latency knee at C=8.

Two things this scenario learned the hard way, preserved in its code: it **warms up first**, because
the first level otherwise pays session creation and reads as a fake concurrency effect; and each
worker edits **its own path**, because workers sharing one race write-then-edit into legitimate
409s, and expected errors in the output hide unexpected ones.

### `replica-steal.mjs` — cross-replica lost update (#170)
Runs a long script on A, steals the Redis writer key mid-flight, and has B read-then-write. Reports
CONTROL vs STEAL side by side. The loss check is **symmetric**: whichever replica commits second
overwrites from its own stale cache, so either side can be the victim depending on timing.

Currently reproduces (the epoch fence is #131, not yet built):

```
STEAL:
  B saw   : "base\n"                     ← stale read
  final   : "base\nA-line\n"             ← B-line gone
  A 200/0   B 200/0                      ← both reported success
```

When verifying a fix, check the `blobs` table directly and query **both** replicas — after the
incident they stayed divergent indefinitely.

### `redis-storm.mjs [pause|maxmem|freeze]` — Redis degradation (#167)
Drives 2 MiB blob writes plus a bystander read on a *different* sandbox, then injects a fault at
t=6s. `pause` (6s stall, self-heals), `maxmem` (30mb + noeviction, does **not** self-heal),
`freeze` (docker pause 25s).

The signature to look for is **ELOCKTIMEOUT with p50 ≤ 10 ms** — that is the process-wide circuit
breaker fast-failing, not lock contention. A fix should keep the failure local to the failing
operation and leave the bystander read serving.

## Faults that need no scenario file

```bash
# Torn commit / process crash on connection loss (#169) — no admin command needed
psql "$(. scripts/loadtest/env.sh; lt_pg_url "$LT_DB_FAULT")" \
  -c "ALTER DATABASE $LT_DB_FAULT SET idle_in_transaction_session_timeout = '1500ms';"
# then: echo a > /f1.txt; sleep 3; echo b > /f2.txt; echo c > /f3.txt; echo done
# broken: 500 with f2,f3 durable (PG_POOL_MAX=1) or a crashed process (PG_POOL_MAX=2)

# Orphaned lock, without waiting 5 minutes (#173)
redis-cli -n 9 SET "vfs:default:rwlock:{<sandbox>}:writer" fake PX 8000 NX

# ECOHERENCE is applied-but-unacknowledged (#175)
redis-cli -n 9 SET "vfs:default:ver:<sandbox>" not-an-integer
# then append N lines via exec: each 503s, and all N are present after repairing the key

# Connection ceiling (#166) — warm sessions one at a time
psql "$(. scripts/loadtest/env.sh; lt_pg_url "$LT_DB_SHARED")" -c "select count(*) from pg_stat_activity;"
# conns ≈ 2 × sessions + 10; direct Postgres fails at 48 with SQLSTATE 53300
```

## Reading the numbers

- **`ps` RSS is not a memory signal on macOS.** It read 2478 MB while ~101 MB was live — the rest
  was freed-but-unmapped allocator pages. Use `heapUsed + external` after a forced GC (the replicas
  run with `--expose-gc --inspect=0` for exactly this). On Linux/glibc RSS is usable for headroom
  sizing but still overstates live memory.
- **Short runs are noisy.** The defaults (20 sandboxes, 20s per level) give a monotonic curve;
  3-second levels on a busy laptop do not. Do not read a saturation point off a quick run.
- **Blob bytes live in `external`**, not the V8 heap, so `--max-old-space-size` does not bound them
  and a container OOM-kills instead. A write costs roughly 7× the file size transiently.

## Standing gaps

Two local replicas are not a network partition. The 503 storm's *organic* threshold is unknown — it
is induced here, and reproduced at only 0.02% from load alone. `MAX_CONCURRENT_PYTHON` /
`MAX_CONCURRENT_JS` are never exercised, and the ~80 MB per CPython worker stacks on top of
everything above.

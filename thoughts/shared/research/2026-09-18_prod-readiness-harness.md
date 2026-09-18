# Production-readiness harness — setup and per-finding reproductions

> **The harness is now runnable code: `scripts/loadtest/` (see its README).** This document
> remains the record of what each fault does and what was measured; the scripts are the way
> to actually run it.

Built to validate PR #162 before merge. It found the issues filed as #164-#175. Keep it: every
one of those issues needs a way to prove the fix, and several are invisible to unit tests.

**Read this first: `ps` RSS is not a memory signal on macOS.** During this work `ps` reported
2478 MB while ~101 MB was actually live — the rest was freed-but-unmapped allocator pages. Every
memory number below is `heapUsed + external` **after a forced GC**, taken over CDP. On Linux/glibc
RSS is usable for headroom sizing (it is what the OOM killer sees) but still overstates live by a
persistent arena high-water.

## 1. Stack

Postgres and Docker are prerequisites. Each concern gets its own database, and anything that
stresses Redis gets its own Redis, so measurements do not contaminate each other.

```bash
# Redis: one shared, one dedicated for fault injection
docker run -d --name lt-redis-shared -p 6379:6379 redis:7-alpine
docker run -d --name lt-redis-fault  -p 6380:6379 redis:7-alpine

# A database per concern
for db in lt_storm lt_eventloop lt_locks lt_replica; do
  psql postgres://sqlfs_app:sqlfs_app@127.0.0.1:5432/postgres \
    -qc "DROP DATABASE IF EXISTS $db;" -c "CREATE DATABASE $db;"
done
```

Migrations are not applied by the tests. For each database, run once (must be `.mts` + `npx tsx`
because of top-level await):

```ts
// mig.mts
import { runMigrations } from "/ABS/PATH/src/api/migrations.js";
const url = "postgres://sqlfs_app:sqlfs_app@127.0.0.1:5432/lt_storm";
await runMigrations({ tenantIds: ["default"], getConnectionString: () => url });
```

Build and start a replica per concern (`--expose-gc` is required for the memory work):

```bash
pnpm build
FS_BACKEND=postgres \
DATABASE_URL="postgres://sqlfs_app:sqlfs_app@127.0.0.1:5432/lt_storm" \
REDIS_URL="redis://127.0.0.1:6380" \
AUTH_SECRET="loadtest-secret-at-least-32-bytes-long-xxxxx" \
PORT=8101 \
  node --expose-gc dist/api/server.js > server_storm.log 2>&1 &
```

**Two replicas on one database and one Redis** is what makes the distributed findings reachable —
on a single replica the in-process `session.lock` masks them. Same `DATABASE_URL` and `REDIS_URL`,
different `PORT`.

Auth tokens (HS256, `sub` = owner):

```js
// token.mjs — must live inside the repo so `jose` resolves
import { SignJWT } from "jose";
console.log(await new SignJWT({ sub: process.argv[2] ?? "loadtest-owner" })
  .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("12h")
  .sign(new TextEncoder().encode(process.env.AUTH_SECRET)));
```

True memory readings: `kill -USR1 <pid>` to open the inspector, then drive
`HeapProfiler.collectGarbage` + `global.gc()` over CDP and read `process.memoryUsage()`.

## 2. Reproductions, by issue

### #167 — Redis stall to replica-wide 503 storm

Needs the dedicated Redis. Any of three injections, under ~12 workers of mixed load:

```bash
redis-cli -p 6380 CLIENT PAUSE 6000            # 6s is enough: ~67% 5xx over a 7s window
redis-cli -p 6380 CONFIG SET maxmemory 30mb    # + noeviction: 97.6% 5xx, never recovers
docker pause lt-redis-fault; sleep 70; docker unpause lt-redis-fault   # reproduces the 60s straggler
```

Fix verified when: 503s stay local to the failing operation instead of fast-failing every request
on the replica, and bystander reads keep serving. Watch for `ELOCKTIMEOUT` with **p50 ~1-7 ms** —
that signature is the process-wide circuit breaker, not lock contention.

Library-level proof of the coupling, independent of load:

```bash
docker update --cpus=0.15 lt-redis-fault
# 260 concurrent 2 MiB SETs, then INCR on the shared connection vs a second one
# broken: shared INCR times out at ~2043 ms, isolated returns in ~44 ms
docker update --cpus=2 lt-redis-fault
```

### #168 — exec blocks the event loop

Ping a tiny `GET /healthz` and a 6-byte file GET on a **different sandbox and owner** every 5 ms
while running, in one sandbox:

```
sed s/abc/xyz/g over 16 MiB   -> 2238 ms max stall
tr a-m n-z      over 49 MiB   -> 5563 ms max stall
PATCH replaceAll  49 MiB      ->  254 ms max stall
```

Fix verified when: the p95/p99 of the bystander pings stays near its idle baseline (p50 2.4 ms /
p95 5 ms). Note the stall is **linear in size, R²≈1**, so measure the curve rather than one point,
and check for `rw_lock_writer_release_error … Command timed out` in the log — past ~2 s a stall
times out *other tenants'* Redis commands.

### #166 / PG connection ceiling

Direct: create warm sessions one at a time, `echo hi` each, watching
`select count(*) from pg_stat_activity`. `conns ≈ 2 × sessions + 10`; 47 OK, 48 fails with
SQLSTATE `53300`.

Through PgBouncer (transaction mode) the wall moves to concurrent in-flight write transactions:

```
pool_size 5  / 12 concurrent writes -> 0/12, all hang ~128s
pool_size 12 / 12 concurrent writes -> PERMANENT DEADLOCK, whole replica wedged
pool_size 40 / 12 concurrent writes -> 12/12 in 8.1s
```

Fix verified when: `pool_size == concurrency` no longer deadlocks — i.e. a write no longer needs
two pool connections at once.

### #170 — cross-replica silent lost update

Needs both replicas. Shrink the window to make it reachable
(`REDIS_EXEC_LOCK_LEASE_MS=3000 REDIS_EXEC_LOCK_RENEW_MS=1000`), then steal the writer key
mid-script:

```bash
redis-cli -n 4 DEL "vfs:default:rwlock:{<sandbox>}:writer"
```

Control vs steal on the same script and timing:

```
CONTROL   B sees: base\nA-line   -> final: base\nA-line\nB-line
STEAL     B sees: base           -> final: base\nB-line          # A-line destroyed
```

Fix verified when: the steal case either preserves A's line or fails A's commit. Verify against
the `blobs` table, not through the API — and check both replicas afterwards, since they stayed
divergent indefinitely (`lastSeenVersion` adopting head).

### #169 / #TORN — connection death mid-script

**No admin command needed**, which is the point:

```sql
ALTER DATABASE lt_locks SET idle_in_transaction_session_timeout = '1500ms';
```

then a three-write script with a `sleep 3` in the middle, and **no kill**:

```
echo a > /f1.txt; sleep 3; echo b > /f2.txt; echo c > /f3.txt; echo done
```

Before the fix: `PG_POOL_MAX=1` gave HTTP 500 with `f2`/`f3` durable and `f1` rolled back;
`PG_POOL_MAX=2` (the default) **crashed the process** 3/3. Fix verified when: zero rows commit and
the response is a clean retryable error. Also assert the same for `POST /writeFiles` — 600 files,
kill at 0.5 s, previously 599 committed on a 500.

### #171 / #172 / #173 — lock scope and cancellation

```bash
# #171 reader-reader parallelism: 12 concurrent GETs of one file, warm session, no writer
#      exclusive path ~147 ms wall; shared path (MCP file_read, same work) ~12 ms
# #172 abort a client 1s into a 6s exec-sync, then time the next write on that sandbox
#      broken: blocked ~5s and both post-abort files committed; SSE /exec releases in ~2 ms
# #173 plant a synthetic orphan instead of waiting 5 minutes:
redis-cli -n 3 SET "vfs:default:rwlock:{<sandbox>}:writer" fake PX 8000 NX
#      a blocked GET returns after ~7.99s, spinning at ~27 EVAL/s the whole time
```

### #175 — ECOHERENCE means applied, not retryable

Make only the version INCR fail, leaving lock evals healthy:

```bash
redis-cli -n 3 SET "vfs:default:ver:<sandbox>" not-an-integer
```

Then run `echo L >> /counter.txt` several times: each returns 503 ECOHERENCE, and after repairing
the key `wc -l < /counter.txt` shows **every one of them committed**. Fix verified when a client
can distinguish applied-but-unacknowledged from not-applied without parsing `code`.

### Memory-sensitive paths (PR #162's own, all currently bounded)

```
PATCH replaceAll, 50 MiB, 1-char needle   -> peak heap 254 MB, fully reclaimed after GC
MCP file_read, 16 MiB of newlines         -> wire 1,048,672 B, totalLines 16,776,193, truncated
MCP file_read, 16 MiB of NULs             -> wire 1,048,671 B, content 149,776 chars
```

Also worth keeping: the retention cliff at the contentCache cap (50 MiB -> ~1.0x live,
51 MiB -> ~3x on Linux, ~2x on macOS, and again per pool connection), and that a container limit
produces `OOMKilled` exit 137 with **no** V8 heap error, because the bytes are in `external`.

## 3. Standing gaps

- Cross-replica work used two local replicas; real network partitions are untested.
- The 503 storm's *organic* trigger threshold is unknown — it was induced three ways, and
  reproduced at only 0.02% from load alone.
- No live `git push` against a real remote; the 307/308 body protection was verified against a
  local HTTPS origin with a self-signed CA, which is equivalent for that code path but not proof
  against a real forge's behaviour.
- `MAX_CONCURRENT_PYTHON` / `MAX_CONCURRENT_JS` were never exercised; the ~80 MB per CPython
  worker in CLAUDE.md is unverified here and stacks on top of every number above.

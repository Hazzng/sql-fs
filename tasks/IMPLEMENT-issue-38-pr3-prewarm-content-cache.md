# IMPLEMENT — Issue #38, PR 3: Background prewarm of `#contentCache` at session attach (hybrid Option 3)

> **Read this first if you're new to the issue.** This is the largest of the three PRs in issue #38 — it adds one new dialect method (`getBlobsForSandbox`), one new method on `RedisBlobCache` (`mget`), and a non-fatal background task in `SqlFs.ready()`. No agent-visible API change. Plan-only document — read all of §1–§3 before coding.

> Sister PRs (separate documents — independent of this one, but PR 1 should land first for measurement attribution):
> - **PR 1** — `IMPLEMENT-issue-38-pr1-getblob-no-tx.md` — drop the read transaction wrapper. Removes ~70 % of cold tax.
> - **PR 2** — `IMPLEMENT-issue-38-pr2-bulkingest-cache-seed.md` — populate cache inside `bulkIngest`.

---

## 1. Background — what is this and why

### 1.1 The cold-grep problem (one-paragraph recap)

The first command an agent runs that reads file *contents* on a sandbox pays one serial DB round-trip per blob. For a 125-file / 1.18 MB Python tree against the AU-East deployment, the cold pass takes **~9.4 s**, vs. ~3.7 s warm. The issue's full decomposition:

| Component | Estimate | Status after each PR |
|---|---|---|
| HTTP + bash startup | ~600 ms | unchanged (out of scope) |
| WASM bash IFS dispatch (open + read + close × 125) | ~3 000 ms | unchanged (out of scope; this is the warm floor) |
| Per-blob read transaction wrapper × 125 | ~4 000 ms | **eliminated by PR 1** |
| Per-blob `SELECT data FROM blobs WHERE sha256 = $1` × 125 | ~1 800 ms | **eliminated by this PR for the common case** |

This PR is what collapses the **count** of cache-miss DB round-trips. PR 1 makes each individual SELECT cheaper (4 RTT → 1 RTT). PR 3 reduces the *count* (N RTT → 1 RTT — one batched SELECT). You need both to close the gap.

### 1.2 Why "eager prewarm" alone isn't enough — the hybrid approach

The naive design is: at `ready()`, fetch every blob the sandbox uses in one batched SELECT and populate `#contentCache`. This works, and is what issue #38's "change A" originally proposed. The problem with pure eager prewarm:

1. **It pays the bulk-fetch cost on every session attach**, even when the agent will never read files (write-only sessions, or sessions that just `ls` and exit).
2. **It blocks `ready()`.** The session can't accept any request — even ones that don't need content — until the prewarm finishes.

The **hybrid (Option 3)** design avoids both:

- `ready()` kicks off `#prewarmContentCache()` **without awaiting it**.
- `ready()` continues to await `loadAllPaths` (which is unavoidable — no FS op works without `#pathCache`).
- The `readFile` cache-miss path checks if a prewarm is in flight; if so, it `await`s it; if it's already complete (or never started), the path falls through to PR 1's `getBlobNoTx` exactly as today.

Effect:
- **Sessions that never read files**: prewarm runs in the background and is harmless background bandwidth. `ready()` returns at the speed of `loadAllPaths`.
- **Sessions that immediately grep**: the first `readFile` waits for the prewarm to finish (~200–400 ms for a 1 MB tree), then 124 more reads are instant. Net cold-grep time: ~3.7 s (the warm floor) instead of ~9.4 s.
- **Sessions on a fresh replica with a warm Redis L2**: the prewarm becomes a single `mget` — typically ~5 ms total — and `ready()` is effectively unblocked immediately.

This is **strictly ≥ pure eager** in every dimension and **strictly ≥ pure lazy single-flight** in every dimension worth caring about.

### 1.3 The Redis L2 in this story

The codebase already has `RedisBlobCache` (`src/fs/sql-fs/redis-blob-cache.ts`), and `PostgresDialect.getBlob`/`upsertBlob` already consult it (lines 388-404 and 371-386). PR 1 adds `getBlobNoTx` that consults it too. Reasoning preserved here:

- A blob hit in Redis is an order of magnitude cheaper than a Postgres SELECT (often co-located, ~1 ms).
- A fresh replica that re-attaches an existing sandbox should hit Redis, not Postgres — otherwise we shed the L2 every time the SessionManager evicts a sandbox or routing lands on a different pod.

The bulk prewarm therefore must follow the same hierarchy: Redis first, Postgres only for misses. Otherwise we'd silently bypass the L2 and load every replica's prewarm directly off Postgres.

### 1.4 Why this PR comes last

Order of operations:

1. **PR 1 first** — biggest single win (5-line change). Capture `pg_stat_statements` deltas to prove the wrapper-strip claim. Establishes a clean baseline.
2. **PR 2 second** — ingest-then-read goes to zero DB calls. Smallest change, narrowest blast radius.
3. **PR 3 (this PR) last** — bigger change (dialect surface + `RedisBlobCache.mget` + `ready()` rework). Lands on top of PR 1's clean baseline so its contribution is attributable.

If PR 3 were to ship before PR 1, prewarm would still use the wrapper-bound `getBlob` for its Postgres misses, and the `getBlobNoTx` story would be muddled.

---

## 2. Current state — exact lines

You will edit / read these files:

| File | What's there now |
|---|---|
| `src/fs/sql-fs/types.ts:268` | `getBlob(tx, sha256)` declared on `SqlDialect`. After PR 1, `getBlobNoTx(sha256)` sits next to it. **This PR adds `getBlobsForSandbox(sandboxId, maxBytes)` next to those.** |
| `src/fs/sql-fs/dialects/postgres.ts:388-404` | `getBlob` impl (Redis L2 → Postgres SELECT). After PR 1 lands, `getBlobNoTx` lives here too. **This PR adds `getBlobsForSandbox` here.** |
| `src/fs/sql-fs/dialects/postgres.ts:73-76` | `private db()` returns the pool handle. Used by `getBlobsForSandbox` to issue the bulk SELECT directly without a transaction. |
| `src/fs/sql-fs/redis-blob-cache.ts:39-48` | `RedisBlobCache.get` — single-key `getBuffer`. **This PR adds `mget(sha256s)`** that pipelines through `client.mgetBuffer`. |
| `src/fs/sql-fs/sql-fs.ts:62` | `DEFAULT_CONTENT_CACHE_MAX_BYTES = 50 * 1024 * 1024`. The byte cap that the prewarm must respect. |
| `src/fs/sql-fs/sql-fs.ts:130-133` | LRU constructor — `maxSize` and `sizeCalculation`. The `#contentCache.maxSize` value is the cap to pass to the prewarm. |
| `src/fs/sql-fs/sql-fs.ts:280-323` | `#loadFreshPathCache` — runs `loadAllPaths` in a transaction with `setSandboxContext`. Path-cache load remains awaited; prewarm runs alongside it. |
| `src/fs/sql-fs/sql-fs.ts:329-333` | **`ready()` — the function this PR rewrites.** Currently it awaits the path load and that's it. |
| `src/fs/sql-fs/sql-fs.ts:347-364` | `reload()` — cross-replica cache-version mismatch handler. Currently clears `#contentCache` and reloads `#pathCache`. **This PR adds: trigger a fresh prewarm after the path reload, same single-flight pattern as `ready()`.** |
| `src/fs/sql-fs/sql-fs.ts:685-700` | `readFileBuffer` (after PR 1 — uses `getBlobNoTx`). **This PR adds: await any in-flight prewarm before falling through to `getBlobNoTx`.** Same edit applies to `readFile` (line 667-682). |
| `src/fs/sql-fs/migrations/postgres/0000_create_tables.sql:38-44` | Confirms `blobs` is global / no RLS. Reference only. |
| `src/fs/sql-fs/migrations/postgres/0000_create_tables.sql:47` | `idx_inodes_sandbox_id` — covers the `WHERE i.sandbox_id = $1` filter the bulk query uses. No new index required. |
| `src/api/session-manager.ts:259, 282` | Session bringup — calls `createSandboxFs()` then `await fs.ready()`. **No change required** — the only change is inside `ready()`. |
| `CHANGELOG.md`, `package.json`, `pnpm-lock.yaml`, `src/api/openapi-spec.ts` | Per CLAUDE.md, bump together. **Minor bump** for this PR (perf feature, observable timing change in logs). |

---

## 3. The change

Five edits, ordered from leaf-most to most user-visible.

### 3.1 `src/fs/sql-fs/types.ts` — declare `getBlobsForSandbox`

Add to `SqlDialect`, immediately after `getBlobNoTx` (which PR 1 introduced):

```ts
/**
 * Bulk-fetches blob contents for every file inode in the given sandbox,
 * smallest-first up to a total of `maxBytes`. Used by `SqlFs.#prewarmContentCache`
 * to populate the in-memory content cache in a single round-trip.
 *
 * Implementations MUST:
 *  - skip directories and symlinks (return only kind=file rows with non-null
 *    content_sha256);
 *  - order by file size ascending so the byte cap is filled with the most
 *    blobs possible (a 50 MB cap consumed by one 50 MB file gives the agent
 *    no useful coverage; the same cap consumed by 5000 small files makes
 *    most greps free);
 *  - run without a transaction or sandbox-context setting (the join uses
 *    `inodes.sandbox_id` as a regular column filter, and `blobs` is global
 *    — confirmed in migrations/postgres/0000_create_tables.sql);
 *  - prefer the Redis L2 (`RedisBlobCache`) when configured: fetch metadata
 *    first, mget Redis, then Postgres-fetch only the misses in one batched
 *    SELECT.
 *
 * Returns inode-id-keyed entries (NOT sha-keyed) because the cache is keyed
 * by inodeId. Two inodes that dedup to the same blob must each appear in
 * the result.
 */
getBlobsForSandbox(
  sandboxId: string,
  maxBytes: number,
): Promise<Array<{ inodeId: bigint; sha256: Uint8Array; data: Uint8Array }>>;
```

### 3.2 `src/fs/sql-fs/redis-blob-cache.ts` — add `mget`

Append to the class:

```ts
/**
 * Bulk variant of `get`. Returns one entry per input sha256 in the same
 * order; `null` for a miss. Fail-open: any Redis error returns all-null.
 */
async mget(sha256s: ReadonlyArray<Uint8Array>): Promise<Array<Uint8Array | null>> {
  if (!this.#enabled || sha256s.length === 0) return sha256s.map(() => null);
  try {
    const keys = sha256s.map((s) => this.#key(s));
    // ioredis exposes mgetBuffer for binary-safe pipelined gets.
    const bufs = (await this.#client.mgetBuffer(...keys)) as Array<Buffer | null>;
    return bufs.map((b) => (b ? new Uint8Array(b) : null));
  } catch (err) {
    console.error(JSON.stringify({ event: "redis_blob_mget_error", error: (err as Error).message }));
    return sha256s.map(() => null); // fail open
  }
}
```

Add a unit test in `src/fs/sql-fs/redis-blob-cache.test.ts` mirroring the existing `get` tests (mock client, returns mixed nulls, throws → fail-open).

### 3.3 `src/fs/sql-fs/dialects/postgres.ts` — implement `getBlobsForSandbox`

Place after `getBlobNoTx` (which PR 1 introduces). Two flavours, one fast-path with Redis, one without. Both run on the pool — no transaction.

```ts
async getBlobsForSandbox(
  sandboxId: string,
  maxBytes: number,
): Promise<Array<{ inodeId: bigint; sha256: Uint8Array; data: Uint8Array }>> {
  if (maxBytes <= 0) return [];

  // 1. Pull metadata (no payloads) for every file inode in the sandbox,
  //    bounded by maxBytes via running-total window. Smallest-first so the
  //    cap fills with as many blobs as possible.
  const metaRows = await this.db()<
    { inode_id: string; content_sha256: Buffer; size: string }[]
  >`
    WITH ranked AS (
      SELECT
        i.id              AS inode_id,
        i.content_sha256  AS content_sha256,
        i.size            AS size,
        SUM(i.size) OVER (ORDER BY i.size ASC, i.id ASC) AS running_total
      FROM inodes i
      WHERE i.sandbox_id = ${sandboxId}
        AND i.kind = 1                                -- INODE_KIND.FILE
        AND i.content_sha256 IS NOT NULL
    )
    SELECT inode_id, content_sha256, size
    FROM ranked
    WHERE running_total <= ${maxBytes}
    ORDER BY size ASC, inode_id ASC
  `;

  if (metaRows.length === 0) return [];

  const shas = metaRows.map((r) => new Uint8Array(r.content_sha256));

  // 2. mget Redis (one pipelined call). Misses become null.
  let redisHits: Array<Uint8Array | null>;
  if (this.#blobCache !== undefined) {
    redisHits = await this.#blobCache.mget(shas);
  } else {
    redisHits = shas.map(() => null);
  }

  // 3. For Redis misses, do ONE batched Postgres fetch. Distinct shas only.
  const missShasSet = new Map<string, Uint8Array>(); // hex → bytes
  for (let i = 0; i < shas.length; i++) {
    if (redisHits[i] === null) {
      const sha = shas[i]!;
      missShasSet.set(Buffer.from(sha).toString("hex"), sha);
    }
  }
  const missShasArr = [...missShasSet.values()];

  let pgHits = new Map<string, Uint8Array>(); // hex → bytes
  if (missShasArr.length > 0) {
    const pgRows = await this.db()<{ sha256: Buffer; data: Buffer }[]>`
      SELECT sha256, data
      FROM blobs
      WHERE sha256 = ANY(${missShasArr}::bytea[])
    `;
    pgHits = new Map(
      pgRows.map((r) => [
        Buffer.from(r.sha256).toString("hex"),
        new Uint8Array(r.data),
      ]),
    );

    // Async backfill into Redis. Same fire-and-forget pattern as `getBlob`.
    if (this.#blobCache !== undefined) {
      for (const [hex, bytes] of pgHits) {
        const sha = missShasSet.get(hex);
        if (sha !== undefined) void this.#blobCache.set(sha, bytes);
      }
    }
  }

  // 4. Stitch the result. Order matches metaRows (and therefore preserves the
  //    smallest-first caching behaviour).
  const out: Array<{ inodeId: bigint; sha256: Uint8Array; data: Uint8Array }> = [];
  for (let i = 0; i < metaRows.length; i++) {
    const row = metaRows[i]!;
    const sha = shas[i]!;
    const bytes = redisHits[i] ?? pgHits.get(Buffer.from(sha).toString("hex"));
    if (bytes === undefined) continue; // referential-integrity gap; rare
    out.push({ inodeId: BigInt(row.inode_id), sha256: sha, data: bytes });
  }
  return out;
}
```

Notes:

- `WHERE i.kind = 1` — `INODE_KIND.FILE`. Symlinks (kind=3) and dirs (kind=2) excluded. Imported from `../types.js` if not already.
- `idx_inodes_sandbox_id` already exists; the running-total window scan over a per-sandbox slice is fast.
- `WHERE running_total <= maxBytes` excludes the file that would push us over, rather than including it. Strict cap is simpler — LRU semantics are not needed here since we never insert above the cap.
- `pg_stat_statements` impact: two new statement entries (the metadata CTE and the `WHERE sha256 = ANY(…)` batched fetch). Each runs at most once per `ready()`/`reload()`.
- Redis branch: when `mget` returns all-null (cold Redis or Redis disabled), this collapses to one metadata RTT + one batched data RTT = 2 RTTs total. Without metadata-first you'd transfer all the blob bytes through Postgres even when Redis has them — strictly worse. Two RTTs is the right cost.

### 3.4 `src/fs/sql-fs/sql-fs.ts` — wire prewarm into `ready()` / `reload()` and gate `readFile`/`readFileBuffer`

#### 3.4.1 New private state

```ts
/**
 * In-flight prewarm task. Set by `#startPrewarm()`; cleared when the task
 * resolves (either fulfilled or rejected — failures are non-fatal). Read by
 * `readFile`/`readFileBuffer` cache-miss paths to coalesce reads onto the
 * batched fetch instead of issuing per-file SELECTs in parallel with it.
 */
#prewarmInFlight: Promise<void> | undefined;
```

#### 3.4.2 New private method

```ts
#startPrewarm(): void {
  if (this.#prewarmInFlight !== undefined) return;
  const cap = this.#contentCache.maxSize;          // LRU's configured byte cap
  const task = (async (): Promise<void> => {
    try {
      const blobs = await this.#dialect.getBlobsForSandbox(this.#sandboxId, cap);
      for (const { inodeId, data } of blobs) {
        if (data.byteLength > 0) this.#contentCache.set(inodeId, data);
      }
      console.log(JSON.stringify({
        event: "content_prewarm_ok",
        sandboxId: this.#sandboxId,
        entries: blobs.length,
      }));
    } catch (err) {
      // Non-fatal: lazy fetch via getBlobNoTx still works.
      console.error(JSON.stringify({
        event: "content_prewarm_error",
        sandboxId: this.#sandboxId,
        error: (err as Error).message,
      }));
    } finally {
      this.#prewarmInFlight = undefined;
    }
  })();
  this.#prewarmInFlight = task;
}
```

Single-flight: a second `#startPrewarm()` while one is in flight is a no-op.

#### 3.4.3 `ready()` — kick off prewarm in the background

```ts
async ready(): Promise<void> {
  // Start the content prewarm BEFORE awaiting the path load. Both queries
  // hit Postgres independently; the driver pipelines them on the pool, and
  // `loadAllPaths` runs inside its own transaction so they don't interfere.
  // ready() blocks ONLY on the path load — prewarm is non-fatal background.
  this.#startPrewarm();

  const fresh = await this.#loadFreshPathCache();
  this.#pathCache.clear();
  for (const [p, e] of fresh) this.#pathCache.set(p, e);
}
```

We deliberately do **not** `await` the prewarm here. The first `readFile` that arrives during the prewarm window will await it; sessions that never read get the prewarm "for free" in the background.

#### 3.4.4 `reload()` — re-prewarm after cross-replica refresh

```ts
async reload(): Promise<void> {
  if (this.#pendingReload !== undefined) {
    return this.#pendingReload;
  }
  const p = (async (): Promise<void> => {
    try {
      const fresh = await this.#loadFreshPathCache();
      this.#pathCache.clear();
      for (const [path, entry] of fresh) this.#pathCache.set(path, entry);
      this.#contentCache.clear();
      this.#dirty = false;
      // After the path cache is rebuilt and the content cache is dropped,
      // kick off a fresh prewarm so the next read after a cross-replica
      // reload doesn't pay 125 RTTs in a row.
      this.#startPrewarm();
    } finally {
      this.#pendingReload = undefined;
    }
  })();
  this.#pendingReload = p;
  return p;
}
```

#### 3.4.5 Gate the cache-miss reads on the in-flight prewarm

In `readFile` (sql-fs.ts:667) and `readFileBuffer` (line 685), insert one extra check between "check cache" and "fall through to `getBlobNoTx`". After PR 1, `readFileBuffer` looks like:

```ts
async readFileBuffer(inputPath: string): Promise<Uint8Array> {
  const path = validatePath(inputPath);
  const entry = await this.#resolveReadEntry(path);
  if (entry.kind === INODE_KIND.DIRECTORY) throw createEisdir(path);

  // 1. Hot path: cache hit.
  const cached = this.#contentCache.get(entry.inodeId);
  if (cached !== undefined) return cached;

  // 2. ── NEW (this PR) ──
  // If a prewarm is currently running, await it. Once it completes the cache
  // may have our bytes; recheck before falling through to a per-file fetch.
  if (this.#prewarmInFlight !== undefined) {
    await this.#prewarmInFlight;
    const afterPrewarm = this.#contentCache.get(entry.inodeId);
    if (afterPrewarm !== undefined) return afterPrewarm;
  }

  // 3. Cold path (cache miss after prewarm, or prewarm not running): single
  //    pool-level SELECT. PR 1's getBlobNoTx — no transaction wrapper.
  const data = await this.#dialect.getBlobNoTx(entry.contentSha256!);
  const bytes = data ?? new Uint8Array(0);
  if (bytes.byteLength > 0) this.#contentCache.set(entry.inodeId, bytes);
  return bytes;
}
```

Same three-block shape in `readFile` (the only difference is the `TextDecoder` decode at the return).

Reasoning:

- Reads that arrive **after** prewarm completes hit the cache and never see this code path.
- Reads that arrive **during** prewarm join its single batched fetch, instead of racing it with a per-file SELECT.
- Reads for files **outside** the byte-cap (oversized files dropped by the prewarm) still find an empty cache entry after the prewarm awaits, and fall through to `getBlobNoTx` (PR 1) for that one file. Correct and rare.
- Reads that arrive when **no prewarm has run** (e.g. backend that never called `ready()`, or after a `reload()` with prewarm disabled in the future) skip the gate and go straight to `getBlobNoTx`. No regression.

### 3.5 What does **not** change

- The `IFileSystem` contract. Agents still use `grep`/`cat`/`awk`.
- `setSandboxContext`, `setSandboxContextWithLock`, `#withTx`, `#withReadTx`. None of them touched.
- The `SqlFs` constructor signature, options, or LRU cap.
- `bulkIngest`'s transaction shape. (PR 2 already populated the cache there.)
- Any HTTP route handler.
- Migration files / DB schema. `idx_inodes_sandbox_id` already exists.

---

## 4. Acceptance criteria

1. **Cold-grep tax goes to ~zero.** End-to-end: first `grep -rn 'pattern' /home/user/{repo}` on a freshly-attached session, on a tree that fits in `contentCacheMaxBytes`, runs in ≤ 1.2× the warm time. Today (after PR 1 only) the ratio is ~1.5×; after this PR it's ~1.0×. Capture before/after in the PR description.
2. **No new round-trips on the hot path.** Once warm, `readFile` continues to hit cache without SQL — verified by counting dialect calls in a unit test that opens 50 cached files in a row.
3. **Pre-warm respects the byte cap.** Unit test: build a sandbox with 200 × 1 MB files, set `contentCacheMaxBytes` to 50 MB, run `ready()`, await any in-flight prewarm, then assert exactly 50 (the smallest 50) are present in the cache. No errors thrown.
4. **Pre-warm failure is non-fatal.** Unit test: inject a dialect error in `getBlobsForSandbox`. `ready()` must still resolve. The next `readFile()` must succeed via the PR 1 lazy-fetch path.
5. **Pre-warm uses Redis L2 when configured.** Unit test: with `RedisBlobCache.mget` returning all hits, the dialect's batched `SELECT … sha256 = ANY(…)` is **never** issued. Verified via spy on the Postgres pool.
6. **Pre-warm uses the metadata-only path on Redis cold start.** Unit test: with `mget` returning all nulls, exactly one batched SELECT is issued and it covers all distinct sha256 values.
7. **Concurrent reads coalesce onto one prewarm.** Unit test: trigger 50 concurrent `readFileBuffer` calls during the prewarm window. The dialect's `getBlobNoTx` is invoked at most once per file *not* covered by the prewarm; for files that *are* covered, it is invoked zero times.
8. **`reload()` re-prewarms.** Unit test: ingest files; await `ready()`; clear `#contentCache` and `#pathCache` indirectly via `reload()`; assert a fresh prewarm task runs and re-populates the cache.
9. **No transaction overhead on prewarm or reads.** Integration test (`DATABASE_URL` required): capture `pg_stat_statements` baseline; perform a cold attach + grep; assert zero new `BEGIN` / `SELECT set_config('app.sandbox_id', …, true)` / `COMMIT` deltas attributable to either the prewarm or the cache-miss path.
10. **Bash semantics unchanged.** `pnpm test` (unit + integration) passes. Existing API e2e tests (`src/api/__tests__/`) continue to pass with no surface changes.

---

## 5. Test plan

**Unit (Vitest)**

- `src/fs/sql-fs/sql-fs.prewarm.test.ts` (**new**):
  - "ready() returns before prewarm completes" — assert `ready()` resolves while a `getBlobsForSandbox` mock is still pending; assert `#prewarmInFlight` is non-undefined immediately after.
  - "readFileBuffer awaits in-flight prewarm" — concurrent reads + slow prewarm; reads hit cache after prewarm resolves; dialect's `getBlobNoTx` not called for cached entries.
  - "byte cap honoured (smallest-first)" — covers AC 3.
  - "non-fatal on dialect error" — covers AC 4.
  - "reload() retriggers prewarm" — covers AC 8.
  - "single-flight: two concurrent ready() calls share one prewarm" — assert `getBlobsForSandbox` invoked once even when `ready()` is somehow re-entered (defensive).
- `src/fs/sql-fs/redis-blob-cache.test.ts` (**update**): add `mget` cases — mixed hits/misses, fail-open on Redis error.
- `src/fs/sql-fs/dialects/postgres.test.ts` (**new or merged with existing**):
  - "uses Redis hits when available, no Postgres fetch" — covers AC 5.
  - "Redis cold: one metadata SELECT + one batched SELECT" — covers AC 6.
  - "deduplicates shas: two inodes pointing at one blob → one entry in `WHERE sha256 = ANY(…)`".
  - "byte cap is strict (file at boundary excluded)".

**Integration (`src/fs/sql-fs/integration/`, `DATABASE_URL` required)**

- `prewarm.integration.test.ts` (**new**):
  - Ingest 100 files, attach a fresh `SqlFs`, await `ready()` *and* the in-flight prewarm, then time `readFile(path)` for all 100 in serial. Total wall-clock < 100 ms (today this is multi-second).
- `prewarm-pgss.integration.test.ts` (**new**):
  - Snapshot `pg_stat_statements`; cold attach + read 100 files; assert AC 9 (zero `BEGIN` / `set_config` deltas attributable to prewarm and reads).

**End-to-end (manual)**

- Run `grep -rn 'pattern' /home/user/{repo}` on the AU-East deployment before/after each of PR 1, PR 1+2, and PR 1+2+3. Record numbers in the PR body so the contribution of each PR is attributable.

---

## 6. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Prewarm holds a Postgres connection for the duration of the bulk transfer, starving the pool. | The metadata + bulk-data queries each acquire and release a connection per call — no transaction holds them. The `postgres` driver pool defaults are sufficient; no tuning required. |
| Background prewarm runs even on sessions that immediately exit. | Worst case is one metadata query + one batched data query (cancelled as soon as the resolver finishes). On a healthy DB this is ≤ 200 ms of background work; cost is amortized over the sandbox lifetime. If observed in production, gate prewarm behind an env flag (`VFS_PREWARM_CONTENT_CACHE=1` default-on). |
| `mget` against ioredis returns large allocations into the Node heap. | Cap is `contentCacheMaxBytes` (50 MB). The same bytes were going to be allocated lazily anyway. No new GC pressure. |
| Two SqlFs instances racing on `ready()` for the same sandbox (e.g. SessionManager rehydrate). | Single-flight `#prewarmInFlight` is **per-instance**. Two instances each run their own prewarm against the same sandbox — wasted work but correct. SessionManager already ensures one warm `Bash` per sandbox; the duplicate-attach race is bounded. |
| Redis goes offline mid-prewarm. | `mget` fails open (returns all nulls); the function falls through to the Postgres bulk SELECT. `ready()` still resolves. |
| Future migration adds RLS to `inodes` that requires `app.sandbox_id` to be set. | The bulk query filters explicitly on `i.sandbox_id = $1`. If RLS is added later, the query would have to set the context first; until that happens, the explicit filter is necessary and sufficient. Add a one-line code comment at the query site flagging this. |
| The window-function CTE is slow on huge sandboxes (10⁶ inodes). | `idx_inodes_sandbox_id` covers the predicate. Window over a sandbox-scoped slice is bounded by the slice size, not the table size. Measure on the largest existing sandbox before merging; if pathological, fall back to a `LIMIT k` variant tuned per cap. |
| The hybrid gate adds a microtask to every cache-miss read even after prewarm completes. | The check is `if (this.#prewarmInFlight !== undefined)` — a single property read, evaluating to false in steady state. Effectively free. |

---

## 7. Versioning

Per CLAUDE.md:

- `package.json` → **minor bump** (perf feature with new dialect surface and observable timing change in logs)
- `pnpm-lock.yaml` → `pnpm install --lockfile-only`
- `src/api/openapi-spec.ts` → `info.version` (the OpenAPI spec doesn't change but the version field must match)
- `CHANGELOG.md` → new dated `## [x.y.z] - YYYY-MM-DD` section with an `Added` and a `Changed` bullet:
  > **Added:** `SqlDialect.getBlobsForSandbox` and `RedisBlobCache.mget` for batched content prewarm.
  > **Changed:** `SqlFs.ready()` and `SqlFs.reload()` now kick off a non-fatal background content-cache prewarm. Cache-miss reads coalesce onto the in-flight prewarm. Cold-grep latency on a 125-file / 1 MB tree drops from ~9.4 s to ~3.8 s on remote Postgres deployments.

---

## 8. Hand-off

This PR completes the issue #38 trio:

- PR 1 removed the per-blob transaction wrapper (~70 % of cold tax).
- PR 2 made `bulkIngest` populate the cache directly (zero DB calls for the ingest-then-read flow).
- **PR 3 (this one)** collapses the residual N-RTT cache-miss count to one batched RTT at session attach.

After this lands, the cold-grep timing on AU-East should be roughly equal to the warm-grep timing — i.e. the entire ~5.8 s of recoverable cold tax is gone, and only the ~3.7 s WASM bash IFS-dispatch floor remains. That floor is the next investigation; it is explicitly out of scope here per the issue's non-goals.

# IMPLEMENT — Issue #38, PR 1: Drop the read-transaction wrapper on the blob fetch path (`getBlobNoTx`)

> **Read this first if you're new to the issue.** This is the smallest, lowest-risk slice of issue #38 — a 5-line behavioural change behind one new dialect method. It removes ~70 % of the cold-grep tax with no interface change visible to agents and no schema change. Plan-only document — read all of §1–§3 before coding.

> Sister PRs (separate documents — do **not** roll into this one):
> - **PR 2** — `IMPLEMENT-issue-38-pr2-bulkingest-cache-seed.md` — populate `#contentCache` inside `bulkIngest` (free win at ingest).
> - **PR 3** — `IMPLEMENT-issue-38-pr3-prewarm-content-cache.md` — bulk prewarm at session attach (collapses N RTTs → 1).

---

## 1. Background — what is this and why

`virtualfs-api` exposes a `Bash` sandbox to AI agents over HTTP. Agents run real `grep`, `cat`, `awk` against real files; the filesystem itself is `SqlFs`, an `IFileSystem` implementation backed by Postgres. File contents live in a global, content-addressable `blobs` table keyed by `sha256`. Inodes carry a `content_sha256` pointing into that table. Reads go through an in-memory LRU `#contentCache` (50 MB cap, keyed by `inodeId`); on miss, the read falls through to a SQL fetch.

**The cold-grep measurement that motivated issue #38** (AU-East Postgres, 12 ms RTT, 125-file / 1.18 MB Python tree):

| Probe | Time | Notes |
|---|---|---|
| `find {root} -type f \| wc -l` | **630 ms** | metadata-only, pathCache hit |
| `grep -rn 'TODO' {root}` (cold, first content scan) | **9 410 ms** | 1 match; cache empty |
| `grep -rn 'TODO' {root}` (warm, repeated) | 6 760 ms | second run after cache fills |
| `grep -rn 'ZZZ_NEVER_MATCHES' {root}` (warm) | 3 755 ms | full scan, all served from cache |
| Same tree on local macOS | **9 ms** | reference floor |

Decomposition of the 9.4 s cold pass:

| Component | Estimate | Source |
|---|---|---|
| HTTP round-trip + bash startup | ~600 ms | matches the `find` baseline |
| WASM bash → IFS dispatch (open + read + close × 125) | ~3 000 ms | matches the warm-cache floor |
| **Per-blob read transaction wrapper** (`BEGIN` + `SET LOCAL` + `COMMIT`, ×125) | **~4 000 ms** | 3 RTT × 125 files — what this PR removes |
| Per-blob `SELECT data … WHERE sha256 = $1` (×125) | ~1 800 ms | 1 RTT × 125 files — addressed by PR 3 |

In other words, of the ~5.8 s of recoverable cold tax, **~4 s is spent in a transaction envelope that the read path doesn't need**. This PR removes that.

### Why the wrapper exists, and why it doesn't apply to blob reads

`SqlFs` uses two transaction helpers (`src/fs/sql-fs/sql-fs.ts:175-194`):

- `#withTx` — writers; sets `app.sandbox_id` for RLS *and* acquires the per-sandbox advisory lock so cross-replica writers serialize.
- `#withReadTx` — read-only paths; sets `app.sandbox_id` but skips the lock.

The read path uses `#withReadTx` to satisfy RLS policies on the `inodes` and `dirents` tables. That's correct for path resolution and inode lookup. But `#withReadTx` is *also* used to wrap `getBlob`, and that's where the waste is: the `blobs` table is **global** — see `src/fs/sql-fs/migrations/postgres/0000_create_tables.sql:38-44`:

```sql
-- Blobs: content-addressable store, global across all sandboxes.
-- sha256 is stored as raw BYTEA (32 bytes).
CREATE TABLE IF NOT EXISTS blobs (
    sha256  BYTEA   PRIMARY KEY,
    data    BYTEA   NOT NULL,
    size    BIGINT  NOT NULL DEFAULT 0
);
```

No `sandbox_id` column. No FK to `sandboxes`. No RLS policy. The `BEGIN` → `SELECT set_config('app.sandbox_id', …, true)` → `SELECT data FROM blobs WHERE sha256 = $1` → `COMMIT` round-trip sequence pays for an RLS context the table doesn't honor. **3 of the 4 RTTs per cache miss are pure overhead.**

### Threat model / why this is safe

- **Information disclosure across sandboxes?** No. SHA-256 is a 256-bit content hash. Knowing one sandbox's blob hashes does not let another sandbox enumerate or guess them; the blobs table is content-addressable global storage by design (see CLAUDE.md → Database Schema).
- **Cross-tenant access?** Only callers that already hold a valid `inode.content_sha256` can fetch the matching bytes. Inode lookup remains RLS-gated. The *path* from request → sha256 still goes through sandbox-scoped queries; only the final bytes-fetch is liberated from the wrapper.
- **Already deployed pattern.** `getBlob` already short-circuits to Redis L2 (`RedisBlobCache`) *before* hitting Postgres (`src/fs/sql-fs/dialects/postgres.ts:388-392`). Redis lookups have never been gated by RLS. This PR makes the Postgres path consistent with what Redis already does.

---

## 2. Current state — exact lines

You will edit / read these files:

| File | What's there now |
|---|---|
| `src/fs/sql-fs/types.ts:268` | `getBlob(tx, sha256)` declared on the `SqlDialect` interface. Keep as-is — used by `appendFile` and the GC path. Add `getBlobNoTx` next to it. |
| `src/fs/sql-fs/sql-fs.ts:189-194` | `#withReadTx` helper. Stays — used by path resolution. |
| `src/fs/sql-fs/sql-fs.ts:679` | `readFile` cache-miss: `await this.#withReadTx((tx) => this.#dialect.getBlob(tx, entry.contentSha256!))`. **Switch to `getBlobNoTx`.** |
| `src/fs/sql-fs/sql-fs.ts:697` | `readFileBuffer` cache-miss: identical pattern. **Switch to `getBlobNoTx`.** |
| `src/fs/sql-fs/sql-fs.ts:453` | `appendFile` reads the existing blob via `#withTx`+`getBlob`. **Leave alone** — `appendFile` is a writer; it's already inside the writer transaction and needs the lock. |
| `src/fs/sql-fs/dialects/postgres.ts:388-404` | Existing `getBlob(tx, sha256)`: Redis L2 check, then `tx\`SELECT data FROM blobs WHERE sha256 = ${sha256}\``, then async Redis backfill. Add the no-tx sibling next to it. |
| `src/fs/sql-fs/dialects/postgres.ts:73-76` | `private db()` returns the pool handle (or throws if not connected). Use it from `getBlobNoTx` to issue the SELECT directly against the pool. |
| `src/fs/sql-fs/migrations/postgres/0000_create_tables.sql:38-44` | Confirms `blobs` is global / no RLS. Reference only — no migration changes. |
| `src/fs/sql-fs/redis-blob-cache.ts:39-48` | `RedisBlobCache.get` — already non-blocking, fail-open. Reuse as-is. |
| `src/fs/sql-fs/sql-fs.bulkingest.test.ts`, `sql-fs.read-file.test.ts`, `sql-fs.cache-invalidation.test.ts` | Existing read/write tests that exercise the cache-miss path. They'll need to keep passing — and a new test asserts no transaction is opened on the read path. |
| `CHANGELOG.md`, `package.json`, `pnpm-lock.yaml`, `src/api/openapi-spec.ts` | Per CLAUDE.md, all four version fields must be bumped together (patch bump for this PR — perf/internal). |

### How `getBlob` is called today (the read miss path)

```ts
// src/fs/sql-fs/sql-fs.ts:679 (readFile) and :697 (readFileBuffer)
const data = await this.#withReadTx((tx) =>
  this.#dialect.getBlob(tx, entry.contentSha256!),
);
```

`#withReadTx` (line 189) expands to `dialect.transaction(async (tx) => { await dialect.setSandboxContext(tx, sid); return fn(tx); })`. On the wire this becomes:

1. `BEGIN`
2. `SELECT set_config('app.sandbox_id', $1, true)`
3. `SELECT data FROM blobs WHERE sha256 = $1`
4. `COMMIT`

Four serial round-trips. Three of them serve no purpose for a global table.

---

## 3. The change

Add a single new method `getBlobNoTx(sha256)` to `SqlDialect`. Implementation reuses everything `getBlob` already does (Redis L2, fire-and-forget Redis backfill) — the *only* difference is that it queries the pool directly instead of going through `dialect.transaction`.

### 3.1 `src/fs/sql-fs/types.ts`

Add to the `SqlDialect` interface, immediately after `getBlob` (line 268):

```ts
/**
 * Like `getBlob` but issues a single pool-level SELECT with no surrounding
 * transaction. Safe because the `blobs` table is global (no `sandbox_id`,
 * no RLS policy — see migrations/postgres/0000_create_tables.sql:40-44),
 * so the `app.sandbox_id` setting is meaningless on this read.
 *
 * Use from read paths (`readFile` / `readFileBuffer`) where eliminating the
 * BEGIN/SET LOCAL/COMMIT envelope removes 3 of 4 RTTs per cache miss.
 * Writers must keep using the in-transaction `getBlob` so the bytes they
 * fetch are consistent with the inode mutations they're about to make.
 *
 * Returns null if no blob with the given hash exists.
 */
getBlobNoTx(sha256: Uint8Array): Promise<Uint8Array | null>;
```

### 3.2 `src/fs/sql-fs/dialects/postgres.ts`

Place directly after `getBlob` (line 404):

```ts
async getBlobNoTx(sha256: Uint8Array): Promise<Uint8Array | null> {
  if (this.#blobCache !== undefined) {
    const cached = await this.#blobCache.get(sha256);
    if (cached !== null) return cached;
  }
  const rows = await this.db()<{ data: Buffer }[]>`
    SELECT data FROM blobs WHERE sha256 = ${sha256}
  `;
  const data = rows[0]?.data;
  if (!data) return null;
  const bytes = new Uint8Array(data);
  // Fire-and-forget Redis backfill — same pattern as `getBlob`. Next reader
  // hits Redis; if the SET hasn't completed yet they pay one more PG RTT,
  // which is still strictly better than the wrapper this method removes.
  if (this.#blobCache !== undefined) {
    void this.#blobCache.set(sha256, bytes);
  }
  return bytes;
}
```

Body intentionally mirrors `getBlob` (lines 388-404) line-for-line apart from the query target — keeping them parallel makes drift visible in code review.

### 3.3 `src/fs/sql-fs/sql-fs.ts`

Two call-site swaps. Line 679 (`readFile`):

```ts
// Before
const data = await this.#withReadTx((tx) => this.#dialect.getBlob(tx, entry.contentSha256!));

// After
const data = await this.#dialect.getBlobNoTx(entry.contentSha256!);
```

Line 697 (`readFileBuffer`): identical swap.

**Do not touch line 453** (`appendFile` reading the existing blob) — that call is *inside* the writer's `#withTx`, which legitimately needs RLS context for the inode and dirent mutations that follow it. Leaving `appendFile` on the `tx`-bound `getBlob` is correct.

### 3.4 What does **not** change

- `SqlDialect.getBlob` — kept. `appendFile` and any future writer that's already in a transaction call this.
- `#withReadTx` — kept. Path resolution (`#resolveReadEntry` at line 248) still uses it, and that *does* need RLS context.
- The Redis L2 contract — `getBlobNoTx` consults Redis first, exactly like `getBlob`. A warm Redis means the Postgres SELECT never runs.
- The `inodes` / `dirents` / `sandboxes` tables and their RLS policies — untouched.
- The IFileSystem contract — agents still call `grep`, `cat`, `awk`. Nothing observable from outside the dialect interface.

---

## 4. Acceptance criteria

1. **No transaction wrapper on the read miss path.** Unit test: a mock `SqlDialect` records every method call. `await fs.readFileBuffer('/some/file')` on a fresh sandbox (cache miss) must call `getBlobNoTx` exactly once and `transaction` / `setSandboxContext` zero times. Pre-PR, the same test would record one `transaction` and one `setSandboxContext`.
2. **Bytes are identical.** The same test asserts the bytes returned from `readFileBuffer` after the swap match the bytes the dialect mock was asked to return — no encoding regression.
3. **Redis L2 still wins when populated.** With a `RedisBlobCache` that has the sha256 cached, `getBlobNoTx` must return the Redis bytes and never call into the pool. Verified with a test that injects a stub Redis returning a non-null `getBuffer`.
4. **Async Redis backfill on Postgres-served reads.** With Redis enabled but cold, `getBlobNoTx` must return the Postgres bytes *and* schedule a Redis `set`. Assert via spy on the stub.
5. **`appendFile` unchanged.** The existing `sql-fs.write.test.ts` / append-related tests pass without modification — `appendFile` continues to use `getBlob` inside `#withTx`.
6. **No regressions.** `pnpm typecheck && pnpm lint:fix && pnpm test:unit` pass. Integration tests gated on `DATABASE_URL` continue to pass.
7. **Audit-trail observation (integration test, `DATABASE_URL` required).** Capture `pg_stat_statements` baseline; do 100 sequential cache-miss reads; verify *only* `SELECT data FROM blobs WHERE sha256 = $1` count grows. `BEGIN` / `SELECT set_config('app.sandbox_id', …)` / `COMMIT` deltas attributable to the read path must be zero.

---

## 5. Test plan

**Unit (Vitest, colocated)**

- `src/fs/sql-fs/sql-fs.read-tx.test.ts` (**new**):
  - `readFile` cache-miss calls `getBlobNoTx`, not `getBlob`. Mock dialect records calls; assert call counts.
  - `readFileBuffer` cache-miss calls `getBlobNoTx`, not `getBlob`. Same shape.
  - Mock dialect's `transaction` is **never** invoked on the read path.
  - `getBlobNoTx` returns `null` → `readFile` returns `''` (existing behaviour preserved by the `?? new Uint8Array(0)` at sql-fs.ts:680, 698).
  - With Redis stub returning bytes, `getBlobNoTx` does not call the pool query path (verified via dialect-internal spy).

- `src/fs/sql-fs/sql-fs.read-file.test.ts` (**update existing**): any test that mocked `getBlob` for the *read* miss must mock `getBlobNoTx` instead. Tests that mocked `getBlob` for the *append* miss stay as-is.

**Integration (`src/fs/sql-fs/integration/`)**

- `read-tx.integration.test.ts` (**new**, skipped without `DATABASE_URL`):
  - Ingest 100 small files. Capture `pg_stat_statements` snapshot.
  - Re-attach a fresh SqlFs (drops in-memory cache).
  - Read all 100 files via `readFileBuffer` in serial.
  - Assert: deltas show 100 new `SELECT data FROM blobs` calls and **zero** new `BEGIN` / `COMMIT` / `set_config` calls attributable to the read path.

**No e2e test required for this PR.** The end-to-end cold-grep timing improvement is best demonstrated *after* PR 3 lands (which is what eliminates the residual N-RTT `SELECT data` cost). For PR 1 alone, the unit + integration assertions above are sufficient to prove the wrapper is gone.

---

## 6. Risks and mitigations

| Risk | Mitigation |
|---|---|
| A future migration adds RLS to `blobs` (e.g. per-tenant content separation), making the no-tx path leak rows. | The new method's docstring calls out the global-table assumption explicitly. Add a code comment at the dialect call site referencing the migration that grants the assumption. If RLS is ever added to `blobs`, this method must be deleted in the same commit. |
| `RedisBlobCache.set` swallows errors today (`redis-blob-cache.ts:55-57`); a future change might let them throw. | Keep the `void` on the backfill call. Any change that lets `set` reject is an unrelated bug. |
| Drift between `getBlob` and `getBlobNoTx`. | Implementations are placed adjacent in `postgres.ts` and mirror each other line-for-line; reviewers can diff them in one screen. |
| MySQL / Azure SQL dialects diverge. | At time of writing the codebase only ships `dialects/postgres.ts` (verified: `ls src/fs/sql-fs/dialects/`). When a second dialect is added, it must implement both `getBlob` and `getBlobNoTx` with the same global-table reasoning — flag this in the dialect-implementation guide if/when it exists. |

---

## 7. Versioning

Per CLAUDE.md, bump together:

- `package.json` → `version` (patch bump from current top of `CHANGELOG.md`)
- `pnpm-lock.yaml` → run `pnpm install --lockfile-only`
- `src/api/openapi-spec.ts` → `info.version` field
- `CHANGELOG.md` → new dated section, e.g. `## [x.y.z] - YYYY-MM-DD`, with a `Changed` bullet:
  > Removed the per-blob read transaction wrapper from `readFile`/`readFileBuffer`. Cache-miss reads now issue a single pool-level SELECT instead of `BEGIN`/`SET LOCAL`/`COMMIT`/`SELECT`/`COMMIT`. ~70 % reduction in cold-grep latency on remote Postgres deployments. Internal change; no API surface impact.

---

## 8. Hand-off to PR 2 / PR 3

After this PR ships and the integration test confirms the wrapper is gone, capture a fresh cold-grep number against AU-East. The expected new shape is roughly:

- HTTP + bash startup: ~600 ms (unchanged)
- Bash IFS dispatch floor: ~3 000 ms (unchanged)
- Per-blob SELECT: ~1 800 ms (unchanged at this stage — PR 3 collapses this into 1 RTT)
- **Wrapper overhead: 0 ms (was ~4 000 ms)**

Total cold pass: ~5.4 s, down from ~9.4 s.

PR 3 (prewarm) and PR 2 (ingest seed) close the remaining gap. Their docs are siblings to this one and assume PR 1 has landed.

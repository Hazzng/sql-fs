# IMPLEMENT — Issue #38, PR 2: Seed `#contentCache` inside `bulkIngest`

> **Read this first if you're new to the issue.** This is a ~5-line behaviour change inside `SqlFs.bulkIngest`. It makes the very common ingest-then-read flow ("ship a repo into the sandbox, then `grep` over it") fully cache-warm with **zero** extra database calls. No new methods, no interface changes, no migration. Plan-only document — read all of §1–§3 before coding.

> Sister PRs (separate documents — independent of this one):
> - **PR 1** — `IMPLEMENT-issue-38-pr1-getblob-no-tx.md` — drop the read transaction wrapper.
> - **PR 3** — `IMPLEMENT-issue-38-pr3-prewarm-content-cache.md` — bulk prewarm at session attach.

---

## 1. Background — what is this and why

`virtualfs-api` exposes a sandboxed `Bash` to AI agents over HTTP. A common usage pattern is:

1. Agent creates a sandbox (`POST /v1/sandboxes`).
2. Agent uploads a code tree (`POST /v1/sandboxes/{id}/ingest-files` with a JSON manifest of base64 file contents — see `src/api/routes/ingest.ts:26`).
3. Agent runs commands that read those files: `grep -rn 'TODO' .`, `cat foo.py`, `awk …`, etc.

The cold-grep measurement that motivated issue #38 is exactly this flow against an AU-East deployment, on a 125-file / 1.18 MB Python tree. Cold first scan: **9.4 s**. Decomposition (per the issue):

| Component | Estimate | Addressed by |
|---|---|---|
| HTTP + bash startup | ~600 ms | — |
| WASM bash IFS dispatch (open + read + close × 125) | ~3 000 ms | out of scope |
| Per-blob read transaction wrapper × 125 | ~4 000 ms | **PR 1** |
| Per-blob `SELECT data` × 125 | ~1 800 ms | **PR 3** (this PR makes the count zero in the ingest-then-read case) |

This PR (PR 2) addresses the residual SELECTs *for the ingest-then-read flow specifically*. The insight is simple: when an agent ingests files, **the API already has the bytes in Node memory** — they came in over the wire, were parsed from base64, and were handed to `bulkIngest` as `BulkIngestFile[]` (`{ path, content, mode }`). Today those bytes are written to Postgres and then thrown away. The next `readFile` for the same file re-fetches them from Postgres. With a 5-line change, we keep them in `#contentCache` directly — first read is now a Map lookup.

This PR also fixes a smaller pre-existing oversight: when `bulkIngest` *replaces* an existing file, it correctly evicts the old inode's cached bytes (lines 386-391) but never populates the **new** inode's bytes, even though it has them. So even on the same-session ingest path today, the next read pays a DB round-trip for content the server just received.

### Why this is a "free win"

- **No new SQL.** `bulkIngest` already runs the writes inside one transaction; no extra round-trips here.
- **No new SQL surface.** Nothing changes in the dialect interface.
- **Bytes are already memory-resident.** They were just decoded from the request body. Stuffing them into the LRU is a Map insert — microseconds.
- **No new failure modes.** If the LRU fills, it evicts the oldest entries — same eviction behaviour as today's lazy-fill path.
- **Independent of PR 1 and PR 3.** Lands in any order.

### Why it's worth doing even after PR 3 (eager prewarm)

PR 3 batches one big SELECT at session attach to populate the cache. But the *first* time a sandbox is attached, prewarm has nothing useful to fetch (the sandbox was just created and is empty). Files only land via `bulkIngest`. Without PR 2, that first ingest-then-read still pays one bulk SELECT for content the server *just sent*. PR 2 makes it zero.

---

## 2. Current state — exact lines

You will edit / read these files:

| File | What's there now |
|---|---|
| `src/api/routes/ingest.ts:26-100` | `POST /v1/sandboxes/{id}/ingest-files` — parses JSON manifest, base64-decodes each file's contents into a `Buffer`, and calls `fs.bulkIngest(bulkFiles)` where `bulkFiles` is `BulkIngestFile[]`. **No code change required here.** |
| `src/fs/sql-fs/types.ts:97-102` | `BulkIngestFile = { path; content: Uint8Array; mode }`. The `content` field is the bytes we want to retain. |
| `src/fs/sql-fs/sql-fs.ts:375-395` | `SqlFs.bulkIngest` — the only function this PR edits. See §3 below. |
| `src/fs/sql-fs/sql-fs.ts:159-171` | `_contentCacheGet/Set/Has` internal helpers. We do **not** need to expose anything new — the change happens inside `bulkIngest` which has direct access to `this.#contentCache`. |
| `src/fs/sql-fs/sql-fs.ts:439` | `writeFile`'s cache-populate-on-write line — confirms the established pattern: write to DB, then `this.#contentCache.set(inodeId, bytes)`. PR 2 applies the same pattern to `bulkIngest`. |
| `src/fs/sql-fs/dialects/postgres.ts` (`bulkIngest` impl) | Returns `Map<path, PathCacheEntry>` — the new entries with their freshly-allocated `inodeId`s. **No change required.** |
| `src/fs/sql-fs/sql-fs.bulkingest.test.ts`, `sql-fs.bulkingest-edge-cases.test.ts` | Existing tests for `bulkIngest`. They'll need a new case asserting the cache is populated post-ingest. |
| `CHANGELOG.md`, `package.json`, `pnpm-lock.yaml`, `src/api/openapi-spec.ts` | Per CLAUDE.md, bump all four together (patch bump). |

### The current `bulkIngest` body, annotated

```ts
// src/fs/sql-fs/sql-fs.ts:375-395
async bulkIngest(files: BulkIngestFile[]): Promise<void> {
  if (files.length === 0) return;
  const normalized: BulkIngestFile[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const path = validatePath(file.path);
    if (seen.has(path)) throw createEexist(path);
    seen.add(path);
    normalized.push({ path, content: file.content, mode: file.mode });
  }
  const newEntries = await this.#withTx((tx) => this.#dialect.bulkIngest(tx, normalized));
  // Evict overwritten inodes from contentCache so stale content is never served.
  for (const [path, entry] of newEntries) {
    const old = this.#pathCache.get(path);
    if (old !== undefined && old.inodeId !== entry.inodeId) {
      this.#contentCache.delete(old.inodeId);   // <-- evicts old
    }
    this.#pathCache.set(path, entry);
    // <-- MISSING: populate cache with the new inode's bytes (we have them right here)
  }
  this.#dirty = true;
}
```

`newEntries` is a `Map<path, PathCacheEntry>` keyed by the same normalized path strings we already have in `normalized`. So we can look up the bytes for each entry by path, and stuff them into `#contentCache` keyed by the new `inodeId`. That's the entire change.

### Established pattern (already in `writeFile`)

`writeFile` already does this on the single-file write path (`sql-fs.ts:439`):

```ts
// after the write transaction commits
this.#pathCache.set(path, { ... });
if (bytes.byteLength > 0) this.#contentCache.set(inodeId, bytes);
this.#dirty = true;
```

PR 2 brings `bulkIngest` to parity with `writeFile`. There is no new policy here — only the same write-then-populate pattern, applied consistently.

---

## 3. The change

Two paths to consider — pick whichever produces the cleanest diff. Both are equivalent in behaviour. Recommend Path A.

### Path A (recommended) — index `normalized` by path, look up in the post-loop

```ts
async bulkIngest(files: BulkIngestFile[]): Promise<void> {
  if (files.length === 0) return;
  const normalized: BulkIngestFile[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const path = validatePath(file.path);
    if (seen.has(path)) throw createEexist(path);
    seen.add(path);
    normalized.push({ path, content: file.content, mode: file.mode });
  }
  const newEntries = await this.#withTx((tx) => this.#dialect.bulkIngest(tx, normalized));

  // Build a lookup for the bytes we already have in memory. The server just
  // received these from the request body; populating #contentCache here
  // means the next readFile is a Map lookup, not a SQL round-trip.
  const bytesByPath = new Map<string, Uint8Array>();
  for (const f of normalized) bytesByPath.set(f.path, f.content);

  for (const [path, entry] of newEntries) {
    const old = this.#pathCache.get(path);
    if (old !== undefined && old.inodeId !== entry.inodeId) {
      this.#contentCache.delete(old.inodeId);
    }
    this.#pathCache.set(path, entry);

    const bytes = bytesByPath.get(path);
    if (bytes !== undefined && bytes.byteLength > 0) {
      this.#contentCache.set(entry.inodeId, bytes);
    }
  }
  this.#dirty = true;
}
```

### Path B (alternative) — collapse the two passes

You can fold the index-build into the existing normalization loop. Slightly tighter:

```ts
const bytesByPath = new Map<string, Uint8Array>();
for (const file of files) {
  const path = validatePath(file.path);
  if (seen.has(path)) throw createEexist(path);
  seen.add(path);
  normalized.push({ path, content: file.content, mode: file.mode });
  bytesByPath.set(path, file.content);
}
```

…then the post-loop block uses `bytesByPath.get(path)` as in Path A. Functionally identical.

### Important invariants and edge cases

- **Cache key is `inodeId`, not path.** The LRU is keyed by inode id and `#contentCache.set(entry.inodeId, bytes)` is correct. Two paths that hash to the same blob (CAS dedup) will land at *different* inode ids; both must be cached independently so each `readFile` lookup hits.
- **Empty files.** Skip with `bytes.byteLength > 0` (matches `writeFile` line 439). Empty content is the only correctness reason — populating an empty `Uint8Array` would still work, but `readFile` already short-circuits on null/zero-byte blobs and the LRU cap should not be polluted.
- **LRU cap.** `#contentCache` has a 50 MB byte budget (`DEFAULT_CONTENT_CACHE_MAX_BYTES`, `sql-fs.ts:62`). A single ingest larger than 50 MB will see partial population; the LRU will evict in insert order. That's fine — the lazy-fill path (PR 1's `getBlobNoTx`, or PR 3's prewarm if it lands first) handles the overflow correctly. Do **not** pre-sort by size or anything — keep this PR mechanical.
- **Replacement semantics.** When `bulkIngest` overwrites an existing path, the existing line 390 already evicts the old inode's bytes. Our new line populates the *new* inode. Both are correct and operate on different inode ids.
- **Atomicity.** The cache writes happen *after* `#withTx` commits. If the transaction throws, no entries were added to `newEntries`, the loop body never runs, and `#contentCache` is untouched. Same atomicity story as the existing `pathCache` update.
- **Cross-replica coherence.** `bulkIngest` already sets `#dirty = true`, which causes the session-finalize hook to publish a new `version` so other replicas reload (Phase D logic, see `IMPLEMENT-multi-replica-redis.md`). This PR does not change that. Other replicas pick up the writes via their own `reload()`; they re-warm their own `#contentCache` lazily (or via PR 3's prewarm when that lands). No new coherence concern.

### What does **not** change

- `SqlDialect.bulkIngest` signature or behaviour.
- `bulkIngest`'s transaction shape, lock acquisition, or DB round-trip count.
- `writeFile`, `appendFile`, `readFile`, `readFileBuffer` — none of them edited.
- Ingest route handler (`src/api/routes/ingest.ts`) — no change.
- LRU cap, eviction policy, sizing function.

---

## 4. Acceptance criteria

1. **Cache populated after ingest.** Unit test: build an `SqlFs` with a mock dialect; call `bulkIngest([{path: '/a.txt', content, mode}])`; assert `_contentCacheGet(newInodeId)` returns the same bytes.
2. **Read after ingest issues zero DB calls.** Unit test: after `bulkIngest`, call `readFileBuffer('/a.txt')`; the mock dialect's `getBlob` / `getBlobNoTx` / `transaction` must all have call count zero.
3. **Empty files are not cached.** Unit test: `bulkIngest([{path: '/empty', content: new Uint8Array(0), mode: 0o644}])`; `_contentCacheHas(newInodeId)` is false. (Matches `writeFile`'s behaviour at sql-fs.ts:439.)
4. **Replacement path: old inode evicted, new inode populated.** Unit test: ingest `/x` with bytes A; capture `inodeId₁`. Ingest `/x` again with bytes B; capture `inodeId₂`. Assert `_contentCacheHas(inodeId₁) === false` (already true today) and `_contentCacheGet(inodeId₂)` returns B (new).
5. **CAS dedup: two paths sharing one blob each get their own cache entry.** Unit test: ingest `/a` and `/b` with identical content. Both inodes should have the bytes cached (keyed by their own `inodeId`, even though they share the same `content_sha256`).
6. **Empty input still no-ops.** `bulkIngest([])` returns immediately; cache untouched. (Existing line 376; assertion is just a regression guard.)
7. **No regressions.** `pnpm typecheck && pnpm lint:fix && pnpm test:unit` pass. `sql-fs.bulkingest.test.ts`, `sql-fs.bulkingest-edge-cases.test.ts`, `sql-fs.cache-invalidation.test.ts` all pass.
8. **End-to-end (manual / integration, optional).** Against a deployed instance: `POST /ingest-files` with a small tree, then `POST /exec-sync` running `cat <file>` for one of the just-ingested files. The exec response time should drop noticeably vs. baseline. Capture before/after in the PR body.

---

## 5. Test plan

**Unit (Vitest, colocated)**

Add to `src/fs/sql-fs/sql-fs.bulkingest.test.ts` (or a new `sql-fs.bulkingest-cache.test.ts` if the existing file is already large — keep the 300-line cap from CLAUDE.md):

- "populates contentCache for newly-ingested files" — covers AC 1.
- "readFileBuffer after bulkIngest issues zero dialect calls" — covers AC 2. Mock dialect with all blob/transaction methods spied; assert call counts.
- "skips empty files" — covers AC 3.
- "evicts the previous inode and populates the replacement" — covers AC 4.
- "two paths sharing identical bytes both end up cached" — covers AC 5.

**Integration (`src/fs/sql-fs/integration/`)**

- Optional: extend an existing ingest integration test (skipped without `DATABASE_URL`) to read each ingested file and assert the read does not increment a `pg_stat_statements` counter for `SELECT data FROM blobs`. This is a strong assertion but only feasible if the integration harness exposes statement counters. Skip if it adds too much scaffolding — the unit assertions above are sufficient.

**End-to-end (manual)**

Capture timing for `ingest-files` of a realistic 125-file tree, then `exec-sync` a `grep -rn` over it. With PR 1 alone the cold pass is ~5.4 s. With PR 1 + PR 2 it should be closer to ~3.7 s (the warm-cache floor) — i.e. the per-blob SELECTs disappear because the cache was warm from byte zero. Record both numbers in the PR description.

---

## 6. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Memory pressure: a huge ingest could blow the 50 MB cap. | LRU eviction is the existing safety net. Cap is unchanged. Behaviour matches the lazy-fill path under cap pressure. |
| `BulkIngestFile.content` is mutated by the caller after the call. | The bytes are stored by reference in `#contentCache`. Audit `src/api/routes/ingest.ts`: the bytes come from `Buffer.from(b64, "base64")` — a fresh allocation per request. Not retained or mutated by the caller. Safe. If a future caller passes a shared buffer, document the contract here ("`bulkIngest` retains the passed bytes; callers must not mutate after the call"). |
| The new pattern diverges from `writeFile`. | It doesn't — both follow "DB write, then `#contentCache.set(inodeId, bytes)`". Reviewer can diff `writeFile:439` against the new line in `bulkIngest` to confirm parity. |
| Future change to `dialect.bulkIngest` returns paths in a different normalized form than what the SqlFs loop sees. | The map keys are the *exact normalized paths* SqlFs passed in (the dialect echoes them). The unit test covering AC 1 catches a regression here immediately. |

---

## 7. Versioning

Per CLAUDE.md:

- `package.json` → patch bump
- `pnpm-lock.yaml` → `pnpm install --lockfile-only`
- `src/api/openapi-spec.ts` → `info.version`
- `CHANGELOG.md` → new dated section with one bullet under `Changed`:
  > `bulkIngest` now populates the in-memory content cache with the bytes it just received, eliminating a database round-trip on the very next read of an ingested file. No API surface change.

---

## 8. Hand-off

This PR is independent of PR 1 and PR 3. It can ship at any time after the existing `bulkIngest` tests are green. Order suggestion:

1. PR 1 lands first (biggest single win, 5-line read-path change).
2. PR 2 lands second (this PR — ingest-then-read goes to zero DB calls).
3. PR 3 lands third (prewarm at session attach — closes the re-attach / fresh-replica case).

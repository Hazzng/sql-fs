# Changelog

## 1.0.0

### Major Changes

- [#158](https://github.com/Hazzng/sql-fs/pull/158) Thanks [@Hazzng](https://github.com/Hazzng)! - Add a sandbox `git` command backed by just-git, export server `GITHUB_TOKEN` into sandbox GitHub-compatible Git/curl env, and let MCP-created sandboxes request network access for clone/fetch/push. A per-request `env.GITHUB_TOKEN` re-points git's HTTP credentials at that token, so an exec that overrides the token no longer pushes as the deployment identity. Each credential alias is derived on its own, so a request that pins one half (`GIT_HTTP_USER: "oauth2"` for a non-GitHub host, say) keeps it and still has the other half re-derived rather than inheriting the server's. Git's HTTP transport refuses plaintext `http://` remotes rather than putting those credentials on the wire in the clear. Redirects are followed by hand so every hop is checked before it is requested — a chain that dips through `http://` and back would otherwise look clean by the time the final response arrived — and crossing origins drops the credentials, as `fetch` does when it follows redirects itself. A redirected POST is rewritten to GET on 301/302/303 the way `fetch` rewrites it, so a push's packfile is never replayed at a host we were merely forwarded to, and each redirect's own body is cancelled rather than left holding a connection.

### Minor Changes

- [#162](https://github.com/Hazzng/sql-fs/pull/162) Thanks [@Hazzng](https://github.com/Hazzng)! - Add file access to MCP — `file_read`, `file_write`, `file_edit` — plus `PATCH /v1/sandboxes/:id/files/*path` for exact-string edits.

  MCP previously had no file tools at all, so agents had to reach every file through `bash_exec`: `cat` to read, heredocs to write, `sed -i` to edit. That means shell quoting for every path and payload, unbounded output on a large read, and — worst — `sed` silently patching the wrong line when the pattern is not unique.

  `file_edit` (and the matching `PATCH` route) replaces an exact string. `oldString` must match once unless `replaceAll` is true; an ambiguous match is rejected with `EDIT_NOT_UNIQUE` rather than applied to an arbitrary occurrence, so an agent working from a stale read cannot patch the wrong place. Rejections leave the file byte-identical, non-UTF-8 files are refused instead of being corrupted by lossy decoding, and an accepted edit preserves everything it did not match — the file's mode and a leading UTF-8 BOM included. On transaction-capable backends (Postgres) the read-modify-write runs in one script-tx scope, so a concurrent reader never observes the file mid-edit; backends without script-tx (in-memory) apply it directly. An edit whose result would exceed the write limit is refused from the projected size, before the new content is built. The request body is capped at the same limit as it streams, so a chunked `PATCH` carrying no `Content-Length` — or an under-declared one — is cut off rather than parsed. Editing this way moves ~1800x fewer bytes than read-modify-rewrite on a 128 KB source file, and keeps the file out of an agent's context window twice over.

  `file_read` returns structured content with size and line count, takes `offset`/`limit` to page a large file and `byteOffset` to resume a response that came back truncated — the wire cap is in bytes while paging is in lines, so a minified bundle on one 2 MB line would otherwise strand its own tail. Byte offsets are absolute in the file, so a resume does not depend on repeating the offset/limit that produced the truncated page; the cut lands on a codepoint boundary, and the cap holds against the JSON-escaped response rather than the raw bytes, where a megabyte of NULs would have serialized to six — refuses non-UTF-8 (`NOT_TEXT`), and bounds both the file it will open (`MAX_MCP_READ_FILE_BYTES`, 16 MB) and the bytes it returns (`MAX_MCP_READ_RESPONSE_BYTES`, 1 MB). `file_write` writes a whole file, creating parent directories, and refuses to clobber a directory on every backend rather than depending on the filesystem to catch it.

  HTTP and MCP share one implementation in `src/api/lib/file-ops.ts` — the edit contract, parent-directory creation and the write cap — so the two surfaces cannot drift on what an edit means. Whole-file writes stay per-surface. The route is documented in the OpenAPI spec.

### Patch Changes

- [#162](https://github.com/Hazzng/sql-fs/pull/162) Thanks [@Hazzng](https://github.com/Hazzng)! - Record how the single-file write cap translates into container sizing.

  Blob bytes are held in `external` memory rather than the V8 heap, so `--max-old-space-size` does not bound them and a cgroup OOM-kills the process instead. Measured on Linux (glibc, one replica, otherwise idle), a single write costs roughly 7x the file size above steady state, and steady state for an idle replica was around 300-400 MB — so at the 50 MiB default a single legal write needs headroom on the order of 700 MB, and a 512 MiB container was killed by one request while 768 MiB survived.

  Treat those as one measurement rather than a specification: the multiplier is the transferable part, the absolute numbers depend on replica baseline, concurrency, and how many large reads are warm at once. Size from `baseline + 7 x MAX_FILE_WRITE_BYTES x concurrent large writes`, and note that raising `MAX_FILE_WRITE_BYTES` above the contentCache cap adds a further ~2x retention per pool connection (the server now warns at startup when it is).

- [#162](https://github.com/Hazzng/sql-fs/pull/162) Thanks [@Hazzng](https://github.com/Hazzng)! - Apply the single-file write limit to each entry of a bulk write.

  `POST /writeFiles` checked only the combined size against `MAX_BULK_WRITE_BYTES`, which is larger than the per-file cap — so one oversized entry went through and landed a blob the contentCache cannot hold, the retention cliff `MAX_FILE_WRITE_BYTES` exists to avoid. Each entry is now checked against the same limit the single-file routes use.

- [#162](https://github.com/Hazzng/sql-fs/pull/162) Thanks [@Hazzng](https://github.com/Hazzng)! - Roll back a `PATCH` edit or bulk write when the distributed exec lock is definitively lost mid-request, instead of committing it and then reporting `ELOCKLOST`.

  `ELOCKLOST` is mapped to a retryable 503 on the promise that nothing committed — the exec path keeps that promise by aborting its script-tx scope before `endScope` (F2-L1), but the two write routes that open a scope of their own did not. `SessionScopedFs.run` commits as soon as its callback returns, and `withDistributedLock` only raises `LockLostError` afterwards, so a lease lost during a long read-modify-write left the edit durable while the client was told it was not written — and free to race the replica that took over the expired lease.

  Both routes now go through `runInScriptTx`, which makes the same lost-signal check inside the scope, so the rollback happens before the commit and the 503 stays true.

- [#162](https://github.com/Hazzng/sql-fs/pull/162) Thanks [@Hazzng](https://github.com/Hazzng)! - Refuse an edit whose `oldString` or `newString` carries an unpaired surrogate, and check the encoded result against the write limit.

  A file decoded from UTF-8 never holds a lone surrogate, but a caller can send one, and it matches half of a supplementary character. Re-encoding the result then turned the orphaned half into U+FFFD — rewriting bytes the edit never matched — and broke the size projection, whose arithmetic assumes a match encodes to the bytes it replaces: replacing the high surrogate of every `😀` in a 400-byte file under a 420-byte limit wrote 500 bytes and reported success. Such an edit is now rejected as `EDIT_LONE_SURROGATE` (400 on HTTP), and the write limit is enforced on the encoded result rather than on the projection alone.

- [#162](https://github.com/Hazzng/sql-fs/pull/162) Thanks [@Hazzng](https://github.com/Hazzng)! - Remove the destination of a `git clone` that fails partway, so a refused symlink can no longer leave a poisoned index behind.

  just-git writes the index in full while the checkout is still running, and both just-git (symlink targets that escape the worktree) and SqlFs (`allowSymlinks` defaults to false) abort mid-checkout on a symlink — roughly half of popular repos contain one. The clone exited non-zero but the half-built tree was committed, and because the index was complete `git status` reported every un-checked-out file as a staged deletion: ~2800 of them for `vitejs/vite`. An agent following a failed clone with `git add -A && git commit && git push` turned those into a real commit that deleted most of the tree.

  The `git` command now lives in `src/api/commands/git-command.ts` and removes what a failed clone left behind, leaving the sandbox as it was. The destination comes from just-git's own `preClone` hook rather than from parsing argv, so it is the path git actually resolved — argv parsing got `--bare` wrong and would have skipped cleanup entirely. A destination that already held files is never touched; one that existed but was empty is emptied again, which is the `git clone <url> .` case. Cleanup also runs when the command throws rather than exiting non-zero.

  Also adds `src/api/tests/integration/git-sqlfs.integration.test.ts`, which exercises git through `SessionManager` + SqlFs + Postgres — including the `GIT_HTTP_USER`/`GIT_HTTP_PASSWORD` basic-auth credentials the server actually injects, which had no coverage. The previous `git-network.integration.test.ts` used `InMemoryFs` and a bare `createGit()`, so it tested just-git rather than this service; it is renamed to `tests/unit/git-transport-contract.test.ts` to say so.

- [#162](https://github.com/Hazzng/sql-fs/pull/162) Thanks [@Hazzng](https://github.com/Hazzng)! - Refuse to replay a git request body across origins on a 307 or 308 redirect.

  Crossing origins already dropped the credentials, but 307 and 308 preserve the method _and_ the body — and for git that body is the packfile being pushed. `fetch` replays it cross-origin and leaves the caller to CORS, which does not apply server-side, so a remote an agent was talked into pushing to could forward the whole repository to a host of its choosing. Such a hop is now refused before the second request is made. Same-origin replay, and bodiless cross-origin redirects like a clone's `info/refs`, are unchanged.

- [#162](https://github.com/Hazzng/sql-fs/pull/162) Thanks [@Hazzng](https://github.com/Hazzng)! - Budget the whole `file_read` reply against `MAX_MCP_READ_RESPONSE_BYTES`, and normalize the path MCP tools echo back.

  The cap was applied to the content string alone, so the JSON envelope, the metadata and the echoed `path` were all added on top of a content page that had already filled it — a plain read came back 128 bytes over the limit. `toAbsolute` also only prefixed a slash rather than normalizing, and the backends resolve `..` themselves, so a caller could read `/f.txt` through a 250 KB path of redundant components and have every byte of it echoed back in the reply.

  Content is now sized against what is left after the envelope, paths are normalized before use, and the path argument is bounded at `PATH_MAX`. The read-cap tests assert the serialized reply rather than the content length, which is what the cap was always meant to describe.

- [#162](https://github.com/Hazzng/sql-fs/pull/162) Thanks [@Hazzng](https://github.com/Hazzng)! - Size a `file_read` page against the reply the transport actually sends, and stop splitting the whole file to count its lines.

  The budget measured the JSON the tool builds, but that string is serialized a second time inside the MCP JSON-RPC result, which re-escapes every backslash the first pass added. Content that escapes badly paid that twice: a page of NUL bytes trimmed to the 1 MiB cap left as 1,223,335 bytes on the wire, 170 KiB over. The page is now sized on the embedded form, so the cap describes what is sent.

  `file_read` also called `split("\n")` on the whole file to count lines and take a page, allocating one array slot per line — about 16 million of them for a newline-heavy file at the 16 MiB read limit, for a reply capped at 1 MiB. Lines are counted and located by scanning instead, so only the requested range is materialized.

- [#162](https://github.com/Hazzng/sql-fs/pull/162) Thanks [@Hazzng](https://github.com/Hazzng)! - Enforce the file-write limit on `PUT /v1/sandboxes/:id/files/*path` as the body streams, instead of trusting `Content-Length`.

  The route read the declared length, then buffered the whole body with `arrayBuffer()` and checked its size after the fact. A chunked upload carries no `Content-Length` at all and an under-declared one is free to lie, so either could be buffered up to the global 256 MB backstop — four times the route's own cap — before being rejected. The cap is now counted off the stream, which aborts the request at the limit. A declared length only ever shortens the work — a request claiming more than the cap is refused unread — but it is never taken as proof of what the body actually carries. An upload cut off at the cap cancels the incoming stream rather than leaving it open with nobody draining it. Oversized uploads still get the same 413 `PAYLOAD_TOO_LARGE` response.

- [#162](https://github.com/Hazzng/sql-fs/pull/162) Thanks [@Hazzng](https://github.com/Hazzng)! - Keep a leading UTF-8 BOM in what `file_read` and `fs_export` return.

  The default `TextDecoder` consumes a leading U+FEFF, so a file that began with one came back without it: reading a file and writing the content back stripped the marker, and because `stat.size` still counted those three bytes, every `nextByteOffset` sat three bytes off the file's own. `editFile` already decoded with `ignoreBOM` for exactly this reason; the read paths now match, so content round-trips byte for byte.

- [#162](https://github.com/Hazzng/sql-fs/pull/162) Thanks [@Hazzng](https://github.com/Hazzng)! - Fail a `file_read` explicitly when `MAX_MCP_READ_RESPONSE_BYTES` is configured below the size of a response envelope.

  The page budget can then fit no content at all: the reply exceeded the cap anyway and carried a `nextByteOffset` equal to the offset requested, so a client resuming from it would loop forever without advancing. It now returns `RESPONSE_BUDGET_TOO_SMALL` naming the setting.

- [#162](https://github.com/Hazzng/sql-fs/pull/162) Thanks [@Hazzng](https://github.com/Hazzng)! - Keep `file_read` paging identical to the `split`/`join` it replaced when a file ends in a newline.

  A newline-terminated file has a synthetic empty last line that starts at the end of the text, so deciding "is there a separator to drop?" from the offset alone treated a page ending on the final non-empty line as if it ran to EOF and returned a trailing newline that `split`/`join` would have dropped. `/lines.txt` holding `a\nb\nc\nd\n` read with `offset: 1, limit: 4` returned `a\nb\nc\nd\n` instead of `a\nb\nc\nd`. The decision is now made against the line count.

- [#162](https://github.com/Hazzng/sql-fs/pull/162) Thanks [@Hazzng](https://github.com/Hazzng)! - Ignore a relative `PWD` when recording a session's working directory instead of rooting it.

  `session.cwd` was normalized with a helper that prefixed a missing leading slash, so a script doing `export PWD=foo` stored `/foo` — a path with no reason to exist — and the `startsWith("/")` guard after it could never fail. A relative value is now dropped and the last known-good cwd kept, and the normalization helper no longer answers the "is this root-relative or cwd-relative?" question on its callers' behalf: the MCP tools root their argument themselves, which is their documented contract.

- [#162](https://github.com/Hazzng/sql-fs/pull/162) Thanks [@Hazzng](https://github.com/Hazzng)! - Build a `replaceAll` edit without allocating per occurrence.

  `split(oldString).join(newString)` materializes an array with one element per match before building the result — for a one-character `oldString` repeated through a file near the 64 MiB write limit that is tens of millions of slots, enough to exhaust the heap even though both the file and the edited result sit under the configured cap. The replacement is now assembled iteratively in flushed chunks: measured peak RSS for that worst case drops from 1184 MB to 357 MB (the `String.replaceAll` builtin, which also allocates per match, peaks at 2474 MB), with no regression on ordinary single-match edits.

- [#162](https://github.com/Hazzng/sql-fs/pull/162) Thanks [@Hazzng](https://github.com/Hazzng)! - Stop an abort that races the script-tx opening from killing the process.

  `#openScriptTx` publishes the abort handle before the only `await endPromise` is reached, so an abort arriving while the transaction's first statement is still in flight rejected a promise with no listener — fatal under Node's default `--unhandled-rejections=throw`. Connected directly to Postgres that window is microseconds wide; behind a connection pooler it is as wide as the pool's queue wait, where an exec timing out while queued crash-loops the replica. The rejection is now absorbed by a derived chain, which leaves the real handler's rollback untouched.

- [#162](https://github.com/Hazzng/sql-fs/pull/162) Thanks [@Hazzng](https://github.com/Hazzng)! - Stop a late-arriving transaction open from adopting into a finished scope, and refuse cache-served reads once a script-tx is lost.

  Two gaps in the fail-closed work. An abort can beat a queued `setSandboxContextWithLock`; when that statement resolved afterwards it still assigned its transaction, so the next scope inherited a rolled-back handle and skipped opening one of its own. Each open now carries a generation that the callback checks before adopting, and a new scope invalidates any open still in flight.

  Separately, `stat`, `readFile`, `readdir`, `exists` and `getAllPaths` are served from the in-memory caches and never touch the transaction helpers, so after a lost connection they handed back mutations the rollback was about to erase. The liveness check now sits inside the assertion itself, applied at those read entry points too.

- [#162](https://github.com/Hazzng/sql-fs/pull/162) Thanks [@Hazzng](https://github.com/Hazzng)! - Fail every remaining operation in a script scope once its transaction's connection is lost, instead of silently committing the rest outside the scope.

  `postgres.js` binds a transaction's `sql` to one connection object, and the pool reconnects that same object for the next root-`sql` query — which every write issues first, to write its blob. A write after the connection died therefore ran on a live but transaction-**less** connection and self-committed: a bulk write of 600 files answered HTTP 500 with 599 of them durable, the exact inverse of the atomicity that route promises. Clearing the handle alone was not enough, because the next write would open a fresh transaction that `endScriptScope` would then commit and report as success.

  No admin action is needed to reach it. A script scope pins one Postgres backend `idle in transaction` for the whole script, so `idle_in_transaction_session_timeout` — default-on or standard hardening on managed Postgres — plus any script that pauses between writes is sufficient; with the default pool size the process crashed rather than answering at all. The loss is now recorded and sticky for the rest of the scope, so a lost connection can only end in failure, and no query is ever handed to a dead connection.

- [#162](https://github.com/Hazzng/sql-fs/pull/162) Thanks [@Hazzng](https://github.com/Hazzng)! - Write a whole file through one shared, transactional path on both the MCP `file_write` tool and `PUT /v1/sandboxes/:id/files/*`.

  Each surface spelled the write out for itself — `ensureParentDir` then `writeFile`, outside any scope — which on a SQL backend is two independent transactions: a failed write left the directories it created behind, and a lease lost between them committed anyway while the caller was told the write had not happened and should be retried. The two copies had also drifted: MCP refused a write over a directory, `PUT` did not, so the same request silently clobbered a directory on the in-memory backend and raised `EISDIR` on Postgres.

  Both now call `writeFileAtPath`, which owns its script-tx scope the way `editFile` already does, so parents and file commit together, a lost lease rolls the whole write back, and `PUT` answers a directory target with `400 EISDIR` like the MCP tool.

- [#162](https://github.com/Hazzng/sql-fs/pull/162) Thanks [@Hazzng](https://github.com/Hazzng)! - Default the single-file write limit to the contentCache cap (50 MiB) instead of 64 MiB.

  The two are coupled by a memory cliff rather than by preference: a file the LRU accepts is retained once, while one it rejects is retained twice over, and again per pool connection that read it. Load testing measured the break exactly at the cache cap — 50 MiB costs 50 MB of live memory, 51 MiB costs 102 MB — so the 64 MiB default meant one large read pinned 256 MB per warm session for the full `SESSION_IDLE_MS`. Raising `MAX_FILE_WRITE_BYTES` past the cache cap is still possible, and now buys larger writes at roughly four times the memory each.

## 0.10.0

### Minor Changes

- [#157](https://github.com/Hazzng/sql-fs/pull/157) Thanks [@Hazzng](https://github.com/Hazzng)! - feat(observability): event-loop lag monitoring for the Redis leases (F8).

  The exec-lock writer lease, the RW-lock writer flag, and the RW-lock reader ZSET
  scores are all kept alive by `setTimeout` heartbeats that silently assume timers
  fire on schedule. A long event-loop stall (a V8 GC pause or a pathological
  synchronous bash stretch) can fire a renewal past the lease, voiding it — Lock 3
  keeps Postgres consistent, so this was always an observability gap, not a
  correctness bug, but nothing measured it.

  New `src/api/event-loop-monitor.ts` (purely observational, no behavior change):

  - A `perf_hooks.monitorEventLoopDelay` histogram started at boot, sampled every
    `EVENT_LOOP_MONITOR_INTERVAL_MS` (default 10s) and logged as
    `event:"event_loop_lag"` (`p50Ms`/`p99Ms`/`maxMs`/`meanMs`), then reset.
  - Per-heartbeat gap measurement wired into all three lease sites: each heartbeat
    reports actual-minus-expected fire time as `event:"heartbeat_gap"` at
    `severity:"warn"` (gap > renewMs) or `"critical"` (gap > leaseMs), tagged with
    the lock kind (`exec`/`rw-writer`/`rw-reader`) and key.

  Alert thresholds are documented in DEVELOPER.md ("Lock observability"). End-to-end
  smoke tests reproduce a >lease stall on each lease and assert the critical
  heartbeat_gap fires (with a no-stall control proving no false positives).

- [#156](https://github.com/Hazzng/sql-fs/pull/156) Thanks [@Hazzng](https://github.com/Hazzng)! - Heal stranded cross-replica version publishes after a Redis INCR failure (F3): a background drainer and reap-time best-effort publish flush the bump even if no further client traffic arrives or the session is idle-evicted.

- [#155](https://github.com/Hazzng/sql-fs/pull/155) Thanks [@Hazzng](https://github.com/Hazzng)! - fix(session): destroy now reaches warm sessions on other replicas (F7).

  Destroying a sandbox on one replica previously left warm sessions on other
  replicas serving ghost state: a written session would reload a deleted tree
  into an empty pathCache (surfacing as a non-zero exit + garbage stderr inside an
  HTTP 200 exec), and a never-written session would never reload at all because
  the deleted version key read as 0 and matched its `lastSeenVersion === 0`.

  Two layered fixes:

  - Primary (Redis-independent): `SqlFs.reload()` now detects a zero-row
    `loadAllPaths` — which for a live sandbox always returns at least its root dir
    — and throws a typed `ESANDBOXGONE` instead of installing an empty pathCache.
    The session manager catches it, tears the stale warm session down (drops it
    from the pool and disconnects the per-session Postgres pool), and surfaces a
    clean `ENOENT` → 404.
  - Secondary (tombstone): `destroy` now writes a distinct `DESTROYED` sentinel to
    the version key (with the version-key TTL) instead of deleting it.
    `ensureFreshCache` recognises the sentinel before the numeric parse and tears
    the session down — covering the never-written variant. Re-creating a
    tombstoned sandbox clears the sentinel and starts cleanly at version 0.

- [#153](https://github.com/Hazzng/sql-fs/pull/153) Thanks [@Hazzng](https://github.com/Hazzng)! - fix(lock): add bounded jitter + tunable retry to the distributed acquire loops (F9d, [#141](https://github.com/Hazzng/sql-fs/issues/141))

  The distributed exec lock and RW lock polled Redis on a flat `acquireRetryMs`
  (default 50 ms) interval, leaving competing replicas phase-aligned so a
  cross-replica writer could be repeatedly passed over (bounded by
  `acquireTimeoutMs`, then 503). Every acquire/drain poll now sleeps a jittered
  `retryMs/2 + random()*retryMs/2` (range `[retryMs/2, retryMs]`) to
  de-synchronize pollers. The retry interval is now configurable via
  `REDIS_EXEC_LOCK_ACQUIRE_RETRY_MS` (previously hardcoded — `server.ts` omitted
  it). Circuit-breaker / error-budget behavior is unchanged. The FIFO ZSET ticket
  queue is deferred as a follow-up.

- [#154](https://github.com/Hazzng/sql-fs/pull/154) Thanks [@Hazzng](https://github.com/Hazzng)! - perf(cache): O(1) pathCache byte accounting to avoid full-map scans (F9e, [#142](https://github.com/Hazzng/sql-fs/issues/142))

  SqlFs now maintains an incremental `#pathCacheBytes` counter, adjusted on
  every pathCache set/delete and reset on `reload()`/`ready()`, and exposes
  `getPathCacheBytes()`. SessionManager's path-cache memory budget calls it
  instead of re-walking the entire pathCache (`Σ path.length + 100`) on every
  dirty exec. The value equals the previous full-walk exactly. Falls back to
  the full walk for backends that do not expose the counter.

  The `#childrenByParent` children index (part B of [#142](https://github.com/Hazzng/sql-fs/issues/142)) is deferred to a
  follow-up; it is benchmark-gated and (A) delivers the higher-value, lower-risk
  win without touching readdir correctness.

## 0.9.0

### Minor Changes

- [#151](https://github.com/Hazzng/sql-fs/pull/151) Thanks [@Hazzng](https://github.com/Hazzng)! - fix(lock): abort the exec on definitive lease loss before commit (F2-L1)

  The distributed exec lock wrappers ran the critical section to completion and only
  then checked the loss flag, so a writer whose lease lapsed mid-script still
  committed its script-tx and bumped the version before throwing `ELOCKLOST` — a
  write that durably happened surfaced as an error, causing retrying agents to
  double-apply.

  The lock now wires its DEFINITIVE-loss signal (lease expiry / ownership taken —
  not transient renew blips) into an `AbortController` that is plumbed through to
  `bash.exec`. On a definitive loss the in-flight exec is aborted, its script-tx
  rolls back BEFORE any commit (no `INCR`), and the client receives a clean,
  retryable `ELOCKLOST` (now mapped to 503). Because just-bash treats an aborted
  run as a resolved result rather than a rejection, the runtime explicitly rolls
  back and re-raises `LockLostError` when the lock-lost signal fired, instead of
  committing the partial script. A plain timeout abort still commits (unchanged,
  audit L7) — only the dedicated lock-lost signal triggers rollback.

  This is Layer 1 of the F2 fix; the complete epoch/version fence is tracked
  separately ([#131](https://github.com/Hazzng/sql-fs/issues/131)).

- [#148](https://github.com/Hazzng/sql-fs/pull/148) Thanks [@Hazzng](https://github.com/Hazzng)! - fix(lock): circuit-break Redis acquire to stop the 300s outage fuse (F5)

  The distributed lock acquire loops conflated "lock busy" (contention) with "Redis
  unreachable" (a thrown connection error): both retried until `acquireTimeoutMs`
  (default 300 s), so a Redis outage hung every exec/file op for ~5 minutes on an
  otherwise-healthy Postgres.

  - New process-wide Redis circuit breaker (`src/redis/circuit-breaker.ts`) wired
    into the lock ACQUIRE paths only (`distributed-rw-lock.ts` shared/exclusive +
    `waitReadersDrained`, legacy `distributed-lock.ts`). After K (=5) consecutive
    connection-class failures it opens and acquire fast-fails 503 immediately; a
    successful eval/PING closes it. Renew/release paths are untouched (they keep
    tolerating transient errors to avoid dropping leases / leaking keys).
  - Separate short per-call error budget (`errorBudgetMs`, default 4 s) that
    advances only on thrown errors, so genuine contention still uses the full
    `acquireTimeoutMs` window.
  - `commandTimeout: 2000` on the ioredis client so commands reject promptly during
    an outage instead of queueing on the offline queue.
  - `/readyz` now PINGs Redis and returns 503 when Redis is configured but
    unreachable.
  - Fixed the stale `ownership.ts` docstring (the readOnly path DOES take a shared
    distributed lock).

- [#149](https://github.com/Hazzng/sql-fs/pull/149) Thanks [@Hazzng](https://github.com/Hazzng)! - fix(blob): commit the CAS blob upsert in its own short, self-committing
  transaction (own connection, no advisory lock) BEFORE the inode/dirent composite,
  and run the composite without its `blob_insert` CTE. This removes hot-blob
  contention (F6): previously the `ON CONFLICT (sha256) DO UPDATE SET
last_referenced_at = now()` tuple lock on a deduplicated hot blob (empty file,
  `.gitkeep`, common lockfiles) was held for the whole script, serializing
  unrelated sandboxes within one tenant DB and risking pool-exhaustion → 503. The
  touch stays unconditional so the GC grace window protects the freshly-committed
  blob until its inode commits; the blob-gc REPEATABLE READ + 40001 re-adoption
  handshake is preserved. Applies to `writeFile`, `appendFile`, and `bulkIngest`.

- [#150](https://github.com/Hazzng/sql-fs/pull/150) Thanks [@Hazzng](https://github.com/Hazzng)! - Surface a retryable `ESESSIONCLOSING` (HTTP 503) instead of a generic 500 when a request
  loses the reaper-vs-straggler race (F9c). A request that captured a session reference just
  before the idle/overBudget reaper marked it `closing` could run the pre-lock
  `ensureFreshCache` probe against a Postgres pool being disconnected, producing an unmapped
  error (e.g. `PostgresDialect: not connected`, which carries no `code`) that defaulted to a 500. Both pre-lock probe sites (`withSessionEntry`, `withSessionReadEntry`) now re-check the
  session state on probe failure and convert it into a clean, retryable `ESESSIONCLOSING`
  (already mapped to 503) so clients retry instead of seeing a non-retryable 500. No
  concurrency-model change.

## 0.8.0

### Minor Changes

- [#143](https://github.com/Hazzng/sql-fs/pull/143) Thanks [@Hazzng](https://github.com/Hazzng)! - Guard `publishVersionIfDirty` with a cache-poison flag (F1): when a correlated Postgres failure fails both the script-tx COMMIT and the recovery reload, the session no longer publishes a version/snapshot of uncommitted phantom state — it suppresses the INCR, forces a reload on next use, and surfaces ECOHERENCE.

- [#145](https://github.com/Hazzng/sql-fs/pull/145) Thanks [@Hazzng](https://github.com/Hazzng)! - fix(lock): when `REDIS_RWLOCK_ENABLED=false`, readers now take the same legacy single-key lock as writers (closing the F4 reader/writer race during rolling deploys), and `SqlFs.reload()` is a no-op while a script scope is open so a concurrent reload can never clobber an open writer's in-memory cache.

- [#144](https://github.com/Hazzng/sql-fs/pull/144) Thanks [@Hazzng](https://github.com/Hazzng)! - fix(cache): writeFile now evicts the displaced inode's contentCache entry on overwrite (including empty-file overwrite), preventing orphaned LRU weight (F9a, [#138](https://github.com/Hazzng/sql-fs/issues/138)).

- [#146](https://github.com/Hazzng/sql-fs/pull/146) Thanks [@Hazzng](https://github.com/Hazzng)! - Boot-assert that the session idle window (`SESSION_IDLE_MS` / `MCP_SESSION_IDLE_MS`) stays at or below half the Redis version-key TTL when Redis is enabled, failing fast on misconfiguration that would break cache coherence (audit F9b).

## 0.7.0

### Minor Changes

- [#120](https://github.com/Hazzng/sql-fs/pull/120) Thanks [@NeilMazumdar](https://github.com/NeilMazumdar)! - Add static-header (API-key) auth for the MCP endpoint so external clients that can only send fixed headers — e.g. LibreChat — can connect without minting a per-request JWT. Set `MCP_API_KEY` to accept a pre-shared `Authorization: Bearer <key>`; the sandbox owner (`sub`) is derived from a forwarded identity header (`MCP_IDENTITY_HEADER`, default `x-librechat-user-id`), giving each end-user an isolated sandbox. New env vars: `MCP_API_KEY`, `MCP_IDENTITY_HEADER`, `MCP_DEFAULT_SUB`, `MCP_STATIC_TENANT`. Static auth is additive and off unless `MCP_API_KEY` is set — JWT clients on `/mcp` and all `/v1/*` routes are unchanged.

  Startup hardening: `MCP_IDENTITY_HEADER` cannot be a reserved transport header (`authorization`, `cookie`, `content-type`, `accept`, `mcp-session-id`, `mcp-protocol-version`, `last-event-id`) — otherwise every request would derive `owner` from a shared value and collapse all users into one sandbox. The `mcp_static_auth_enabled` startup log records only whether a fallback owner is configured (`hasDefaultSub`), never the `MCP_DEFAULT_SUB` value.

- [#125](https://github.com/Hazzng/sql-fs/pull/125) Thanks [@Hazzng](https://github.com/Hazzng)! - feat(gc): multi-tenant orphan-blob garbage collection via `pnpm db:gc`.

  Restores the `pnpm db:gc` CLI as a real, multi-tenant orphan-blob sweep for an external scheduler (cron / k8s CronJob). Orphan blobs (rows in `blobs` referenced by zero `inodes`) previously accumulated forever.

  - New migration `0006` adds `blobs.last_referenced_at` (instant, catalog-only — legacy rows stay NULL and are treated as ancient/collectible). Every blob reference (insert + dedup re-adoption) now bumps it via `ON CONFLICT (sha256) DO UPDATE`, which also touches the blob so the grace window tracks real usage.
  - `gcOrphanBlobs` rewritten to a null-safe `NOT EXISTS` anti-join with a grace window (`minAgeMs`), returning the deleted sha256s. It runs with no sandbox context (RLS escape) so the anti-join sees every inode; a blob referenced by another sandbox survives.
  - The sweep runs at **REPEATABLE READ with bounded retries** to close the dedup re-adoption race: under READ COMMITTED a concurrent writer that re-adopts an existing orphan blob could leave its committed inode without content (the GC's `NOT EXISTS` re-check keeps a stale snapshot of `inodes`). REPEATABLE READ turns that conflict into a serialization failure that is retried, so even `--min-age-ms 0` is safe under concurrent writes.
  - Deleted blobs are purged from the tenant-scoped Redis blob cache (`RedisBlobCache.mdel`, fail-open).
  - New env `BLOB_GC_MIN_AGE_MS` (default 3h) sets the grace window; `pnpm db:gc -- --min-age-ms 0` collects all orphans now, `--tenant <id>` restricts to one tenant.

### Patch Changes

- [#122](https://github.com/Hazzng/sql-fs/pull/122) Thanks [@Hazzng](https://github.com/Hazzng)! - Fix local Postgres dev setup for the integration test suite ([#119](https://github.com/Hazzng/sql-fs/issues/119)).

  - Add `docker-compose.local.yml` (Postgres 16 + Redis 7). Its `initdb` script
    (`scripts/initdb/00-create-app-role.sql`) provisions a **non-superuser** `sqlfs_app`
    role that owns the `sqlfs` database — required because migration `0005` enables
    `FORCE ROW LEVEL SECURITY`, which a superuser silently bypasses (the RLS isolation
    tests fail under the default `postgres` superuser). The file was previously
    referenced by the README but `.gitignore`d, so it could never be committed.
  - Document the non-superuser-owner requirement and the full local-DB workflow in
    `CONTRIBUTING.md` (new "Local database" section).
  - Correct the `DATABASE_DIRECT_URL` row in the README env table: it is optional and
    used only by drizzle-kit (`pnpm db:generate`); the server's boot-time migration
    runner uses `DATABASE_URL`.
  - Update `.env.example` defaults to match the compose stack.
  - Remove the broken, unused `pnpm db:migrate` script (drizzle-kit `migrate` with no
    journal). Migrations are applied automatically on server boot.

- [#125](https://github.com/Hazzng/sql-fs/pull/125) Thanks [@Hazzng](https://github.com/Hazzng)! - fix(fs): delete inodes when their link count reaches zero (no `nlink=0` tombstones).

  The Postgres `rmComposite`, `writeFileComposite`, and `mvComposite` paths decremented an inode's `nlink` and deleted it (when it hit 0) within a single CTE statement. Postgres applies **only the UPDATE** when a row is both updated and deleted in one statement, so the inode was left at `nlink=0` instead of being removed — a tombstone that still referenced `content_sha256`. This pinned the blob (defeating the new orphan-blob GC, whose anti-join saw the tombstone) and leaked inode rows on every file delete, overwrite, and move-overwrite.

  Each path now splits the work into two mutually-exclusive branches against the statement snapshot — delete when `nlink <= 1`, decrement when `nlink > 1` — so each inode row is touched exactly once. `gcOrphanBlobs` additionally ignores `nlink = 0` inodes so blobs pinned by tombstones left behind by older builds become collectible. Hardlinked inodes are unaffected (still decremented, not deleted, while other links remain).

## 0.6.3

### Patch Changes

- [#113](https://github.com/Hazzng/sql-fs/pull/113) Thanks [@Hazzng](https://github.com/Hazzng)! - Fix `POST /v1/sandboxes/:id/ingest-files` returning 500 (Internal Server Error) for files larger than ~750 KB. `isValidBase64` ran a structural regex whose `(?:[A-Za-z0-9+/]{4})*` quantifier overflowed V8's call stack (`RangeError: Maximum call stack size exceeded`) on base64 strings beyond ~1 MB — failing during request validation, before any database work. The regex is now skipped for strings over 1 MB, relying solely on the canonical round-trip check (`Buffer.from(s, "base64").toString("base64") === s`), which is native and never overflows. Ingesting multi-MB files now succeeds.

## 0.6.2

### Patch Changes

- [#111](https://github.com/Hazzng/sql-fs/pull/111) Thanks [@Hazzng](https://github.com/Hazzng)! - Flatten `src/fs/sql-fs/` to `src/sql-fs/`. The intermediate `fs/` directory had no purpose — `sql-fs` was its only child. No behaviour change.

## 0.6.1

### Patch Changes

- [#109](https://github.com/Hazzng/sql-fs/pull/109) Thanks [@Hazzng](https://github.com/Hazzng)! - Fix dev server env loading and portless config: add --env-file .env to tsx watch, rename portless tunnel to sql-fs

## 0.6.0

### Minor Changes

- [#107](https://github.com/Hazzng/sql-fs/pull/107) Thanks [@Hazzng](https://github.com/Hazzng)! - Security & correctness hardening from the sql-fs audit.

  **Critical**

  - Remove the `py-exec` warm-host-Python command and delete its module entirely. It spawned the host `python3` with the full server environment — a sandbox escape (RCE + secret/credential exfil). Python sandboxes now run only via the isolated WASM `python3` (`python3 -c …` / `python3 script.py`), and the skill/SDK docs were updated accordingly. Rotate `AUTH_SECRET` and DB credentials.

  **Authorization & info-leak**

  - Ownership checks are now fail-CLOSED: an empty/unknown sandbox owner no longer grants access to every authenticated caller.
  - `fs_ingest` authorizes the caller BEFORE reading any host files (no pre-auth host-read / readability oracle).
  - MCP tool handlers sanitize errors before returning them (no raw SQL/connection/host-path text); `sandbox_create` is now wrapped too.
  - Sandbox ids are validated before being interpolated into Redis lock/version keys.

  **Isolation**

  - Enable + FORCE Row-Level Security on `inodes`, `dirents`, and `sandboxes` (migration 0005). Trusted context-free server operations (blob GC, listing, create) keep working; client-reachable, context-scoped queries are confined to their sandbox.

  **Correctness**

  - Reject clobbering a directory (EISDIR), moving onto a non-empty directory (ENOTEMPTY), and writes/moves/copies to `/`.
  - `cp` of a symlink preserves the link instead of creating a corrupt file inode; `stat()` follows relative/multi-hop symlinks; `chmod`/`utimes` update all hardlink siblings in cache.
  - Durable cross-replica version counter (TTL refreshed on access); no version/snapshot published when a script-tx COMMIT fails.
  - `mvComposite` overwrite no longer raises a spurious EEXIST.
  - Bulk write (`writeFiles`) is atomic — a mid-batch failure rolls back the whole batch. This required composite writes (`writeFile`/`mkdir`/`mv`/`rm`) to join the open script-tx instead of running in their own auto-committing transaction, which also makes multi-write bash scripts truly atomic on Postgres. Nested initial files create parent dirs.
  - Distributed lock heartbeats retry transient renew failures instead of abandoning a still-valid lease.

  **Resource bounds & response hardening**

  - Global request body-size limit; ingest count/byte caps + bounded host-read concurrency; bounded `/tree` and `fs_export`.
  - File-read responses send `X-Content-Type-Options: nosniff`, `Content-Disposition: attachment`, and a locked-down CSP.

  **Operational**

  - Migration runner takes a Postgres advisory lock to serialize concurrent multi-replica boots.
  - SSE exec always emits a terminal event; `ESHUTTINGDOWN` maps to a retryable 503; request logging now runs for `/v1/*` and `/mcp`; assorted lock/stream lifecycle fixes.

### Patch Changes

- [#105](https://github.com/Hazzng/sql-fs/pull/105) Thanks [@Hazzng](https://github.com/Hazzng)! - Make defense-in-depth compatible with Postgres on just-bash 3.x. just-bash 3.x freezes `Error.stackTraceLimit` during `bash.exec`, which the `postgres` driver assigns to (breaking every query). All SqlFs DB chokepoints now route through `runTrustedDbAsync`, which re-opens `Error.stackTraceLimit` writability before trusted DB I/O. No-op on just-bash 2.x (the property is never frozen there).

## 0.5.0

### Minor Changes

- [#103](https://github.com/Hazzng/sql-fs/pull/103) Thanks [@Hazzng](https://github.com/Hazzng)! - Add `paths` param to `fs_ingest` MCP tool. Pass `{ relativePath: absoluteHostPath }` and the server reads bytes directly from the host filesystem — no base64 encoding, no file content generated as output tokens. Matches py-sdk `ingest_files()` performance. `files` (inline base64) is kept for small generated content but is now the exception path.

## 0.4.2

### Patch Changes

- Thanks [@Hazzng](https://github.com/Hazzng)! - Rebranding the repo as sql-fs

## 0.4.1

### Patch Changes

- [#95](https://github.com/Hazzng/sql-fs/pull/95) Thanks [@Hazzng](https://github.com/Hazzng)! - Add `durationMs` to `BatchScriptResult` so agents can profile individual script latencies inside a batch execution.

- [#96](https://github.com/Hazzng/sql-fs/pull/96) Thanks [@Hazzng](https://github.com/Hazzng)! - Fix GET /v1/sandboxes/:id returning stale createdAt and transient 404 after session eviction. The route now falls back to the database when the session is not in the in-memory pool, and createdAt is sourced from the DB RETURNING clause on creation and restored from DB meta on rehydration so all three endpoints (POST, GET, LIST) agree on the same timestamp.

## 0.4.0

### Minor Changes

- [#86](https://github.com/Hazzng/sql-fs/pull/86) Thanks [@Hazzng](https://github.com/Hazzng)! - feat(py-exec): add warm Python interpreter to eliminate 1.4s startup cost per invocation

  Introduces `py-exec`, a new bash command available in `python=true` sandboxes that routes Python execution through a persistent `python3` process instead of spawning a fresh CPython/WASM worker on every call.

  **Before:** `python3 -c 'print(1)'` → ~1.4 s per call (WASM cold boot)
  **After:** `py-exec -c 'print(1)'` → ~30–50 ms per call after first use

  The warm process uses a base64-encoded stdin/stdout turn protocol so arbitrary Python code (including multi-line scripts and `sys.exit()`) works safely without shell-quoting hazards. Variables persist across calls in the same session (stateful REPL semantics).

  The built-in `python3` command is still available for isolated, stateless execution.

## 0.3.10

### Patch Changes

- [#85](https://github.com/Hazzng/sql-fs/pull/85) Thanks [@Hazzng](https://github.com/Hazzng)! - fix(session-manager): persist cwd across exec calls

  `cd` executed inside a `bash.exec()` call was silently discarded because
  just-bash runs each call against a **copy** of the interpreter state;
  `bash.getCwd()` never changed. The next `exec` always started from the
  initial home directory (`/home/user`), causing agents that relied on `cd`
  for path convenience to silently grep or operate on the wrong directory.

  Fix: track `session.cwd` on each `Session` object (initialised from
  `bash.getCwd()` at creation). Before every `execWithRuntimeThrottle` call
  the tracked cwd is forwarded as `opts.cwd` (unless the caller already
  supplied an explicit `cwd`). After every **non-readOnly** exec the final
  working directory is read from `result.env.PWD` (always populated by
  just-bash) and stored back on `session.cwd`, so the next call starts
  from the correct directory.

  Semantics chosen: cwd is session-scoped and per-sandbox. It resets to
  `/home/user` only when the session is evicted (idle timeout or explicit
  destroy). readOnly execs use the current `session.cwd` as their starting
  directory but do not update it, consistent with the read-only contract.

  Note: env variables set via `export` inside a script also do not persist
  across exec calls — this is symmetric with the cwd behaviour and is the
  correct just-bash design. The issue report's claim that env persists was
  incorrect; only cwd needed fixing.

  Closes [#73](https://github.com/Hazzng/sql-fs/issues/73).

## 0.3.9

### Patch Changes

- [#81](https://github.com/Hazzng/sql-fs/pull/81) Thanks [@Hazzng](https://github.com/Hazzng)! - just-bash's built-in nodeStubCommand (registered alongside js-exec when javascript=true) ignores all arguments and unconditionally prints the full 60-line js-exec --help page to stderr before exiting 1. Added src/api/commands/node-command.ts — a custom Command that replaces the built-in stub via BashOptions.customCommands (which takes precedence over built-ins with the same name). Custom commands are only injected when javascript: true; non-JS sandboxes are unaffected.

## 0.3.8

### Patch Changes

- [#79](https://github.com/Hazzng/sql-fs/pull/79) Thanks [@Hazzng](https://github.com/Hazzng)! - Python SDK: expose `read_only` parameter on `Sandbox.exec_batch()`. When `read_only=True`, the request forwards `readOnly: true` to the server, activating parallel script execution under a shared read-lock. Defaults to `False` (sequential, write-lock) for full backward compatibility.

## 0.3.7

### Patch Changes

- [#69](https://github.com/Hazzng/sql-fs/pull/69) Thanks [@Hazzng](https://github.com/Hazzng)! - Parallel readOnly batch execution. POST /exec-sync-batch and MCP bash_exec_batch now run scripts in parallel when readOnly: true, bounded at 16 concurrent workers. Result order is preserved. Write-path batches are unchanged (sequential, exclusive lock). MCP client disconnects now propagate into in-flight scripts via extra.signal forwarding.

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.3.6

### Patch Changes

- 8d50059: add distributed lock for R-W so strong consistency is enforced

## [0.3.4] - 2026-05-13

### Added

- Cross-replica reader-writer exec lock (`withDistributedRWLock`, `src/api/distributed-rw-lock.ts`). Parallel `readOnly` execs now run concurrently across replicas while writers maintain strong cross-replica consistency: writers take an exclusive Redis flag, readers register a TTL'd entry in a per-sandbox ZSET, and writer-priority prevents reader starvation. `SessionManager.withSessionRead` acquires the new shared lock; `withSession` / `withExistingSession` / `withSessionOrRehydrate` use the exclusive path. New env vars: `REDIS_RWLOCK_ENABLED` (default `true`, deploy-window flag) and `REDIS_RWLOCK_READER_LEASE_MS` (default `60000`). Issue #61.
- Integration suite `cross-replica-rw-lock.integration.test.ts` covering parallel cross-replica readers, writer/reader blocking both directions, writer-priority under continuous readers, crashed-reader reaping, and version visibility after writes.

### Changed

- `rwLockKeys()` now wraps the sandbox id in a Redis Cluster hash tag (`vfs:{tenant}:rwlock:{<sandboxId>}:writer` / `…:readers`) so the two-key Lua scripts route to the same slot under Redis Cluster.

### Fixed

- `DistributedRWLockOptions` validation now requires `renewMs < readerLeaseMs` in addition to `renewMs < leaseMs`. Without this, a misconfigured `REDIS_RWLOCK_READER_LEASE_MS` shorter than `REDIS_EXEC_LOCK_RENEW_MS` could let a writer reap a live reader's ZSET entry between heartbeats and enter the critical section while a read was still in flight.

## [0.3.3] - 2026-05-11

### Changed

- `DEVELOPER.md`: documented the parallel-readOnly architecture. Core Data Flow now covers both write (`runExclusive`) and read (`runShared`) paths; Lock 1 rewritten as the `RWLock` (writer-priority, batch-wake, AbortSignal); new "ReadOnly Safety Model" section explains the three cooperating mechanisms (shared lock + refcounted FS scope + `readOnlyContext` AsyncLocalStorage attribution) and the `EREADONLY` → `EREADONLY_VIOLATION` remap; same-replica concurrency matrix and "what each lock catches" table extended for readOnly; Key Source Files lists `rw-lock.ts`, `read-only-context.ts`, `ownership.ts`, and `mcp/tools.ts`.

## [0.3.2] - 2026-05-11

### Added

- `portless` dev dependency, `portless.json` (`sql-fs-api`), and `pnpm dev:portless` to run the dev server behind stable `https://…localhost` URLs (including per-branch subdomains in git worktrees).

## [0.3.1] - 2026-05-11

### Fixed

- ReadOnly bash exec: a synchronous `EREADONLY` thrown by `SqlFs#assertWritable` that escapes `bash.exec` (e.g. via shell redirections like `echo x > /file`) is now remapped to `EREADONLY_VIOLATION` in `withSessionReadEntry`, so route handlers consistently return HTTP **422** instead of falling through to the generic 500. The narrow `code === "EREADONLY"` check preserves the existing behavior of letting unrelated `fn` errors win over a recorded violation.

## [0.3.0] - 2026-05-10

### Added

- Parallel readOnly bash exec on the same sandbox (single-replica). Callers opt in by passing `readOnly: true` on `/v1/sandboxes/:id/exec`, `/exec-sync`, `/exec-sync-batch`, and the MCP `bash_exec` / `bash_exec_batch` tools. ReadOnly execs route through the new `SessionManager.withSessionRead`: they take a per-session async readers-writer lock in _shared_ mode (multiple readers run concurrently), skip the distributed exec lock, and share one single-flighted `ensureFreshCache` probe + reload across the cohort. Writes still take the lock exclusively and are writer-priority — a queued writer blocks new readers, preventing reader starvation.
- Read-only safety net on `SqlFs`: while a read-only scope is active every mutating syscall (`writeFile`, `appendFile`, `mkdir`, `rm`, `chmod`, `utimes`, `cp`, `mv`, `symlink`, `link`, `bulkIngest`) throws `EREADONLY` _before_ any DB work. The scope is **reference-counted** so multiple concurrent readers share a single FS instance safely. Violation attribution uses an `AsyncLocalStorage`-based `readOnlyContext` so a lying script in one reader never falsely flags innocent concurrent readers — only the originating call's context is marked, and the session manager surfaces `EREADONLY_VIOLATION` (HTTP **422**) on that one call. Violations are emitted via `logAudit("read_only_violation", ...)`.
- New async readers-writer lock primitive `RWLock` (`src/api/rw-lock.ts`) replaces `async-mutex`'s `Mutex` on `Session`. Drop-in `runExclusive` for existing call sites plus a new `runShared`. AbortSignal support cancels pending acquisitions cleanly.
- OpenAPI spec documents the new `readOnly` request field on `/exec-sync`, `/exec`, and `/exec-sync-batch`, and the corresponding 422 response.

### Changed

- `Session.mutex: Mutex` is now `Session.lock: RWLock`. The `async-mutex` runtime dependency is no longer used by `SessionManager`. All exclusive-mode call sites (`withSessionEntry`, `destroy`, reaper, shutdown) are unchanged in semantics.
- `execWithRuntimeThrottle` skips the per-script `scriptTx.beginScope/endScope` wrapper when the call is inside a `readOnlyContext` (no writes can occur, and the shared `SessionScopedFs` would race across concurrent readers).
- `withSessionReadEntry` is now wrapped in `try/finally` so `session.inFlight` and `endReadOnlyScope` always run even when `fn` throws — fixes a counter leak that pinned sessions and prevented idle eviction.

## [0.2.20] - 2026-05-09

### Fixed

- `SessionManager.getOrCreate()` refuses new sessions once `shutdown()` has begun (checked at entry and again after `buildFs()` returns) so a request accepted before shutdown cannot register a session after the shutdown snapshot, leaking its dialect pool.
- Reaper now marks `state="closing"` before deleting and drains via `mutex.runExclusive` before disconnecting, so a request that already captured the session reference but has not yet entered the mutex observes `ESESSIONCLOSING` instead of running against a disconnected filesystem.
- Raw `PUT /v1/sandboxes/:id/files/*` pre-checks `Content-Length` and rejects oversized uploads (`PAYLOAD_TOO_LARGE`) before buffering the request body.
- Distributed lock heartbeat stops scheduling further `EVAL` renewals once the lock is lost or a renew times out, preventing command pile-up in the ioredis send queue when Redis is hung.
- `RedisBlobCache.mget()` chunks calls at 1024 keys per round-trip to bound peak reply size on warm sandboxes with large blob counts.

## [0.2.19] - 2026-05-09

### Fixed

- Wired production lifecycle: `SessionManager.startReaper()` and `startMcpSessionSweeper()` called at boot; `SIGTERM`/`SIGINT` now runs a full ordered shutdown — MCP transports → session drain + FS disconnect → meta dialects → Redis `quit()`.
- Postgres pool caps on `PostgresDialect.connect()` (`max: 2`, `idle_timeout: 30s`, `connect_timeout: 30s`, `max_lifetime: 30m`) to prevent connection exhaustion under load.
- `createPostgresSandboxFs()` now disconnects the dialect on any post-`connect()` failure (sandbox bootstrap, `fs.ready()`, etc.) so pools cannot leak on setup errors.
- `SessionManager.getOrCreate()` disconnects the created FS if session construction throws after `buildFs()` returns.
- `SessionManager.destroy()` disconnects the FS in a `finally` block so the pool is always released even when `destroySandboxFn` or Redis cleanup throws.
- `publishVersionIfDirty()`: Redis `INCR` failure now surfaces as `ECOHERENCE` (HTTP 503), sets `publishPending` for retry on the next turn, and forces a reload via `lastSeenVersion = -1`. Previously the failure was silently swallowed.
- Distributed lock heartbeat replaced `setInterval(async)` with a sequential `setTimeout` chain to prevent overlapping Redis `EVAL` commands under slow Redis; renewal command is now bounded by `Promise.race`.
- Runtime semaphore waiters are now abort-aware: cancelled via `AbortSignal`, evicted on per-waiter timeout, and bounded by `MAX_PYTHON_QUEUE`/`MAX_JS_QUEUE`. Backpressure surfaces as `ERUNTIME_BUSY` (HTTP 503).
- Added `SessionManager.shutdown()` for graceful drain and FS disconnect of all live sessions.
- Added MCP session TTL (`MCP_SESSION_IDLE_MS`), cap (`MCP_SESSION_MAX`), idle sweeper, and `shutdownMcp()` to bound transport memory growth.
- Added `closeRedisClient()` with `quit()` + `disconnect()` fallback for clean Redis teardown on shutdown.
- Capped raw `PUT /files/*` body size and bulk `writeFiles` file count + total bytes to prevent OOM from unbounded upload buffering.
- Mapped `ECOHERENCE` and `ERUNTIME_BUSY` error codes to HTTP 503.

## [0.2.18] - 2026-05-09

### Fixed

- Connection leak: `SessionManager.destroy()` and the idle-session reaper now call `dialect.disconnect()` on the evicted session's `SqlFs`, releasing the Postgres connection pool back to the server. Previously, sandbox deletion left pools open indefinitely until process exit.
- Added `SqlFs.disconnect()` as a thin public wrapper over `dialect.disconnect()` to support clean teardown without exposing the dialect directly.

## [0.2.17] - 2026-05-07

### Added

- Synchronous blob pre-fetch on cold-start snapshot hit: when `REDIS_PATH_SNAPSHOT_ENABLED=true` and `REDIS_BLOB_CACHE_ENABLED=true`, `SqlFs.ready()` now issues a single Redis `mget` for all file-inode sha256s from the path snapshot before returning the session to the caller. This eliminates the race window where `readFile` calls during background prewarm each paid an individual Postgres round-trip. Background prewarm (`getBlobsForSandbox`) continues to fire as the Postgres fallback for blobs not yet in Redis.

## [0.2.16] - 2026-05-06

### Added

- Defense-in-depth security layer for just-bash execution: opt-in via `JUST_BASH_DEFENSE_IN_DEPTH=true`. When enabled, just-bash monkey-patches host globals (`setTimeout`, `eval`, `Function`, dynamic `import`) during `bash.exec` to prevent sandbox escape. All Postgres I/O chokepoints (`#withTx`, `#withReadTx`, `#withBareTx`, `getBlobNoTx`) are wrapped in `DefenseInDepthBox.runTrustedAsync` to keep DB access functional.
- `JUST_BASH_DEFENSE_AUDIT_MODE` env var (default `true`): controls whether violations throw (`false`) or are logged only (`true`). Recommended rollout: enable with audit mode on, watch for `defense_in_depth_violation` logs, then flip to enforce mode once clean.
- Structured violation logging: violations emit a JSON line `{ event: "defense_in_depth_violation", sandboxId, ... }` via `onViolation` callback for easy grep/alerting.

## [0.2.15] - 2026-05-02

### Fixed

- `SqlFs#openScriptTx`: attach `.catch(() => {})` to `#scriptTxPromise` immediately after creation to prevent an unhandled rejection crash (Node.js 15+) when the database connection is closed while the deferred transaction is open. Also switch `await txReady` to `await Promise.race([txReady, #scriptTxPromise])` so a connection failure before `resolveTxReady` fires propagates immediately rather than hanging forever.
- `SqlFs#withBareTx`: route through the already-open `#scriptTx` when `this.#scriptTx !== undefined`, preventing a deadlock that occurred in `appendFile` when `#withTx` (blob read) opened the script-tx and acquired `pg_advisory_xact_lock`, then the subsequent `#withBareTx` → `writeFileComposite` started a new transaction and immediately blocked on the same lock.

## [0.2.14] - 2026-05-02

### Performance

- `PostgresDialect`: fuse `setSandboxContextWithLock` into a single `SELECT` (saves 1 RTT on all non-composite write paths).
- `PostgresDialect`: add `writeFileComposite`, `mkdirComposite`, `rmComposite`, `mvComposite` — single-CTE methods that embed sandbox context setup + advisory lock + all operation queries, reducing each write transaction from 3–7 RTTs to 1.
- `SqlFs`: `writeFile`, `appendFile`, `mkdir` (non-recursive), `rm` (single), and `mv` now use composite CTEs when the dialect provides them via a new `#withBareTx` helper; fall back to the existing sequential path for MySQL/Azure SQL dialects.
- `SqlDialect` interface: four new optional composite method signatures (`writeFileComposite?`, `mkdirComposite?`, `rmComposite?`, `mvComposite?`) — backward-compatible, no changes required for existing dialect implementations.

### Tests

- Add `sql-fs.composite.test.ts`: 22 unit tests verifying composite paths call composite methods instead of sequential methods, skip `setSandboxContextWithLock`, and produce correct pathCache updates.

## [0.2.13] - 2026-05-01

### Added

- `scripts/benchmark_remote_bash.py`: end-to-end Remote Bash latency benchmark hitting the live HTTP API via the Python SDK. Runs in two phases — sandbox lifecycle (create / ingest / delete over N fresh sandboxes) and exec latency (find / grep / rg / write / delete / mkdir / mv cases on a warm sandbox). Reports wall-clock ms and server-side `duration_ms` (avg / p50 / p95 / max) as markdown tables. Supports both `sqlfs` and `daytona` providers via `--provider`, auto-detects writable home dir on Daytona, and sweeps leftover `bench-*` sandboxes on exit. Run with `pnpm bench:remote-bash`. See README for full instructions.

### Removed

- `src/fs/sql-fs/benchmark.ts` and the `bench:sql-fs-cache` npm script. Replaced by the more comprehensive `scripts/benchmark_remote_bash.py` which exercises the actual HTTP API path instead of the dialect directly.

## [0.2.12] - 2026-05-01

### Changed

- Reorganized colocated `*.test.ts` files into per-module `tests/` directories so source and tests are visually separated. Affects `src/api/`, `src/api/lib/`, `src/fs/sql-fs/`, `src/fs/sql-fs/dialects/`, and `src/redis/`. No source or runtime changes.

## [0.2.11] - 2026-04-30

### Added

- `SqlDialect.getBlobsForSandbox(sandboxId, maxBytes)` and `RedisBlobCache.mget(sha256s)` for batched content prewarm. The dialect method issues a metadata-only window-CTE first, bulk-fetches misses from Redis L2, then one batched `WHERE sha256 = ANY(…)` for remaining Postgres misses.

### Changed

- `SqlFs.ready()` and `SqlFs.reload()` now kick off a non-fatal background content-cache prewarm. Cache-miss reads in `readFile`/`readFileBuffer` coalesce onto the in-flight prewarm rather than racing it with per-file SELECTs. Cold-grep latency on a 125-file / 1 MB tree drops from ~9.4 s to ~3.8 s on remote Postgres deployments.

## [0.2.10] - 2026-04-30

### Changed

- Removed the per-blob read transaction wrapper from `readFile`/`readFileBuffer`. Cache-miss reads now issue a single pool-level SELECT instead of `BEGIN`/`SET LOCAL`/`COMMIT`/`SELECT`/`COMMIT`. ~70 % reduction in cold-grep latency on remote Postgres deployments. Internal change; no API surface impact.

## [0.2.9] - 2026-04-30

### Added

- `lefthook` pre-commit hooks: runs `ruff format --check` and `ruff check` against `clients/python/**` staged changes; runs `mypy src/` when `.py` files are staged. Hooks are installed automatically on `pnpm install` via the `prepare` script.
- GitHub Actions workflow `python-sdk-ci.yml`: path-filtered CI for the Python SDK (lint, typecheck, test matrix on Python 3.9/3.11/3.13).
- GitHub Actions workflow `python-sdk-release.yml`: automated PyPI publish via OIDC trusted publisher when `clients/python/**` changes land on `main`.
- `clients/python/CHANGELOG.md` for Python SDK version tracking.

### Changed

- `bulkIngest` now populates the in-memory content cache with the bytes it just received, eliminating a database round-trip on the very next read of an ingested file. No API surface change.
- Python SDK PyPI distribution name renamed from `sqlfs` to `sql-fs-sdk`.
- Fixed pre-existing mypy strict errors in `clients/python/src/sqlfs/_http.py` and `models.py`: typed `list`/`tuple` type arguments, cast `Literal` for `StreamEvent.type`.
- Fixed pre-existing ruff lint/format issues in `clients/python/examples/perf_benchmark.py` and `tests/test_client.py`.

## [0.2.8] - 2026-04-28

### Added

- `jti` claim on tokens minted by `POST /v1/auth/admin`, generated via `randomUUID()` and recorded in the `admin_token_issued` audit log so a leaked-token incident can be correlated back to the issuing log line.
- `admin_token_issued`, `admin_token_denied`, and `admin_token_misconfigured` audit log events on `POST /v1/auth/admin` (matching issue #23 names; bootstrap retains the existing `auth_bootstrap_*` events).
- `auth_rate_limited` audit log event emitted when a rate-limited request is rejected.
- `src/api/rate-limit.ts` — in-memory rate-limit primitive with injectable store and clock. Mounted on `/v1/auth/admin` (keyed by IP and Bearer sub) and `/v1/auth/bootstrap` (keyed by IP).
- Env vars: `ADMIN_RATE_LIMIT_WINDOW_MS` (default `60000`), `ADMIN_RATE_LIMIT_MAX` (default `5`), `BOOTSTRAP_RATE_LIMIT_WINDOW_MS` (default `60000`), `BOOTSTRAP_RATE_LIMIT_MAX` (default `5`), `TRUST_PROXY_HEADERS` (default `false`).
- `InMemoryRateLimitStore` now caps live keys (default `10000`) with FIFO eviction so attacker-controlled key cardinality (e.g. spoofed `X-Forwarded-For` against unauthenticated bootstrap) cannot grow the store unbounded within a window.
- HTTP `429 RATE_LIMITED` response (with `Retry-After` header) on both auth endpoints when the limit is tripped.

### Changed

- `constantTimeEqual()` in `src/api/routes/auth.ts` now compares SHA-256 digests of the inputs, removing the early-return length oracle. Used by both `POST /v1/auth/bootstrap` and `POST /v1/auth/admin`.
- `POST /v1/auth/admin` is now structured as pre-middleware → `validateBody` → handler so the `X-Admin-Secret` check runs before body parsing. Wrong/missing secrets now return 403 even for malformed bodies (previously returned 400 from Zod). The handler also hard-fails with 500 `AUTH_NOT_CONFIGURED` when `AUTH_SECRET` is unset.
- Rate-limit `clientIp()` no longer reads `X-Forwarded-For` / `X-Real-IP` by default — those headers are spoofable. Operators behind a trusted ingress that strips inbound forwarding headers must opt in via `TRUST_PROXY_HEADERS=true`. Otherwise the connecting socket's `remoteAddress` is used. See `plugins/sqlfs/skills/api/SETUP.md` for the full trust-proxy note.

## [0.2.7] - 2026-04-28

### Changed

- **perf(ingest):** Batch directory existence checks per depth level in `bulkIngest`, reducing ~40 sequential DB round-trips to ~4 (one per depth level).
- **perf(ingest):** Replace post-write `reload()` (full recursive CTE re-read) with in-memory `pathCache` merge from `INSERT RETURNING` data — zero DB calls after commit.
- `SqlDialect.bulkIngest` return type changed from `Promise<void>` to `Promise<Map<string, PathCacheEntry>>` to support cache merge.

### Fixed

- **bulkIngest EISDIR:** Ingesting a file at a path that is currently a directory now throws `EISDIR` instead of silently overwriting the directory and orphaning its children.
- **bulkIngest ENOTDIR:** Ancestor directory check now JOINs `inodes` to verify `kind=DIRECTORY`, throwing `ENOTDIR` if an ancestor is a file or symlink.
- **bulkIngest nlink:** Overwriting two hardlinks to the same inode now decrements `nlink` by the correct count (was only decrementing once due to `IN`-clause deduplication).
- **bulkIngest contentCache:** Overwritten file inodes are evicted from `contentCache` during the cache merge, preventing stale content reads.

## [0.2.6] - 2026-04-28

### Added

- `GET /v1/sandboxes` — list all sandboxes owned by the authenticated user, queried directly from Postgres for accuracy across replicas.
- `sandbox_list` MCP tool providing the same listing capability to MCP clients.
- `name` field on sandboxes: optional human-readable name (`TEXT`, max 255 chars) set at creation time via `POST /v1/sandboxes` body or `sandbox_create` MCP tool. Returned in create, get, and list responses.
- Postgres migration `0003_add_sandbox_name.sql` adding the `name` column.
- `listSandboxes` method on `SqlDialect` interface and Postgres dialect implementation.
- OpenAPI spec updated with the new list endpoint and `name` field on all sandbox schemas.

## [0.2.5] - 2026-04-26

### Fixed

- Move `vi.restoreAllMocks()` into `afterEach` in exec-batch tests so spy cleanup is guaranteed even when a test throws.
- Align `bash_exec_batch` MCP tool description to reference the `timeout` field (not `timeoutMs`) so clients send the correct key.
- Sanitize unexpected `bash_exec_batch` MCP errors: log server-side and return `"internal error"` instead of exposing `err.message`.
- Propagate client disconnect into batch cancellation via `c.req.raw.signal`, releasing the session lock early instead of running to timeout.

## [0.2.4] - 2026-04-26

### Added

- Batch execution endpoint `POST /v1/sandboxes/:id/exec-sync-batch` that collapses N sequential exec round-trips into a single HTTP request, eliminating transport overhead for exploration workflows.
- `bash_exec_batch` MCP tool providing the same capability to MCP clients.
- OpenAPI spec for the new batch endpoint.

## [0.2.3] - 2026-04-26

### Added

- `POST /v1/auth/bootstrap` — unauthenticated token bootstrap endpoint that exchanges `AUTH_SECRET` (passed in `X-Auth-Secret`) for a signed JWT, breaking the chicken-and-egg dependency on `POST /v1/admin/tokens` for external clients (issue #27). Uses constant-time secret comparison, hard-fails when `AUTH_SECRET` is unset, validates tenants against the configured set, and emits `auth_bootstrap_issued` / `auth_bootstrap_denied` audit events.

## [0.2.2] - 2026-04-26

### Fixed

- Updated OpenAPI spec to document new `debug` request parameter and `exitSignal`, `timedOut`, `durationMs` response fields on exec-sync 200/408 responses.

## [0.2.1] - 2026-04-26

### Fixed

- `timeoutMs` query parameter now rejects values exceeding 300000 with a 400 error instead of silently capping.

### Added

- SSE streaming tests for `text/plain` content type and `timeoutMs` query parameter timeout enforcement.

## [0.2.0] - 2026-04-26

### Added

- Accept `text/x-shellscript` and `text/plain` content types on `exec-sync` and `exec` (SSE) endpoints — the raw request body is used as the script verbatim, removing the need for JSON encoding. Optional `?timeoutMs=` query parameter available in plaintext mode. Returns 415 for unsupported content types.
- Enriched exec-sync response with `exitSignal`, `timedOut`, and `durationMs` fields for better error disambiguation.
- Enriched 408 timeout response with `timedOut` and `durationMs` fields.
- `debug` request flag on exec-sync, exec (SSE), and MCP `bash_exec` that prepends `set -x` for command-level tracing without modifying the submitted script.

## [0.1.1] - 2026-04-26

### Changed

- Migrated Claude Code skills from `commands/sql-fs-api.md` + `skills/sql-fs-api/` into the plugin layout under `.claude-plugin/` and `plugins/sqlfs/`.

## [0.1.0] - 2026-04-26

### Added

- Initial release of `sql-fs-api`: persistent filesystem backend + HTTP/MCP API for `just-bash` sandboxes.
- SQL-backed `IFileSystem` implementation (`SqlFs`) with Postgres, MySQL, and Azure SQL dialects.
- Adjacency-list directory model with content-addressable blob storage and global dedup.
- Path cache (eager) and content cache (lazy LRU, 50 MB/session) for low-latency reads.
- HTTP API (Hono): sandboxes CRUD, file operations, exec (sync + SSE), ingest/export, admin GC.
- MCP server with 10 tools over streamable HTTP transport.
- Bearer-token auth, RLS-based sandbox isolation, default-deny symlinks, error sanitization.
- Multi-tenant routing and session rehydration.
- Docker image and Azure Container Apps deployment config.

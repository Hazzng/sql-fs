# Handoff: audit the v2 package-install plan before implementation

You are auditing an implementation plan, not implementing it. Do not modify any
file under `src/`. Your output is a written review. Be adversarial: the plan was
written by one session from source reading plus one live run, and the author
wants every claim checked and every design choice challenged before code is
written.

## Where everything is

Work in the git worktree `/Users/nguyendangquang/.superconductor/worktrees/virtualFS/sqlfs-pip-experiment`,
branch `experiment/pip-install-databricks-cli`, HEAD `37f6070`. The main
checkout at `/Users/nguyendangquang/master/Web-Dev/virtualFS` is a different
branch and does not contain the pip code. `just-bash` is at 3.0.1 under
`node_modules/just-bash`; the Python worker source is unminified at
`node_modules/just-bash/dist/bundle/chunks/worker.js`. A newer just-bash 3.4.2
source tree exists at `/Users/nguyendangquang/master/Web-Dev/just-bash/packages/just-bash`
(the user's fork) if you need readable TypeScript for the bridge.

Documents, all under `thoughts/shared/plans/` in the worktree:

- `2026-09-18_12-44-19_cross-sandbox-package-reuse-v2.md` — **the plan under review.**
- `2026-09-18_11-49-20_cross-sandbox-package-reuse.md` — v1, superseded; its
  research sections are still the best map of the code.
- `/Users/nguyendangquang/master/Web-Dev/virtualFS/thoughts/shared/plans/2026-09-18_just-bash-worker-bridge-streaming-pr.md`
  — a separate upstream PR design for just-bash; out of scope except where v2
  depends on facts stated there.

Code the plan touches: `src/api/commands/pip-command.ts` (1028 lines, read all
of it), `src/api/session-manager.ts` (Bash construction ~578-625, semaphore
~350-372 and ~1555-1630, regex at 211), `src/sql-fs/sql-fs.ts` (writeFile
848-914, bulkIngest 810-838), `src/sql-fs/dialects/postgres.ts` (commitBlob
614-634, writeFileComposite 160-216, bulkIngest 846-1124, gcOrphanBlobs
754-767), `src/sql-fs/types.ts`, `src/sql-fs/migrations/postgres/`,
`src/api/blob-gc.ts`, `src/api/tests/unit/pip-command.test.ts`, `SECURITY.md`.

## Claims the plan rests on — verify each with file:line evidence

1. The worker's filesystem bridge has an 8 MB single-payload ceiling
   (`DATA_BUFFER: 8388608`), and HOSTFS `open` for read loads the whole file
   through it, so wheels and extracted files over 8 MB fail. Also verify the
   claim that a `Result too large` on the host surfaces in Python as `ENOENT`
   via HOSTFS `open`'s catch block, which the live run saw as
   `[Errno 44] No such file or directory` for a 10.2 MB wheel.
2. Each file the extractor writes costs two `writeFile` calls: `mknod` writes
   an empty file, `close` writes the full content. Each `writeFile` on SqlFs is
   `commitBlob` plus `writeFileComposite`, so four Postgres round trips per
   extracted file.
3. Every write inserts its content into the 50 MB content LRU and, for blobs
   at or below 8 MB, issues a Redis SET. `bulkIngest` does the same.
4. No code path checks blob existence by hash before shipping payload bytes;
   all inserts rely on `ON CONFLICT` after transmission.
5. `pip` and `databricks` bypass `MAX_CONCURRENT_PYTHON` because the gate is
   `PYTHON_INVOCATION_REGEX` on the script text, while both call
   `ctx.exec("python", ...)`. just-bash itself serializes Python per filesystem
   (a `WeakMap` keyed by fs) and has no process-wide cap or `resourceLimits`.
6. `secureFetch` defaults to 10 MB, has no per-call size override, and is
   shared with `curl`; `createSecureFetch` is not exported from the `just-bash`
   package root, so the plan's "pip-scoped fetch" must build its own fetch
   wrapper or find another route. Check whether that is true and whether a
   hand-written allow-listed fetch loses any protection `secureFetch` provides
   (redirect checks, private-range denial, timeout clamping).
7. The cumulative `/site-packages` budget (48 MB, 10 000 files) is checked
   before every install and there is no uninstall, so a sandbox that crosses it
   can never install again.
8. SqlFs writes inside an exec join the script transaction, which commits at
   the end of the exec regardless of the command's exit code, so a `pip` that
   fails after extracting some wheels leaves them committed. Verify by reading
   `beginScriptScope`/`endScriptScope`/`abortScriptScope` in `sql-fs.ts` and
   who calls abort in `session-manager.ts`.
9. The `python3` override breaks `python3 script.py` and `python3 -` because
   `runpyProgram` passes the untranslated path into the worker and the worker
   has no stdin. Verify against `packagePythonArgs` and the just-bash
   `WorkerInput` type. Also verify the plan's newer claims: only `python3` is
   overridden (not `python`), `--version` anywhere in argv bypasses the
   override, and `indexOf("-c")`/`indexOf("-m")` misparse.
10. The `requests` compat shim always shadows the real wheel, so downloading
    `requests` and its four dependencies is wasted.
11. Node's `zlib.inflateRawSync` supports `maxOutputLength` on every Node the
    repo supports (`engines.node`), and throws `ERR_BUFFER_TOO_LARGE`.

## Design decisions to challenge

Do not accept these because the plan asserts them. Argue for or against each
and say what you would do instead if you disagree.

- **Host-side unzip replaces the WASM extractor.** Is a hand-written ZIP
  central-directory parser (stored and deflate only, no encryption, ZIP64 size
  fields only) an acceptable amount of untrusted-input parsing to add to the
  API process? What does the extractor currently check that the plan's reader
  might miss? Is CRC verification plus the wheel's SHA-256 enough?
- **Manifest keyed by wheel SHA-256** with a normalised
  `package_manifest_files` child table, rather than v1's `(name, version)` +
  JSONB. Check the proposed GC clause against `gcOrphanBlobs` and the
  REPEATABLE READ retry logic in `blob-gc.ts`: does adding
  `NOT EXISTS (... package_manifest_files ...)` plus a manifest TTL delete in
  the same transaction introduce any new race with concurrent installs
  recording a manifest? Is the `blob_sha256` index enough to keep GC fast on a
  tenant with many manifests?
- **Staging directory plus `mv`** for all-or-nothing installs. Verify that
  SqlFs `mv` of a directory is a dirent update and not a copy, that it works
  inside the script transaction, and that a crash between staging and rename
  cannot leave a half-moved tree. Compare against relying on
  `abortScriptScope` instead.
- **`bulkIngest` option `presentBlobs`/`cacheContent: false`** and a new
  optional dialect method `filterMissingBlobs`. Is making new `SqlDialect`
  methods optional (like `commitBlob?`) the right call given ~50 test files
  build typed mock dialects? Does skipping the content cache for installed
  files hurt `import` performance, given Python reads every module through
  `readFileBuffer` on each `databricks` invocation?
- **Singleflight per wheel via Redis `SET NX`** with in-process fallback.
  Check it against the existing exec lock: an install runs under the
  per-sandbox exec lock already; can waiting on a per-wheel lease inside that
  deadlock or starve (sandbox A holds wheel lease X and waits on Y, sandbox B
  holds Y and waits on X)? The plan installs wheels sequentially per sandbox,
  so consider whether lease acquisition order or a single lease per install
  fixes it.
- **Install concurrency cap `MAX_CONCURRENT_PIP_INSTALLS` (default 2)** as a
  process-wide semaphore separate from `MAX_CONCURRENT_PYTHON`, and adding
  only `databricks` (not `pip`) to the Python regex. Is that the right
  split? What is peak host memory per replica under the plan's numbers, and
  does the semaphore actually bound it?
- **Revised limits** (32 MB wheel, 512 MB extracted per install, 50 000 files,
  1 GB soft quota from the installed record). Cross-check against
  `pathCacheMaxBytes` (50 MB) and the reaper: at roughly 150 bytes per path
  entry, at what package footprint does a sandbox become permanently
  `overBudget` and get evicted every minute? Is the plan's quota safely below
  that?
- **Credentials via per-request `env`, not `.databrickscfg`.** The plan
  dropped a `DATABRICKS_CONFIG_FILE` default on the grounds that a token in a
  sandbox file becomes a shared blob and a Redis entry and is not redacted.
  Confirm those consequences from the write path and say whether anything
  should still be done for users who write the file anyway.
- **Phase 6 lets POST/PUT/PATCH/DELETE through the `requests` shim.** The
  current restriction is client-side only and already bypassable via
  `jb_http`. Is removing it a security regression in any deployment mode, or
  purely a UX change? Check `SECURITY.md`'s current claims.

## Things the plan may have missed — look for them

- Anything in `pip-command.ts` that is wrong today and not listed under
  "New bugs found" or "Additional issues from a second source pass" in v2.
  The plan claims two independent passes found everything worth fixing;
  try to prove that false.
- Interactions with the Redis path snapshot (`REDIS_PATH_SNAPSHOT_ENABLED`)
  and session rehydration: a graft adds hundreds of path-cache entries; is the
  snapshot invalidated or updated correctly by `bulkIngest`-style writes today?
- Multi-replica behaviour: two replicas installing the same wheel into
  different sandboxes with no Redis configured.
- Export (`routes/ingest.ts` tar.gz export) of a sandbox with `/site-packages`
  present: does the plan change anything about what gets exported, and should
  installed packages be exported at all?
- The `just-bash` upgrade path: the plan targets 3.0.1 behaviour. Does anything
  in v2 break or become unnecessary on 3.4.2, which adds `maxFileSize` (from
  `maxStringLength`), `stdin` in `WorkerInput`, and exit code 124?

## Output format

Write your review to
`thoughts/shared/plans/2026-09-18_v2-audit-review.md` in the worktree with
these sections, in this order:

1. **Verdict** in three sentences: implement as is, implement with changes, or
   redesign, and why.
2. **Claim verification table**: one row per numbered claim above, columns
   `claim`, `verdict` (confirmed / refuted / partially), `evidence` (file:line
   and a quoted snippet), `consequence for the plan`.
3. **Design challenges**: one subsection per bullet under "Design decisions to
   challenge", each ending in a concrete recommendation.
4. **Missed issues**: anything new you found, with evidence and a proposed
   plan change.
5. **Required plan edits**: a numbered list of specific edits to the v2
   document, quoting the text to change and the replacement, so the author
   can apply them without re-deriving your reasoning.
6. **Open questions for the user**: only decisions that genuinely need a
   human, with the options and your recommendation for each.

Cite `file:line` for every factual statement. Where you could not verify
something, say so rather than guessing. Do not restate the plan; assume the
reader has it open.

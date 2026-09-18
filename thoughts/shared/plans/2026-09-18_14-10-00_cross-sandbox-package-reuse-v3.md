---
date: 2026-09-18T14:10:00+09:30
researcher: Harry.Nguyen@insightfactory.ai
git_commit: 37f6070da5c32f3e8105db9da24af009ea81081b
branch: experiment/pip-install-databricks-cli
repository: virtualFS
task: "Sandbox package install v3: v2 revised after audit"
tags: [implementation-plan, pip, packages, blobs, cas, dedup, postgres, gc, wasm, memory, concurrency]
status: draft
supersedes: 2026-09-18_12-44-19_cross-sandbox-package-reuse-v2.md
audit: 2026-09-18_v2-audit-review.md
last_updated: 2026-09-18
last_updated_by: Harry.Nguyen@insightfactory.ai
---

# Sandbox package install v3

v2 established the problem and the direction: extract on the host, reuse
wheels across sandboxes through a content-addressed manifest, bound concurrent
installs, and remove the states a sandbox cannot recover from. The audit
(`2026-09-18_v2-audit-review.md`) confirmed every load-bearing claim and
found that four parts of the design were not safe as written: the
staging-and-rename publish, the caller-asserted blob presence, the manifest GC
root, and the user-writable installed record. It also found that the plan's
fetch construction cannot be built through the supported just-bash API. This
document is v2 with those parts redesigned. Research, findings and the live-run
validation are not repeated; read v2 for them.

## What changed from v2, and why

| v2 | v3 | Reason (audit section) |
|---|---|---|
| Extract into a staging dir, then `mv` into `/site-packages` | Blobs and manifest first, then one DB-only graft publish; no staging | `mv` onto an existing non-empty dir throws `ENOTEMPTY`; publication needs to be short and DB-only because a resolved exit-1 result still commits the script tx |
| Caller passes `presentBlobs` to `bulkIngest` | Dialect owns a touch-then-insert protocol that returns the authoritative present set | A blob reported present can be collected before the inode references it; a missing blob then reads as an empty file |
| `package_manifest_files.blob_sha256` with no FK; TTL blobs collected "next pass" | FK `REFERENCES blobs(sha256) ON DELETE RESTRICT`, `manifest_format` column, manifest recorded per wheel with blob touch in the same window | Manifest rows created no conflict on blob rows, so REPEATABLE READ GC could delete a blob a concurrent install had just referenced |
| Installed record as `/site-packages/.sqlfs-installed.json` | `sandbox_packages` table under RLS; paths and hashes derived from manifests | The file is writable by the principal it limits |
| Hand-written ~150-line ZIP parser, sync inflate | Maintained ZIP reader (`yauzl`), async inflate, RECORD and WHEEL verification | Untrusted binary parsing in the API process; sync inflate stalls the event loop that renews Redis leases |
| `createSecureFetch` for a pip-scoped fetch | Small PyPI-only fetch wrapper with parity tests; upstream export as a follow-up | `createSecureFetch` is not reachable through the package exports map |
| Per-wheel `SET NX PX 120000` lease | Reuse `withDistributedLock` (token, renewal, compare-and-delete) per wheel | Fixed lease can expire mid-install |
| Semaphore around one wheel's download and extraction | Admission slot held for the whole install; Python slot taken at the actual `ctx.exec("python")` | Resolution and inter-wheel waits were outside the cap |
| Unknown marker variable treated as unsatisfied | Full PEP 508 variable set; unknown is a hard resolver error | Silently dropping a dependency edge is worse than refusing |
| Phase 6 removes the GET/HEAD guard | Explicit `networkWrite` capability; guard stays by default | Removing it makes SECURITY.md's read-only claim false without the caller opting in |
| `pip uninstall` removes the record's file list | Removes paths owned solely by that wheel whose current hash still matches; preserves and reports modified files | Shared and user-modified paths |

Decisions taken on the audit's open questions, all reversible:

1. ZIP implementation: accept a maintained dependency (`yauzl`). A spike
   confirms it validates local-versus-central header agreement, ZIP64, and
   filename encoding, and that its inflate streams are asynchronous.
2. No-Redis multi-replica: accept duplicate first-install work. CLAUDE.md
   already states Redis is required for multi-replica deployments.
3. User-modified package files: preserve and report; add `--force` later.
4. Databricks write methods: explicit per-sandbox capability, default off.
5. Package export: out of scope for this plan; noted under docs.
6. just-bash baseline: do not block on the 3.4.2 upgrade. The Phase 0 path
   translation is idempotent on 3.4.2 because `_should_redirect` skips paths
   already under `/host`, and the stdin fix is harmless there. Evaluate the
   upgrade separately.

## Design principles

1. Bytes the tenant already stores are never transmitted again, and the
   dialect, not the caller, decides what is already stored.
2. The host never holds a whole extracted package in memory and never blocks
   the event loop on decompression.
3. `pip install` spawns no CPython worker. `databricks` and `python3` take a
   Python slot at the point the worker is actually spawned.
4. Durable, shared work happens before any sandbox mutation. Blobs and
   manifests are committed per wheel; the sandbox tree changes in one short,
   DB-only publish step at the end.
5. Ownership, quota and version state live in Postgres under RLS, never in a
   file the sandbox can edit.
6. Every limit is configured in one place, agrees with the layer below it, and
   produces a message naming the number and the knob.
7. A sandbox can always recover: uninstall exists, and budgets are per install
   plus a per-sandbox quota, never a cumulative hard wall.

## Pipeline

```
pip install A B
│
├─ Phase R  resolve            PyPI JSON; per-version endpoint when pinned; cumulative
│                              metadata caps; full marker set; extras; Requires-Python;
│                              synthetic `requests` provider
│
├─ Phase W  per wheel, sequential, under the wheel lease
│     ├─ lease  withDistributedLock(vfs:{tenant}:pip:wheel:{sha256})
│     ├─ manifest lookup (sha256, manifest_format)  → hit: release, next wheel
│     ├─ download via pip fetch (PyPI-only, own size cap), verify sha256
│     ├─ open with yauzl; validate every central-directory entry; parse WHEEL;
│     │  parse RECORD
│     ├─ for each batch of entries (≤ 8 MB inflated or ≤ 500 entries):
│     │     inflate async with maxOutputLength = declared size
│     │     verify CRC-32 and RECORD sha256
│     │     dialect.ingestBlobs(batch)   touch-RETURNING present, INSERT missing
│     ├─ record manifest (own short tx): package_manifests + package_manifest_files
│     └─ release lease
│
└─ Phase P  publish, DB-only, inside the script transaction
      ├─ read sandbox_packages; compute superseded versions and ownership conflicts
      ├─ quota check from manifest totals
      ├─ remove superseded owned paths whose current hash matches the manifest
      ├─ bulkGraft every wheel's manifest rows   (touch-RETURNING; any missing → stale
      │                                           manifest deleted, wheel redone in W)
      ├─ upsert sandbox_packages rows
      └─ write the requests compat overlay if the synthetic provider was used
```

The first install of a wheel anywhere in the tenant does Phase W in full. Every
later install of that wheel, in any sandbox, skips download, extraction and
blob transmission and does only the manifest lookup and Phase P. The publish
step is the same code path for both, which is why grafting is not a special
case.

### Why this shape

- **Phase W is idempotent and failure-safe.** Blob inserts are content
  addressed and self-committing (the existing F6 pattern). A manifest is
  recorded only after every entry of that wheel has been inflated, CRC-checked
  and RECORD-verified. If wheel 3 of 5 fails, wheels 1 and 2 are already
  reusable by everyone and nothing in the sandbox tree has changed.
- **Phase P is short and has one failure mode worth designing for.** It
  issues a bounded number of statements (about five per graft batch) with no
  network and no decompression. A DB error rolls the script transaction back.
  A process crash or a plain exec timeout mid-publish can still commit a
  partial tree, because just-bash returns a resolved result on abort and
  `endScope` commits it (`session-manager.ts:1645-1666`, noted as audit L7).
  That window is seconds, not minutes, and a re-run of the same `pip install`
  repairs it: the ledger row is written last, so a partial publish leaves no
  ledger entry, and the graft is idempotent over identical hashes. Phase P
  also checks `ctx.signal.aborted` before its first statement and refuses to
  start if the exec is already cancelled.
- **The lease is held only during Phase W for one wheel**, released before the
  next wheel starts, so two sandboxes installing overlapping closures in
  different orders cannot deadlock. The per-sandbox exec lock is held
  throughout as it is for any exec.

## Phase 0: unblockers that land independently

Unchanged from v2 except where marked. Each item is small and has no
dependency on the rest.

- **Fix the `python3` override.** Translate script paths to `/host` + absolute
  path (relative paths joined to cwd first); handle `-` on the host by reading
  `ctx.stdin` and passing `-c` code; parse interpreter options up to the first
  positional instead of `indexOf`; treat `--version`/`-V`/`--help` as
  interpreter flags only before the first positional; register the same
  override for `python`. *Changed:* tests assert against the built-in `python`
  output on 3.0.1, and the translation is idempotent on 3.4.2 because the
  worker's `_should_redirect` skips `/host` paths (`worker.ts:702-708` in the
  3.4.2 tree). No version gating needed.
- **Surface the real error.** Translate `ResponseTooLargeError` (match on
  `name`) to a `PipError` naming the package and the limit; include
  `error.message` for any other non-`PipError`.
- **Report "no pure wheel" before the candidate counter trips.**
- **Synthetic `requests` provider.** *Changed:* the compat shim declares a
  version (`2.31.0`) and an API surface (`request`, `get`, `head`, `Session`,
  `Response`, `HTTPBasicAuth`, `exceptions`). A `requests` requirement is
  satisfied by the provider when its specifier admits that version; otherwise
  the install fails naming the constraint. Its `Requires-Dist` closure is not
  followed. Document that packages needing more of `requests` than the shim
  implements fail at import, exactly as they do today.
- **Pip-scoped fetch.** *Changed:* `createSecureFetch` is not exported through
  the package's exports map, so build `createPypiFetch({ maxResponseSize,
  timeoutMs })` in `src/api/commands/pypi-fetch.ts`: GET only, hostnames
  fixed to `pypi.org` and `files.pythonhosted.org`, redirects not followed
  (the existing `fetchPypi` loop checks each hop), `content-length` pre-check
  then a streaming reader that aborts past the cap, `AbortSignal` timeout
  composed with `ctx.signal`. Because hostnames are fixed, no DNS or
  private-range check is needed. Parity tests: cap by header, cap by stream,
  timeout, non-PyPI host refused, redirect not followed. Open an upstream
  just-bash PR to export `createSecureFetch` so this wrapper can be deleted.
  `curl` keeps its 10 MB default.
- **Admission control.** *Changed:* `MAX_CONCURRENT_PIP_INSTALLS` (default 2)
  is acquired for the whole `pip install` orchestration, resolution included.
  `pythonPackageCommands` becomes `createPythonPackageCommands({ fetch,
  acquireInstall, acquirePython })`. `acquirePython` wraps every
  `ctx.exec("python")` in the `databricks` and `python3` paths; an
  `AsyncLocalStorage` flag set by `execWithRuntimeThrottle` when the outer
  regex already took a slot makes the inner acquire a no-op, so one exec never
  holds two slots. `PYTHON_INVOCATION_REGEX` is left alone.
- **Markers.** *Changed:* implement every PEP 508 variable
  (`platform_release`, `platform_version`, `implementation_version` added),
  string containment for `in`/`not in` instead of comma splitting, and
  value-on-the-left comparisons. An unknown variable is a hard resolver error
  with the marker text in the message.
- **Extras** as in v2.
- **Resolver hygiene.** *New:* cumulative metadata caps per install (bytes
  32 MB, requests 200, cache entries 200); recompute reachable depth when an
  edge is added so a diamond cannot bypass `maxDependencyDepth`; exclude dev
  releases with the prerelease rule; check `requires_python` against 3.13;
  document the supported PEP 440 subset and add conformance fixtures for
  epoch, dev, post, local, wildcard and `~=`.
- **Per-version metadata first**; `maxMetadataBytes` 16 MB as a backstop.
- **Redaction**: minimum secret length of eight.
- **Credentials**: per-request `env` is the documented route (v2 text stands).

### Success criteria

As v2, plus: an install of a package whose dependency has an unknown marker
variable fails naming the variable; a fixture with a diamond dependency whose
deeper path exceeds the depth limit is refused; `pip install databricks-cli`
makes no request for `requests` or its four dependencies; a script containing
`python3 x.py; databricks y` holds exactly one Python slot at a time.

### Phase 0 status

Implemented on `experiment/pip-install-databricks-cli` (worktree
`sqlfs-pip-experiment`). The WASM extractor remains the install path, as
planned; Phases 1-3 replace it.

- [x] **`python3` override fixed.** `parsePythonInvocation` reads interpreter
      options up to the first positional (value-taking `-W` / `-X` /
      `--check-hash-based-pycs`, short clusters such as `-Bu` and `-uc CODE`);
      `--version` / `-V` / `--help` are interpreter flags only before the
      first positional; script paths are translated with `toWorkerPath`
      (absolute → `/host` + path, relative joined to cwd, idempotent under
      `/host`); `-` reads `ctx.stdin` on the host and is passed as `-c`;
      `python` is registered alongside `python3`.
- [x] **Real error surfaced.** `fetchPypi` matches `error.name ===
      "ResponseTooLargeError"` and raises a `PipError` naming the package and
      the byte limit; any other non-`PipError` is reported as
      `pip: package installation failed: <message>`.
- [x] **"No pure wheel" reported before the candidate counter trips.**
- [x] **Synthetic `requests` provider** at `2.31.0` (`request`, `get`, `head`,
      `Session`, `Response`, `HTTPBasicAuth`, `exceptions`). Satisfied only
      when the specifier admits that version, otherwise the install fails
      naming the constraint; extras on it are refused; the closure is not
      followed; the import-time limit is documented at
      `SYNTHETIC_REQUESTS_VERSION`.
- [x] **Pip-scoped fetch** in `src/api/commands/pypi-fetch.ts`
      (`createPypiFetch({ maxResponseSize, timeoutMs })`): GET only, two fixed
      hostnames, https with no credentials, `redirect: "manual"`,
      `content-length` pre-check plus a streaming counter, `AbortSignal.timeout`
      composed with the caller's signal. `curl` keeps its 10 MB default.
- [x] **Admission control.** `MAX_CONCURRENT_PIP_INSTALLS` (default 2) held for
      the whole orchestration; `createPythonPackageCommands({ fetch,
      acquireInstall, acquirePython })`; `acquirePython` wraps the actual
      CPython spawn in the `python3` / `python` / `databricks` paths; the
      `pythonSlotContext` AsyncLocalStorage flag, set by
      `execWithRuntimeThrottle` only inside the region where it holds the
      slot, makes the inner acquire a no-op. `PYTHON_INVOCATION_REGEX`
      untouched.
- [x] **Markers.** Full PEP 508 variable set including `platform_release`,
      `platform_version` and `implementation_version`; string containment for
      `in` / `not in`; operands resolved on either side; an unknown variable is
      a hard resolver error naming the variable and the marker text.
- [x] **Extras.** Parsed on direct installs and on `Requires-Dist`; each
      dependency is evaluated under the base set and every requested extra.
- [x] **Resolver hygiene.** Cumulative per-install metadata caps
      (`PIP_MAX_METADATA_BYTES` 32 MB, `PIP_MAX_METADATA_REQUESTS` 200,
      `PIP_MAX_METADATA_CACHE_ENTRIES` 200); depth recomputed transitively when
      an edge lengthens one, so a diamond cannot bypass the limit; dev releases
      excluded with the prerelease rule; `requires_python` checked against
      3.13.2 on both the file entry and the version document; the supported
      PEP 440 subset documented at the top of `pep440.ts` with conformance
      fixtures for epoch, dev, post, local, wildcard and `~=`.
- [x] **Per-version metadata endpoint first** for a pinned `==` requirement;
      `PIP_MAX_METADATA_RESPONSE_BYTES` 16 MB backstop.
- [x] **Redaction** requires a secret of at least eight characters.
- [x] **Credentials**: per-request `env` remains the documented route; no code
      change was needed.

### Discoveries and Notable Information

- **Overriding both `python` and `python3` makes `ctx.exec` recursive.**
  just-bash registers `python` and `python3` as two names for the same
  built-in, and a custom command takes precedence over a built-in of the same
  name for `ctx.exec` as well as for the script. With both names overridden
  there is no built-in left to delegate to, and the first version of this
  change recursed until the 4 GB heap limit on any `pip install` (the
  extractor calls `ctx.exec("python")`). There is no `builtin`/`command`
  escape hatch in the interpreter and the python command is not exported.
  The fix: `invokeBuiltinPython` and `runWasmPython` now run through a sibling
  `Bash` — `new Bash({ fs: ctx.fs, python: true, fetch: ctx.fetch })`, cached
  in a `WeakMap` keyed by filesystem — with `replaceEnv: true` so nothing
  leaks between invocations. just-bash queues CPython workers per filesystem,
  so the sibling shares the sandbox's queue. It does NOT inherit
  `executionLimits` or the outer `defenseInDepth` config; the outer box's
  global patches are still installed for the duration of the outer exec, and
  the sibling's commands simply do not assert `requireDefenseContext`. Worth
  revisiting if defense-in-depth is switched from audit mode to enforcing.
- **Deferred:** no upstream just-bash PR was opened to export
  `createSecureFetch`. `pypi-fetch.ts` carries a note to delete itself when
  that export lands.
- **PEP 440 dev-release ordering was wrong in the inherited comparator.**
  `1.0.dev1` sorted above `1.0a1` because "no pre-release" always beat a
  pre-release. `compareVersions` now uses the reference sort key: a version
  with no pre-release but a development release sorts below every pre-release
  of the same release. `post` also had to become `number | undefined` to tell
  "absent" from `.post0`.
- **`pip install X[extra]` is no longer an error**, so the old test asserting
  "package extras are not supported" was replaced with one asserting the
  extra's dependency is installed, plus one asserting a direct install
  carrying a marker is still refused.
- **The synthetic provider changes `pip install databricks-cli` output**: it
  now reports `requests-2.31.0` among the installed packages even though
  nothing was downloaded for it, and writes the compat overlay whenever the
  provider was used (previously only when a real `requests` wheel resolved).
- **Test fixtures moved** to `src/api/tests/unit/pip-fixtures.ts` (ZIP writer,
  wheel builder, PyPI fetch double) so the five pip test files stay under the
  300-line rule.
- **Not done here, still open from the audit:** the resolver remains greedy
  and never retracts a constraint; the work-limit message now says "could not
  resolve", but a conflicting pair still churns until the limit.

## Phase 1: wheel reader and existence-aware blob ingest

### Wheel reader (`src/api/commands/wheel-reader.ts`)

Built on `yauzl` (`fromBuffer`, `lazyEntries`, `decodeStrings`,
`validateFileName`). The spike must confirm: local and central header
agreement is checked, ZIP64 is handled, entries stream through
`zlib.createInflateRaw` asynchronously, and the dependency footprint is
acceptable (yauzl 3.x has two small dependencies).

Checks before any byte is inflated, all from the central directory:

- reject encryption flags, compression methods other than 0 and 8, entries
  with a data descriptor whose sizes are unknown, filenames with NUL,
  backslash, absolute prefix, `.` or `..` segments, or length over 512;
- reject symlinks (external attributes), directory-versus-file collisions,
  duplicate paths, declared uncompressed size over `PIP_MAX_FILE_BYTES`, and
  cumulative declared size or count over the per-install limits;
- parse `*.dist-info/WHEEL`: `Wheel-Version` must be `1.x`,
  `Root-Is-Purelib: true`; parse `*.dist-info/RECORD` and require every
  non-RECORD entry to be listed with a `sha256=` hash. `.data/` subtrees are
  extracted verbatim under `/site-packages/<dist>.data/` as today; this is
  documented as the supported subset, not a spec-complete install.

Per entry: inflate with `maxOutputLength` equal to the declared size, count
bytes as they arrive and fail if the stream exceeds it, verify CRC-32 and the
RECORD sha256, and hand `{ path, sha256, mode, size, content }` to the batch.
Any zlib failure is mapped to one installer error, "corrupt or hostile
archive", without depending on a specific error code string.

### Blob ingest protocol (`SqlDialect.ingestBlobs`)

New method on the Postgres dialect, used by Phase W:

```ts
ingestBlobs(blobs: Array<{ sha256: Uint8Array; data: Uint8Array }>): Promise<void>
```

Runs on the pool connection, self-committing, no advisory lock (the F6
pattern), in two statements:

1. `UPDATE blobs SET last_referenced_at = now() WHERE sha256 = ANY($1)
   RETURNING sha256`. The rows returned are present *and* now locked-and-touched,
   so a concurrent GC at REPEATABLE READ either already deleted them (they are
   not returned, and we insert them below) or hits a serialization failure on
   its DELETE and retries after our insert is visible.
2. `INSERT INTO blobs ... ON CONFLICT (sha256) DO UPDATE SET last_referenced_at
   = now()` for the hashes not returned by step 1, deduplicated within the
   batch.

Redis backfill only for hashes inserted in step 2. No content-cache insertion
here; the content cache belongs to the sandbox's SqlFs, and Phase W has no
sandbox.

### Graft (`SqlDialect.bulkGraft`, `SqlFs.bulkGraft`)

```ts
interface GraftFile { readonly path: string; readonly sha256: Uint8Array; readonly mode: number; readonly size: number }
bulkGraft(tx, files: GraftFile[]): Promise<Map<string, PathCacheEntry>>
```

Copies `bulkIngest`'s Phase A (directories), B (existing dirents), D (inodes)
and E (dirents), drops Phase C, and adds a touch-RETURNING statement identical
to `ingestBlobs` step 1 before creating inodes. If any hash is not returned,
the whole graft throws `EGRAFTMISSING` with the missing hashes; the installer
deletes the stale manifest and redoes that wheel in Phase W. Paths are
re-validated with the wheel reader's rules. `SqlFs.bulkGraft` updates
`pathCache` and inserts nothing into the content cache.

After publish, the installer warms the content cache with a bounded set of
small files (`.py` and `dist-info` under 64 KB, up to 4 MB total) read through
the normal path so Redis backfills. The bound and the policy are tuned after
measuring cold and warm `databricks --version` on a fresh session.

### Limits

| Limit | Default | Env |
|---|---|---|
| wheel bytes | 32 MB | `PIP_MAX_WHEEL_BYTES` |
| total download per install | 256 MB | `PIP_MAX_INSTALL_DOWNLOAD_BYTES` |
| single extracted file | 32 MB | `PIP_MAX_FILE_BYTES` |
| extracted bytes per install | 512 MB | `PIP_MAX_INSTALL_BYTES` |
| files per install | 50 000 | `PIP_MAX_INSTALL_FILES` |
| per-sandbox package bytes | 1 GB | `PIP_SANDBOX_QUOTA_BYTES` |
| per-sandbox package files | 100 000 | `PIP_SANDBOX_MAX_FILES` |
| concurrent installs per replica | 2 | `MAX_CONCURRENT_PIP_INSTALLS` |
| metadata bytes / requests / cache per install | 32 MB / 200 / 200 | `PIP_MAX_METADATA_*` |

The per-sandbox file cap exists because the path-cache budget is by count,
not bytes: at `path.length + 100` bytes per entry and 50 MB, about 330 000
paths fit before the reaper evicts the session every minute. 100 000 leaves
headroom for user files. Add `REDIS_PATH_SNAPSHOT_MAX_BYTES` (default 16 MB)
so a large sandbox skips snapshot publish and falls back to DB reload instead
of writing one oversized Redis value.

### Memory

Per in-flight install: one wheel buffer (up to 32 MB, plus secureFetch's
transient assembly copy), one inflate batch (8 MB), the driver's parameter
copy for that batch (8 MB), hash and parser state. Two installs per replica is
a lower bound of about 160 MB of buffers; the real figure is measured under
concurrency before the default is finalised.

### Phase 1 status

Implemented on `experiment/pip-install-databricks-cli` (worktree
`sqlfs-pip-experiment`). The WASM extractor is still the install path; Phase 3
rewires it.

- [x] **Wheel reader** (`src/api/commands/wheel-reader.ts`) on `yauzl` 3.4.0:
      central-directory validation before any inflate, async batched inflate,
      CRC-32 and RECORD verification, `WheelError` for every refusal.
- [x] **Pre-inflate checks**: encryption flag, compression other than 0/8,
      data descriptor with unknown sizes, NUL / backslash / absolute /
      drive-letter / `.` / `..` / empty segment / length > 512 paths, symlinks
      by external attributes, directory-versus-file collisions, duplicate
      paths, declared size over `PIP_MAX_FILE_BYTES`, cumulative bytes and
      count over `PIP_MAX_INSTALL_BYTES` / `PIP_MAX_INSTALL_FILES` (earlier
      wheels' totals passed in as `consumedBytes` / `consumedFiles`), and the
      archive itself over `PIP_MAX_WHEEL_BYTES`.
- [x] **Local-versus-central header agreement** (yauzl does not check this):
      filename bytes, compression method, CRC and both sizes, with the ZIP64
      extra field resolved on the local side and streamed entries (bit 3)
      exempted from the CRC/size half.
- [x] **WHEEL and RECORD**: exactly one `*.dist-info`, `Wheel-Version` `1.x`,
      `Root-Is-Purelib: true`, every non-RECORD entry listed with a
      urlsafe-base64-nopad `sha256=` hash, verified per entry.
- [x] **Bounded async inflate**: raw entry stream piped through
      `zlib.createInflateRaw({ maxOutputLength })` plus an independent byte
      counter; exact-size check, CRC-32 check, then the sha256. Any zlib or
      stream failure becomes one "corrupt or hostile archive" error with no
      error-code matching.
- [x] **Batching**: async generator yielding ≤ 8 MB inflated or ≤ 500 entries;
      the batch array is replaced before the next entry is inflated.
- [x] **Modes** normalised to 0o644, or 0o755 when any x bit is set.
      `.data/` subtrees are kept verbatim.
- [x] **Limits in one place** (`src/api/commands/package-limits.ts`):
      `packageLimits()` reads all seven `PIP_*` knobs once and memoises;
      `readPipLimits()` now derives `maxDownloadBytes`,
      `maxTotalDownloadBytes`, `maxWheelFiles` and `maxExtractedBytes` from it.
- [x] **`SqlDialect.ingestBlobs`** on the Postgres dialect: pool connection,
      self-committing, no advisory lock; touch-RETURNING then `INSERT ... ON
      CONFLICT DO UPDATE` for the rest, deduplicated within the batch; Redis
      backfill only for inserted rows; no content-cache write; wrapped in
      `runTrustedDbAsync`.
- [x] **`SqlDialect.bulkGraft`** + `GraftFile` + `EGRAFTMISSING`: the same
      touch-RETURNING before any inode, then Phases A/B/D/E/F shared with
      `bulkIngest` (extracted into `#bulkContext`, `#bulkEnsureDirs`,
      `#bulkExistingDirents`, `#bulkLinkFiles` — `bulkIngest`'s statements and
      their order are byte-for-byte unchanged). Paths re-validated with the
      shared rules in `src/sql-fs/package-path.ts`.
- [x] **`SqlFs.bulkGraft`** runs in the script tx like `bulkIngest`, updates
      `pathCache`, evicts a replaced inode's content and inserts nothing into
      the content cache; declared on `ICoherentFs`, so `ctx.fs` reaches it in
      Phase 3 exactly as `bulkIngest` is reached today.
- [x] **`REDIS_PATH_SNAPSHOT_MAX_BYTES`** (default 16 MB): an oversized encoded
      snapshot logs `snapshot_write_skipped_too_large` and publishes nothing,
      so the sandbox falls back to a DB reload.
- [x] **Tests**: `wheel-fixtures.ts` builder plus well-formed, hostile and
      fuzz suites (28 + 10 + 1); `ingestBlobs` counting-pool unit test;
      `SqlFs.bulkGraft` cache unit test; snapshot max-bytes unit test;
      integration tests for real `ingestBlobs` touch-then-insert and a real
      graft round trip including `EGRAFTMISSING`.

### Discoveries and Notable Information

- **yauzl spike result: adopt, but do not trust it for header agreement.**
  yauzl 3.4.0 (one dependency, `pend`; no bundled types, `@types/yauzl` 3.4.0
  matches) parses the central directory, handles ZIP64 (EOCD locator and the
  0x0001 extra field), rejects strong encryption (bit 6), multi-disk archives,
  bad file names (`..`, absolute, and — with `strictFileNames: true` —
  backslashes), stored-size mismatches, and inflates through
  `zlib.createInflateRaw` asynchronously. It does **not** compare the local
  file header against the central directory (`readLocalFileHeader` with
  `{minimal: true}` checks only the signature and the data bounds) and it
  creates its inflate stream with no `maxOutputLength`. Both gaps are closed
  here: entries are opened with `decodeFileData: false` and inflated through
  our own bounded stream, and `assertHeadersAgree` reads the full local header.
- **yauzl's own refusals fire before ours for some hostile shapes** (path
  traversal, absolute path, backslash, stored-size lie, traditional encryption
  on a stored entry). They are remapped to `WheelError` with yauzl's wording
  kept for diagnosis, so the caller still sees exactly one error type. The
  hostile tests assert the resulting message, which documents which layer
  refuses what.
- **The fuzz test earned its place immediately**: the first run surfaced an
  `unexpected EOF` from yauzl escaping through `readLocalFileHeaderPromise` /
  `openReadStreamPromise`, outside the per-entry catch. The whole generator
  body is now wrapped, so no third-party error can reach the installer.
- **`maxOutputLength` cannot be 0**, so it is `Math.max(size, 1)` and the
  independent counter is what enforces the exact declared size, including for
  empty files.
- **`ANY($1)` needs the array OID, not the element OID.** `db.array(hashes,
  17)` produced `op ANY/ALL (array) requires array on right side`; the
  parameter is typed `bytea[]` (OID 1001).
- **No wrapper needed to reach `bulkGraft` from a command.** `session.fs` is
  the `SqlFs` instance itself and `SessionScopedFs` only wraps the scope hooks,
  so Phase 3 can duck-type `ctx.fs` exactly as `routes/ingest.ts` does for
  `bulkIngest`.
- **Consolidating the limits changed the old extractor's numbers** (wheel
  16 MB → 32 MB, install download 64 MB → 256 MB, files 10 000 → 50 000,
  extracted bytes 48 MB → 512 MB). The pip test that used to build a
  10 001-file wheel now stubs `PIP_MAX_INSTALL_FILES=4`, which also cut that
  suite from 9.2 s to 1.6 s.
- **Pre-existing integration flake, unrelated to this phase.** Running the
  integration suite with file parallelism intermittently fails
  `rls.integration.test.ts` with `deadlock detected`: its `beforeAll` applies
  `0005_enable_rls.sql`, whose `ALTER TABLE` takes ACCESS EXCLUSIVE locks while
  other files are mid-transaction. Reproduced with the two new Phase 1
  integration files excluded (2 of 3 runs), and absent under
  `--no-file-parallelism` (14 files / 97 tests green). Worth fixing separately
  by not running DDL from a test that shares the database.
- **Deferred to Phase 3, as planned:** the install path still uses
  `EXTRACT_CODE`; the post-publish content-cache warm is not implemented.

## Phase 2: migration 0007

```sql
CREATE TABLE IF NOT EXISTS package_manifests (
    wheel_sha256    BYTEA PRIMARY KEY,
    manifest_format INTEGER NOT NULL,
    name            TEXT NOT NULL,
    version         TEXT NOT NULL,
    file_count      INTEGER NOT NULL,
    total_bytes     BIGINT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_package_manifests_name_version ON package_manifests(name, version);
CREATE INDEX IF NOT EXISTS idx_package_manifests_last_used_at ON package_manifests(last_used_at);

CREATE TABLE IF NOT EXISTS package_manifest_files (
    wheel_sha256 BYTEA NOT NULL REFERENCES package_manifests(wheel_sha256) ON DELETE CASCADE,
    path         TEXT NOT NULL,
    blob_sha256  BYTEA NOT NULL REFERENCES blobs(sha256) ON DELETE RESTRICT,
    mode         INTEGER NOT NULL,
    size         BIGINT NOT NULL,
    PRIMARY KEY (wheel_sha256, path)
);
CREATE INDEX IF NOT EXISTS idx_package_manifest_files_blob ON package_manifest_files(blob_sha256);

CREATE TABLE IF NOT EXISTS sandbox_packages (
    sandbox_id   TEXT NOT NULL REFERENCES sandboxes(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    version      TEXT NOT NULL,
    wheel_sha256 BYTEA NOT NULL REFERENCES package_manifests(wheel_sha256) ON DELETE RESTRICT,
    installed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (sandbox_id, name)
);
CREATE INDEX IF NOT EXISTS idx_sandbox_packages_wheel ON sandbox_packages(wheel_sha256);
-- RLS on sandbox_packages: same ENABLE/FORCE/policy shape as inodes in 0005.
-- package_manifests and package_manifest_files carry no sandbox_id and no RLS,
-- like blobs, with a comment saying why.
```

`manifest_format` starts at 1 and is bumped whenever extraction rules, path
spreading, mode normalisation or the compat overlay change. Lookups match on
`(wheel_sha256, manifest_format)`; an old-format row is treated as a miss and
replaced.

The FK from `package_manifest_files` to `blobs` is the GC safety net the
audit asked for: if a manifest row commits first, GC's DELETE of that blob
fails and the transaction retries with the manifest visible; if GC's DELETE
commits first, the manifest INSERT fails and Phase W reinserts the blob. The
`ingestBlobs` touch makes both orderings rare; the FK makes them harmless.

### GC changes

Inside the existing REPEATABLE READ transaction in `gcOrphanBlobs`, in order:

1. `DELETE FROM package_manifests m WHERE m.last_used_at < now() - $ttl AND
   NOT EXISTS (SELECT 1 FROM sandbox_packages p WHERE p.wheel_sha256 =
   m.wheel_sha256)`; `PIP_MANIFEST_TTL_MS` default 30 days. The `NOT EXISTS`
   is required because `sandbox_packages` references manifests with RESTRICT.
2. The blob anti-join with one added clause: `AND NOT EXISTS (SELECT 1 FROM
   package_manifest_files f WHERE f.blob_sha256 = b.sha256)`.

Because step 1 precedes step 2 in the same transaction, blobs rooted only by an
expired manifest are collectible in the same pass. `runBlobGc` reports
manifests deleted alongside blobs deleted.

## Phase 3: publish, ledger, uninstall

### Publish (`publishInstall`, in the installer, inside the script tx)

1. Load `sandbox_packages` for the sandbox and the manifest file rows for
   every installed wheel plus every wheel being installed.
2. Ownership: build `path → { wheel, sha256 }` over the post-install set
   (installed wheels not being superseded, plus incoming wheels). Two owners
   with different hashes for one path is a conflict; fail before any mutation,
   naming both packages and the path.
3. Quota: sum `total_bytes` and `file_count` over the post-install set against
   `PIP_SANDBOX_QUOTA_BYTES` and `PIP_SANDBOX_MAX_FILES`; fail naming the
   numbers and the knobs.
4. Superseded versions: for each incoming `name` whose ledger row has a
   different `wheel_sha256`, delete paths owned solely by the old wheel whose
   current inode `content_sha256` equals the manifest hash. Paths whose hash
   differs are preserved and listed in stdout as "kept modified file". Empty
   directories left behind are removed.
5. `bulkGraft` all incoming wheels' rows. On `EGRAFTMISSING`, delete the stale
   manifest, redo that wheel in Phase W, retry publish once.
6. Upsert `sandbox_packages` rows; bump `package_manifests.last_used_at` for
   every wheel in the post-install set.
7. Write the compat overlay if the synthetic `requests` provider was used.

A graft over an identical `(name, wheel_sha256)` already in the ledger is a
no-op and reports "already satisfied".

### `pip uninstall NAME`, `pip list`, `pip freeze`

Uninstall removes the ledger row and the paths owned solely by that wheel
whose current hash matches, preserving and reporting modified files, and
removing emptied directories. `list` and `freeze` read the ledger. All three
are cheap; `existingPackageTotals` and its per-path `lstat` calls are deleted.

Sandboxes with files under `/site-packages` but no ledger rows (installed
before this change) are invisible to the quota until reinstalled; the first
`pip install` of any package writes ledger rows for that install only.
Documented.

## Phase 4: singleflight

Wheel lease via `withDistributedLock` on `vfs:{tenant}:pip:wheel:{sha256hex}`
with the module's defaults (60 s lease, 20 s renewal, compare-and-delete
release). Acquire before the manifest lookup, hold through manifest record,
release before the next wheel. After acquiring, look the manifest up again;
the previous holder may have just recorded it. Without Redis, an in-process
`Map<string, Promise<void>>` gives the same behaviour per replica; across
replicas without Redis the work is duplicated and the result is still correct
because blob inserts are content addressed and manifest inserts are upserts.

Structured log events: `pip_manifest_hit`, `pip_manifest_miss`,
`pip_singleflight_wait`, `pip_publish`, each with wheel, file count, bytes and
elapsed time, so the estimates in this document can be replaced with
measurements.

## Phase 5: write methods as a capability

Add `networkWrite: boolean` to `RuntimeOptions`, persisted in sandbox meta
(migration 0008, same shape as 0004's network flag), exposed on the create
routes and the MCP `sandbox_create` tool, and exported into the sandbox env as
`SQLFS_HTTP_WRITE=1`. Both shims (collapsed into one implementation, as the
v1 review asked) allow POST, PUT, PATCH and DELETE only when that variable is
set. Reject `files=` with a message explaining the JSON-string body encoding
and pointing at base64-in-JSON.

Transport-level enforcement is not possible here: the sandbox's `Bash` runs
with `dangerouslyAllowFullInternetAccess`, which enables all methods, and
`git push` on the same network config needs POST. SECURITY.md is rewritten to
say exactly that: the read-only default is a guardrail against accidental
writes in the `requests` shim, `jb_http` and `curl` are not restricted, and
`network: true` is the real capability boundary.

## Phase 6: docs and changeset

- `deleteSandbox` doc comment (`types.ts:179-183`) drops "blobs".
- `drizzle.config.ts` reference to a missing `schema.ts` removed; CLAUDE.md
  file layout and env table updated for every `PIP_*`,
  `MAX_CONCURRENT_PIP_INSTALLS`, `REDIS_PATH_SNAPSHOT_MAX_BYTES`.
- SECURITY.md: package limits table, host-side extraction with async bounded
  inflate, CRC and RECORD verification, the network section above, and the
  known just-bash runtime limits (8 MB file I/O, ~6 MB `jb_http` responses)
  until the upstream bridge PR ships.
- DEVELOPER.md GC section: manifests as a GC root, the TTL, the FK.
- Export: document that MCP `fs_export` defaults to `/home/user`, which
  excludes `/site-packages`, and that an explicit broader base path includes
  it. Whether to add an `includePackages` option is deferred.
- Changeset: minor.

## Not doing

As v2, plus: spec-complete wheel `.data/` spreading (verbatim extraction under
`<dist>.data/` is the supported subset); Postgres advisory-lock singleflight
for no-Redis multi-replica; `--force` for modified files; export policy for
package trees.

## Testing

Unit, mocked dialect: wheel reader against fixtures built in the test
(stored, deflate, ZIP64 size fields, hostile: traversal, symlink, declared-size
lie, CRC mismatch, RECORD mismatch, encryption flag, duplicate path, dir/file
collision); `ingestBlobs` touch-then-insert with a counting mock; `bulkGraft`
path-cache update and `EGRAFTMISSING`; publish ownership conflict, quota,
superseded-path removal with a modified file preserved; uninstall; resolver
conformance fixtures; markers; synthetic `requests`; the pip fetch parity
tests; admission and Python slot behaviour including the no-double-acquire
case; the `python3` override forms.

Integration behind `describe.skipIf(!process.env.DATABASE_URL)`: migration
0007 applies and is idempotent; a blob referenced only by a manifest survives
`gcOrphanBlobs` with `minAgeMs: 0`; `PIP_MANIFEST_TTL_MS=0` collects manifest
and blob in one pass; a manifest referenced by `sandbox_packages` survives
TTL; real graft round trip; two-sandbox end-to-end with zero fetch calls in the
second; hand-deleted blob triggers fallback and stale-manifest deletion;
concurrent cold install on two sessions does one download.

Each test file under 300 lines, split by concern.

## Implementation order

Phase 0 (all items independent, land as separate PRs if convenient) → Phase 1
wheel reader and `ingestBlobs` → Phase 2 migration and GC → Phase 3 publish,
ledger, uninstall → Phase 4 singleflight → Phase 5 capability → Phase 6 docs.
Phases 1 through 3 replace the WASM extractor together; until Phase 3 lands,
the old extractor stays the install path behind Phase 0's fixes.

## Risks

- `yauzl` behaviour on malformed archives must be confirmed by the spike and
  a small fuzz test; if it falls short, the fallback is a worker-isolated
  parser, which is more work.
- The FK on `package_manifest_files` makes GC's blob DELETE fail loudly if the
  `NOT EXISTS` clause is ever wrong; that is the intended failure mode, but it
  means GC bugs surface as errors rather than as silent data loss or silent
  retention. Test both directions.
- The exec-timeout partial-publish window is inherited platform behaviour, not
  introduced here. If it proves to matter in practice, the fix is in
  `execWithRuntimeThrottle` (abort the scope on a timed-out result), which is
  wider than this plan.
- `MAX_CONCURRENT_PIP_INSTALLS=2` is a guess until measured.
- Legacy `/site-packages` content without ledger rows is outside the quota.

## References

- v2 (research, findings, live run): `2026-09-18_12-44-19_cross-sandbox-package-reuse-v2.md`.
- Audit: `2026-09-18_v2-audit-review.md`.
- Commit semantics: `src/api/session-manager.ts:1645-1666`; missing-blob read:
  `src/sql-fs/sql-fs.ts:1185-1189`; RLS pattern: `migrations/postgres/0005_enable_rls.sql`.
- 3.4.2 path shim: `just-bash/packages/just-bash/src/commands/python3/worker.ts:702-716, 835-846`.

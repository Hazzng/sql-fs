---
date: 2026-09-18T11:49:20+09:30
researcher: Harry.Nguyen@insightfactory.ai
git_commit: 37f6070da5c32f3e8105db9da24af009ea81081b
branch: experiment/pip-install-databricks-cli
repository: virtualFS
task: "Sandbox package install: cross-sandbox reuse, version handling, and refusal reduction"
tags: [implementation-plan, pip, packages, blobs, cas, dedup, postgres, gc, multi-tenant, wasm, coverage]
status: superseded
superseded_by: 2026-09-18_12-44-19_cross-sandbox-package-reuse-v2.md
last_updated: 2026-09-18
last_updated_by: Harry.Nguyen@insightfactory.ai
---

# Sandbox package install: reuse, versions, and refusals

## Overview

This document covers two related objectives for the experimental pip support.
The first is making repeat installs cheap, which is most of the plan. The second
is making the feature usable: removing install refusals that serve no purpose, and
removing the HTTP method restriction that currently stops an agent writing anything
back to a Databricks workspace. The second group shares the research below but is
otherwise independent and can land on its own.

When sandbox A runs `pip install databricks-cli` and sandbox B on the same API
later installs the same package at the same version, B repeats the entire
install: it refetches PyPI metadata, redownloads every wheel, boots a CPython
WASM worker per wheel to unzip, and writes every file through SqlFs. None of
that work is reused.

The file contents, however, are already shared. `blobs` is a content-addressable
store keyed by `sha256` with no sandbox scoping and no RLS, so B's writes adopt
A's rows instead of storing the bytes again. The payload is already deduplicated.
What is missing is a listing: nothing in the system records that
`databricks-cli 0.18.0` consists of a particular set of `(path, sha256, mode)`
tuples, so a CAS store full of the right bytes cannot be turned back into an
installed package.

This plan adds that listing as a manifest table, plus one new dialect method that
inserts inodes and dirents pointing at blobs that already exist. A repeat install
becomes a few SQL statements instead of roughly 25 to 35 HTTPS round-trips, ten
CPython worker boots, and 600 to 1000 Postgres round-trips.

## What we are trying to achieve

Two things.

Make the second and subsequent installs of the same `(package, version)` within a
tenant close to free, without weakening any of the existing isolation or GC
guarantees.

Separately, stop refusing installs that should succeed. Some refusals are
fundamental to running CPython under WASM and will not change. Several others are
artifacts of limits that do not line up, or of error handling that aborts an entire
install over one unrecognized token. Those are worth fixing, and they are cheap.

Concretely, after this change:

- Sandbox B's `pip install databricks-cli==0.18.0` performs zero PyPI requests,
  zero CPython worker boots, and no per-file write round-trips when a manifest
  for that exact version exists and its blobs are still present.
- The resulting file tree in B is byte-identical to a fresh install.
- Nothing about sandbox isolation changes. B gets its own inodes and dirents; it
  shares only the immutable blob payloads it would have deduplicated onto anyway.
- A missing or partially collected manifest silently falls back to a real install.
- Installing a second version of an already-installed package removes the first
  version's files rather than layering on top of them, and `databricks` resolves
  its entrypoint from the version actually installed.

## Current state analysis

All line references verified against commit `37f6070` unless marked as an
estimate.

### What already deduplicates

- `blobs` has no `sandbox_id` and no `tenant_id`. The primary key is `sha256`
  alone (`src/sql-fs/migrations/postgres/0000_create_tables.sql:38-44`), and the
  table comment already calls it "content-addressable store, global across all
  sandboxes".
- RLS is deliberately not enabled on `blobs`. `0005_enable_rls.sql:40-41` states
  the reason, and the migration only touches `inodes` (`:47`), `dirents` (`:61`)
  and `sandboxes` (`:75`). There is no `ALTER TABLE blobs` anywhere in the
  migrations, so cross-sandbox dedup is real and RLS does not defeat it.
- Every blob insert is touch-only on conflict:
  `ON CONFLICT (sha256) DO UPDATE SET last_referenced_at = now()`
  (`src/sql-fs/dialects/postgres.ts:623-629`, and identically in `upsertBlob` at
  `:596-601` and the bulk path at `:1029`). A second sandbox writing identical
  bytes adopts the existing row. `data` is never rewritten.
- The Redis blob cache is keyed `vfs:{tenantId}:blob:{sha256hex}`
  (`src/sql-fs/redis-blob-cache.ts:35-37`) with no sandbox component, so sandbox B
  does hit sandbox A's entries. Reads consult it at `postgres.ts:655-657`; writes
  backfill at `postgres.ts:631-633` and `:212-214`. This helps reads after an
  install and does nothing for the install itself.

### What duplicates

- `inodes` and `dirents` both carry
  `sandbox_id TEXT NOT NULL REFERENCES sandboxes(id) ON DELETE CASCADE`
  (`0000_create_tables.sql:18`, `:34`), and `writeFileComposite` pins it on every
  insert (`postgres.ts:179-180`, `:188-189`). B creates its own row pair per file.
- Dedup is tenant-wide, not deployment-wide. `src/api/tenants.ts:5` maps each
  tenant to its own connection string, so two tenants installing the same package
  store the bytes twice. This is correct and should not change.
- `inodes.content_sha256` (`0000_create_tables.sql:24`) is the link to `blobs`,
  and there is no foreign key. Referential integrity rests on GC discipline alone.
  `getBlobsForSandbox` already tolerates a gap (`postgres.ts:733`).

### The work that repeats

- The only PyPI cache is function-local. `const indexCache = new Map(...)` lives
  inside `resolvePlan` (`src/api/commands/pip-command.ts:753`) and is discarded on
  return, so it does not survive a second `pip install` in the same sandbox, let
  alone reach another sandbox.
- Network per install: `GET /pypi/{name}/json` (`pip-command.ts:721`), often a
  second `GET /pypi/{name}/{version}/json` (`:737-740`), then the wheel body
  (`:892`), with manual redirect following up to `maxRedirects: 5` (`:22`).
  Estimated 25 to 35 round-trips and 10 to 30 MB for a ten-wheel closure.
- One CPython WASM worker boot per wheel. `verifyAndExtract` calls
  `runWasmPython` (`:856`), which is `ctx.exec("python", ...)` (`:794`). just-bash
  spawns a fresh worker per invocation and terminates it afterwards. At roughly
  80 MB and a full CPython-Emscripten init each, that is about ten cold boots,
  serialized by just-bash's per-filesystem execution queue.
- Two Postgres round-trips per extracted file: `commitBlob` on its own pool
  connection (`postgres.ts:623-629`) plus `writeFileComposite` on the script
  transaction (`postgres.ts:173-209`). Estimated 600 to 1000 round-trips for a
  300 to 500 file install, with every byte retransmitted even though the conflict
  clause discards them.
- The wheel itself round-trips through SqlFs. `pip-command.ts:854` writes it to
  `/tmp/.sqlfs-pip/`, creating a real blob plus inode plus Redis set, and `:871`
  removes it, leaving an orphan blob for GC.

### Version handling, which does not exist today

`install` records nothing about what a sandbox has installed. There is no
uninstall, no version marker, and no cleanup. Consequences:

- Installing `databricks-cli==0.17.0` and then `==0.18.0` leaves both. Overlapping
  paths are overwritten, because dirents upsert with
  `ON CONFLICT (parent_inode_id, name) DO UPDATE SET inode_id = EXCLUDED.inode_id`
  (`postgres.ts:191`, and the same clause at `:534`). Files present in 0.17.0 but
  not 0.18.0 stay behind as stale orphans, and both
  `databricks_cli-0.17.0.dist-info/` and `databricks_cli-0.18.0.dist-info/` exist.
- That breaks entrypoint discovery. `getDatabricksEntrypoint`
  (`pip-command.ts`) filters paths ending in `.dist-info/entry_points.txt`,
  sorts them, and returns the first match. `0.17.0` sorts before `0.18.0`, so
  after an upgrade the `databricks` command reads the older version's entrypoint
  declaration. It currently still works by accident, because the module files were
  overwritten by the newer install, so `databricks_cli.cli:main` resolves to new
  code. An entrypoint that moves between versions would break it.
- Stale files also inflate `existingPackageTotals`, so repeated upgrades eat into
  `maxWheelFiles` and `maxExtractedBytes` with files nothing imports.

This matters for grafting in two ways. A graft must define what happens when a
different version of the same package is already present, and the manifest
recorder must not attribute another version's leftover files to the version being
recorded. Recording from the extractor's own file list rather than diffing the
tree avoids the second problem.

### Install coverage, what gets refused today

Two very different categories, and conflating them wastes effort.

**Fundamental to the runtime, not tunable.** `isSupportedPureWheel` accepts a wheel
only when `abi === "none" && platform === "any"` with a `py3` or `py2.py3` tag.
That refuses numpy, pandas, scipy, pyarrow, cryptography, psycopg2, lxml, pillow,
grpcio, and everything else carrying a compiled extension. Source distributions are
refused for the same reason. The sandbox runs CPython compiled to WASM, so a
`manylinux_x86_64` shared object cannot load and there is no toolchain to build
one. No limit change affects this. The only real answer is a source of prebuilt
WASM wheels, as Pyodide maintains, which is a separate and much larger project.

**Artifacts worth fixing.** These refuse installs that would otherwise work:

- The per-wheel limit does not mean what it says, and fails silently.
  `PIP_LIMITS.maxDownloadBytes` is 16 MB, but just-bash's `secureFetch` caps
  responses at 10 MB by default and `session-manager.ts:612` passes
  `network: { dangerouslyAllowFullInternetAccess: true }` with no `maxResponseSize`.
  A wheel between those two sizes throws `ResponseTooLargeError` inside
  `fetchPypi`. That is not a `PipError`, so the catch-all in `install` reports
  `pip: package installation failed` with no reason at all.
- One unknown marker variable aborts the whole install. `evaluateMarker` calls
  `fail()` when an identifier is missing from `MARKER_VALUES`. A dependency that
  merely mentions a PEP 508 variable we do not model kills the install, even when
  that dependency would have been skipped anyway.
- `maxMetadataBytes: 4 MB` is measured against `/pypi/{name}/json`, which returns
  every release a project has ever published. Projects with long histories can
  exceed it, and the per-version endpoint would not.
- Extras are refused outright. `parseRequirement` fails on `foo[bar]`, so anything
  documented as `pip install pkg[feature]` cannot be installed even when the extra
  resolves to pure-Python dependencies.
- `maxExtractedBytes: 48 MB` and `maxWheelFiles: 10_000` are cumulative per
  sandbox, not per install, because `existingPackageTotals` sums everything under
  `/site-packages` first. Combined with the absence of uninstall, stale files from
  earlier versions count against the budget permanently.

### The read-only HTTP transport is our own policy, not a limitation

`pip-command.ts` rejects every method except GET and HEAD in two places: the
`_sqlfs_request` patch inside `PYTHON_PACKAGE_BOOTSTRAP`, and `Session.request` in
the compat `requests/__init__.py`. `SECURITY.md` documents this as a property of
the transport.

Nothing underneath requires it:

- just-bash's `jb_http` bridge exposes a general
  `request(self, method, url, headers=None, data=None, json_data=None)` plus a
  `post()` helper, and marshals `{url, method, headers, body}` through to the host
  (`node_modules/just-bash/dist/bundle/chunks/worker.js`, `generateHttpBridgeCode`
  and `httpRequest`).
- `createSecureFetch` allows `GET, HEAD, POST, PUT, DELETE, PATCH, OPTIONS` when
  `dangerouslyAllowFullInternetAccess` is set, which is exactly how
  `session-manager.ts:612` configures a network-enabled sandbox, and it attaches a
  body for methods that take one.

The security argument in `SECURITY.md` is that rejecting methods avoids "falling
back to sockets", but the shim routes through `jb_http` to `secureFetch` for every
method, so a POST is as controlled as a GET. The real capability gate is
`network: true` at sandbox creation.

The one genuine constraint is body encoding. The bridge serializes the request as
JSON, so the body must be a string. Binary payloads need base64, and both shims
reject `files=` multipart outright. Databricks workspace import takes JSON with
base64 content, so it fits; `dbfs put` style multipart uploads do not.

### GC behavior that constrains the design

- Sandbox deletion never touches blobs. `deleteSandbox` takes an advisory lock
  and runs `DELETE FROM sandboxes WHERE id = ?` (`postgres.ts:313-318`);
  `ON DELETE CASCADE` reaps inodes and dirents and the blobs are orphaned, not
  deleted. The doc comment at `src/sql-fs/types.ts:179-182` says it deletes
  "inodes, dirents, and blobs", which is wrong: `blobs` has no foreign key and no
  cascade. Correct it while we are here.
- The orphan set is an anti-join over every inode in the tenant database
  (`postgres.ts:754-765`):

      DELETE FROM blobs b
      WHERE NOT EXISTS (
          SELECT 1 FROM inodes i WHERE i.content_sha256 = b.sha256 AND i.nlink > 0
      )
      AND (b.last_referenced_at IS NULL
           OR b.last_referenced_at < now() - (minAgeMs * interval '1 millisecond'))

  It runs with no sandbox context, which is why the RLS "no context sees
  everything" escape exists (`0005_enable_rls.sql:18-20`). `runBlobGc` iterates
  tenants with a fresh dialect each (`src/api/blob-gc.ts:72-77`).
- This clause is the reason a manifest alone is not safe. A manifest row is not
  an inode, so blobs backing a cached-but-currently-uninstalled package look like
  orphans and become collectible after the grace window, leaving the manifest
  pointing at dead hashes.
- The dedup re-adoption race is handled by isolation level, not the window:
  repeatable read with retry on `40001` (`postgres.ts:743-750`,
  `blob-gc.ts:31`, `:52-53`). `postgres.ts:750` describes the grace window as
  defense in depth and churn control.
- `BLOB_GC_MIN_AGE_MS` defaults to three hours (`src/api/cli/gc.ts:63`). Running
  `pnpm db:gc -- --min-age-ms 0` (advertised at `gc.ts:7`) removes the window that
  protects a blob between `commitBlob` and its referencing inode commit
  (`sql-fs.ts:860-863`, explained at `postgres.ts:620-622`).

### Key discoveries

- The expensive half of an install is already solved and the cheap half is not.
  Bytes deduplicate perfectly; the few hundred rows of tree structure are what
  actually has to be recreated, and recreating them currently drags the whole
  download-and-unzip pipeline along with it.
- `bulkIngest` is most of the machinery we need. It exists on the dialect
  interface (`src/sql-fs/types.ts:396`), takes
  `BulkIngestFile { path, content: Uint8Array, mode }`, creates missing parent
  directories automatically, and returns `Map<string, PathCacheEntry>`. It takes
  payload bytes and hashes them itself, which is exactly the one thing we need to
  invert.
- `PathCacheEntry` already carries `contentSha256: Uint8Array | null`
  (`src/sql-fs/types.ts`), and `bulkIngest` returns those entries, so recording a
  manifest after an install needs no extra reads.
- Dedup saves disk, not wire. `${data}` is still in the INSERT's VALUES list on
  every write, so a repeat install ships every byte to Postgres for it to discard.
  Grafting removes that traffic entirely, which is a larger win than the storage
  saving people usually assume CAS gives them.
- Sandbox deletion is safe for shared blobs, so a package-layer sandbox would get
  GC safety for free where a manifest table has to earn it with a GC change.
- A per-sandbox installed-packages record solves three problems at once: version
  tracking, the file list needed to remove an old version on upgrade, and a
  reliable entrypoint lookup that replaces scanning and regexing `dist-info`. The
  altitude review of the original pip commit proposed exactly this record, for the
  entrypoint reason alone. It is cheap here because the manifest work already
  produces the file lists.
- Unrelated to reuse but found during this research and worth fixing:
  `PYTHON_INVOCATION_REGEX = /\bpython3?\b/` (`src/api/session-manager.ts:211`) is
  tested against the script text (`:1626`), and neither `pip install ...` nor
  `databricks ...` matches. Both spawn CPython workers entirely outside
  `MAX_CONCURRENT_PYTHON` (default 5, `session-manager.ts:460`). N sandboxes
  installing concurrently spawn N workers with no cap. Workers are serialized and
  terminated within a single exec, so one install peaks near 80 MB with ten
  allocate and free cycles rather than 800 MB, but nothing bounds the total across
  sandboxes.
- `src/sql-fs/schema.ts` does not exist even though `drizzle.config.ts:4` declares
  it. The raw SQL migrations are the real schema, and CLAUDE.md's file layout is
  stale on this point. The orphan-blob-GC plan already noted the same thing.

## Desired end state

A `package_manifests` table records, per `(name, version)`, the exact file list an
install produced. `pip install` consults it first. On a hit whose blobs are all
still present, the install becomes one transaction that inserts inodes and dirents
referencing existing blobs. On a miss, or if any blob has been collected, the
normal install path runs and records a fresh manifest at the end.

### Verification

- Install `databricks-cli` in sandbox A, then in sandbox B. B's exec issues no
  requests to `pypi.org` or `files.pythonhosted.org` and spawns no CPython worker.
- The path sets and per-file `content_sha256` values in A and B are identical.
- `python3 -c "import databricks_cli"` succeeds in B.
- Deleting sandbox A and running `pnpm db:gc` leaves B's files readable and leaves
  the manifest usable for a third sandbox.
- Corrupting the manifest (deleting one referenced blob by hand) makes a fresh
  install fall back to the network path and succeed.

## What we are not doing

- Not changing how the first install works. Wheel resolution, SHA-256
  verification, and WASM extraction stay as they are. This plan makes repeats
  cheap; it does not replace the extraction pipeline.
- Not sharing anything across tenants. Each tenant has its own database, and that
  boundary stays.
- Not adding a wheel or PyPI metadata cache. A manifest hit skips the network
  entirely, which makes a wheel cache mostly redundant.
- Not building host-side unzip with `node:zlib`. It is a real win for the first
  install and is tracked separately; it is orthogonal to reuse.
- Not supporting native or platform wheels, and not supporting source
  distributions. This is the single largest cause of refusals and it is not a
  tunable limit. See "Install coverage" below for why, and treat any work on it as
  a separate investigation with a much larger scope than this plan.
- Not adding a package index other than PyPI.

## Implementation approach

The core new capability is the same under either design: insert inodes and dirents
from `(path, sha256, mode, size)` without payloads. Everything else is a question
of where the file list comes from.

### Option A, manifest table (recommended)

A table keyed by `(name, version)` holding the file list, unscoped like `blobs`.

Advantages: explicit and inspectable, no RLS work for reads, invalidation is
trivial because PyPI forbids reuploading a version so `(name, version)` to files is
immutable.

Cost: a migration, and one extra `NOT EXISTS` in the GC anti-join so manifest rows
count as references. Without that clause the cache rots into dangling hashes.

### Option B, package-layer sandbox

A well-known sandbox per tenant holding canonical installs, grafted from.

Advantages: GC safety comes free because the layer's inodes keep blobs alive. No
migration, no GC change.

Cost: reading another sandbox's rows requires running without sandbox context, the
way GC does, and the layer needs protection from eviction and deletion.
`SessionManager` also assumes one writer per sandbox, so the layer needs an
explicit frozen mode.

### Recommendation

Option A. The GC clause is one line, and an explicit table is easier to reason
about, inspect, and invalidate than a sandbox that must never be deleted. Option B
trades a one-line GC change for lifecycle and RLS complexity spread across
`SessionManager`.

## Phase 1: migration 0007, manifest table and GC root

### Phase 1: changes required

Next migration number is `0007` (`0006_blob_last_referenced_at.sql` is current).

Create `src/sql-fs/migrations/postgres/0007_package_manifests.sql`:

- `package_manifests (name TEXT, version TEXT, files JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (name, version))`.
- `files` holds an array of `{ path, sha256 (hex), mode, size }`.
- No RLS, matching `blobs`, with a comment saying why.
- An expression index over the referenced hashes to keep the GC clause cheap.

Amend `gcOrphanBlobs` (`postgres.ts:754-765`) with a second `NOT EXISTS` so a blob
referenced by any manifest is never an orphan.

### Phase 1: success criteria

- Migration applies on boot and is idempotent.
- An integration test proves a blob referenced only by a manifest survives
  `gcOrphanBlobs` with `minAgeMs: 0`.
- An existing GC test still collects a genuinely unreferenced blob.

## Phase 2: graft capability on the dialect

### Phase 2: changes required

- Add `GraftFile { readonly path: string; readonly sha256: Uint8Array;
  readonly mode: number; readonly size: number }` to `src/sql-fs/types.ts`.
- Add `bulkGraft(tx: Tx, files: GraftFile[]): Promise<Map<string, PathCacheEntry>>`
  to `SqlDialect` beside `bulkIngest` (`types.ts:396`), documented as requiring the
  blobs to exist already.
- Implement it in `PostgresDialect` by copying `bulkIngest`'s parent-directory
  creation and multi-row inode and dirent inserts, dropping the blob insert and
  taking `sha256` from the caller.
- Touch `last_referenced_at` on every referenced blob in the same transaction, so a
  graft protects its blobs the way a write does.
- Expose `SqlFs.bulkGraft` next to `bulkGraft`'s sibling at `sql-fs.ts:810`, adding
  the resulting entries to `pathCache`.
- Add `bulkGraft: vi.fn()` to the dialect mocks that already stub `bulkIngest`
  (six test files, see `grep -rn "bulkIngest" src`).

### Phase 2: success criteria

- Unit tests with a mocked dialect prove `pathCache` is updated and no blob insert
  is attempted.
- An integration test grafts a file whose blob exists and reads identical bytes
  back.
- Grafting a missing sha256 fails the transaction rather than creating a dangling
  inode.

## Phase 3: per-sandbox installed-packages record

### Phase 3: overview

Give each sandbox a record of what it has installed, so upgrades can replace
rather than layer, and so entrypoint lookup stops guessing from sorted directory
names. This is a prerequisite for grafting a version over a different one, and it
fixes a bug that exists today.

### Phase 3: changes required

- Write `/site-packages/.sqlfs-installed.json` after a successful install, holding
  one entry per package: `name`, `version`, the file list produced by the
  extractor, and any console entrypoints parsed from its `dist-info`.
- On install, if an entry for the same `name` exists at a different `version`,
  delete that entry's files before extracting or grafting the new one. Delete only
  paths the record attributes to that version, never a whole subtree, so a file
  shared with another package is not removed out from under it.
- Rewrite `getDatabricksEntrypoint` to read this record instead of scanning
  `getAllPaths()` for `*.dist-info/entry_points.txt` and regexing each one. That
  removes a full path-cache walk per `databricks` invocation as well as the
  sorted-first-match bug.
- Treat a missing or unparseable record as an empty record, so sandboxes that
  installed packages before this change keep working and self-heal on next install.

### Phase 3: success criteria

- Installing 0.17.0 then 0.18.0 leaves exactly one `databricks_cli-*.dist-info`
  directory, and no file that belongs only to 0.17.0.
- `databricks` resolves its entrypoint from 0.18.0 after that upgrade. A regression
  test should assert this against two fixture wheels whose entrypoints differ.
- A sandbox with packages but no record still installs correctly and gains a record.

## Phase 4: record a manifest after a successful install

### Phase 4: changes required

In `install` (`pip-command.ts`), after extraction and after
`writeRequestsCompat`, collect the `/site-packages` subtree that this install
added and upsert one manifest row per resolved package.

The file list comes from `pathCache`, which already holds `contentSha256` per
path, so this needs no extra reads. Scope each package's rows by the paths its
wheel produced; the extractor already knows them, so return them from
`verifyAndExtract` rather than diffing the tree afterwards.

Record only when the install fully succeeded, so a partial install never becomes a
cached manifest.

### Phase 4: success criteria

- A successful install writes exactly one manifest row per package with a file
  count matching the extractor's reported count.
- A failed install writes none.
- The recorded path set for a package contains only that package's files, proven by
  installing two packages and checking neither manifest includes the other's paths.

## Phase 5: consult the manifest on install

### Phase 5: changes required

Between resolution and download, look up each resolved `(name, version)`. For a
hit, verify every referenced blob still exists in one query, then `bulkGraft` the
file list and skip download and extraction for that package. On any miss, fall
through to the existing path.

Keep the fallback silent in normal operation and log the hit or miss at debug
level so the behavior is observable.

Grafting must go through the same upgrade path as a normal install: if the
sandbox's record shows a different version of the package, remove that version's
files first, then graft. A graft over an existing identical version is a no-op and
should be skipped rather than re-inserted.

### Phase 5: success criteria

- The end-to-end test from "Verification" passes.
- A test that deletes one referenced blob proves fallback works and succeeds.
- Grafting 0.18.0 into a sandbox already holding 0.17.0 produces the same tree as a
  fresh 0.18.0 install, asserted by comparing path sets and per-path
  `content_sha256`.
- Existing pip unit tests pass unchanged, since a cold tenant has no manifests.

## Phase 6: bring pip and databricks under the python semaphore

Independent of reuse, and small enough to land here.

Widen `PYTHON_INVOCATION_REGEX` (`session-manager.ts:211`) to match `pip`, `pip3`
and `databricks` as standalone words, so both take a `MAX_CONCURRENT_PYTHON` slot.
Note in the comment that this is a heuristic over script text and that the real fix
is throttling where just-bash spawns the worker.

### Phase 6: success criteria

- A unit test proves `pip install x` and `databricks ...` acquire a python slot.
- The existing false-positive guard still holds, so `mypython` and similar do not
  match.

## Phase 7: reduce unnecessary install refusals

### Phase 7: overview

Independent of everything above, and landable on its own. Each item removes a
refusal that has nothing to do with the WASM runtime's real constraints.

### Phase 7: changes required

- Make the download limit real and legible. Pass `maxResponseSize` in the
  `network` config at `session-manager.ts:612` so `secureFetch` and `PIP_LIMITS`
  agree, and translate `ResponseTooLargeError` into a `PipError` naming the package
  and the limit. Decide the number deliberately: the wheel body is buffered whole
  in host memory, written through SqlFs as a blob, and parked in the session's
  50 MB `contentCache`, so raising it trades directly against per-session memory.
  32 MB is a reasonable starting point; going much beyond that wants the host-side
  unzip work first, since that removes the temp-file round trip entirely.
- Stop aborting on unknown marker variables. In `evaluateMarker`, treat an
  identifier missing from `MARKER_VALUES` as an unsatisfied marker so the
  dependency is skipped, rather than calling `fail()`. Log it once so genuinely
  needed variables surface. Keep `fail()` for malformed markers, which are a
  different problem.
- Avoid the full release index. Fetch `/pypi/{name}/{version}/json` where the
  version is already known, and only fall back to the full index for resolution.
  Raise `maxMetadataBytes` as a backstop rather than the primary fix.
- Support extras. `parseRequirement` currently fails on `foo[bar]`. Resolve the
  extra's `Requires-Dist` entries whose markers include `extra == "bar"`, which
  `evaluateMarker` can already evaluate once `extra` is bound per requirement
  rather than pinned to the empty string.
- Revisit `maxExtractedBytes` and `maxWheelFiles` once Phase 3 removes stale files,
  since the cumulative budget stops silently filling with dead versions. Any
  increase has to be weighed against `estimatePathCacheBytes` and the session
  eviction budget in `session-manager.ts`, which are expressed in different units
  and will disagree.

### Phase 7: success criteria

- A wheel larger than the limit produces a message naming the package and the
  limit, not `package installation failed`.
- A package whose dependency carries an unmodeled marker variable installs, with
  that dependency skipped.
- `pip install pkg[extra]` resolves the extra's pure-Python dependencies.
- A regression test covers each of the four, using fixture wheels rather than the
  network.

## Phase 8: allow write methods through the sandbox HTTP transport

### Phase 8: overview

Read-only was not the intent. Remove the method restriction so an agent can edit
files in the sandbox and push them back to a workspace, which is the point of
having the CLI there at all.

### Phase 8: changes required

- Drop the GET/HEAD guard from `_sqlfs_request` in `PYTHON_PACKAGE_BOOTSTRAP` and
  pass `method` through to `jb_http.request`, forwarding `data` as the body.
- Drop the same guard from `Session.request` in
  `REQUESTS_COMPAT_FILES["requests/__init__.py"]`, and add `post`, `put`, `patch`
  and `delete` helpers beside the existing `get` and `head` so code that calls them
  directly works.
- Keep rejecting `files=`, but replace the message with one that names the real
  reason: the bridge carries a JSON string body, so multipart and binary payloads
  are unsupported. Point at base64-in-JSON as the workaround.
- Rewrite the "Network behavior" section of `SECURITY.md`, which currently asserts
  read-only as a property. State what is actually enforced: `network: true` is the
  capability gate, all methods route through `secureFetch`, and bodies are text.
- Note that the two shims duplicate this policy today, which is why the change has
  to land in both. The reuse review already flagged that duplication; collapsing
  them to one implementation would make this a one-line change next time.

### Phase 8: success criteria

- A sandbox script can POST JSON to a test endpoint and read the response.
- `databricks workspace import` against a real workspace succeeds, given
  credentials.
- A multipart attempt fails with a message that explains the encoding limit rather
  than implying a policy.
- `SECURITY.md` no longer claims a read-only transport.

## Phase 9: docs and changeset

- Correct the `deleteSandbox` doc comment at `src/sql-fs/types.ts:179-182`, which
  wrongly lists `blobs` among the rows it deletes.
- Document the manifest table and the new GC root in `SECURITY.md` and the GC
  section of `DEVELOPER.md`.
- Fix or delete `drizzle.config.ts:4`'s reference to the missing `schema.ts`, and
  correct CLAUDE.md's file layout.
- Add a changeset.

## Testing strategy

Unit tests with a mocked dialect cover manifest recording, the hit and miss
branches, and `bulkGraft`'s cache updates. Integration tests behind
`describe.skipIf(!process.env.DATABASE_URL)` cover the GC root clause, a real
graft, and the two-sandbox end-to-end case. Keep each test file under 300 lines
per CLAUDE.md, splitting by concern.

## Performance considerations

A repeat install should drop from an estimated 25 to 35 HTTPS round-trips, about
ten CPython worker boots, and 600 to 1000 Postgres round-trips, down to one
manifest lookup, one blob-existence check, and one bulk insert. The file counts
here are estimates from typical wheel contents; there is no fixture in the repo, so
the first implementation should log actual counts for `databricks-cli` and this
document should be updated with the measured numbers.

Manifest rows are small. A 500-file package is roughly 50 KB of JSONB.

## Risks and open questions

- Raising the download limit raises per-session peak memory in three places at
  once: the buffered response, the blob insert, and `contentCache`. The numbers
  should move together with the session budget, not alone.
- Supporting extras widens the dependency graph, so `maxDependencies: 64` may start
  binding on packages that resolve fine today. Worth checking before shipping.
- Skipping a dependency on an unknown marker variable is a guess. It is the right
  default, since the alternative refuses the install outright, but it can produce a
  sandbox missing a package something imports at runtime. The log line matters.

- The GC root clause has to be right. If the `NOT EXISTS` against
  `package_manifests` is wrong or the index is missing, either the cache rots into
  dangling hashes or GC slows to a crawl on large tenants. This deserves its own
  integration test with `minAgeMs: 0`.
- Grafting bypasses the extractor's safety checks, which is fine only because the
  manifest was produced by an install that already passed them. Manifest rows must
  never be writable from anywhere but a successful install.
- Mode bits and symlinks: wheels are rejected if they contain symlinks
  (`EXTRACT_CODE` fails on `S_IFLNK`), so a manifest holds regular files and
  directories only. Worth asserting in the recorder rather than assuming.
- `requests` gets a compat package written on top of the real one
  (`writeRequestsCompat`). A graft of `requests` must reproduce that step, or the
  compat files should be recorded into the manifest as part of the install.
- Open question: should a manifest be keyed by more than `(name, version)`? Wheel
  selection depends on the marker environment, which is currently hardcoded to one
  CPython WASM target (`MARKER_VALUES` in `pip-command.ts`). If that ever varies,
  the key needs a platform component.

## References

- Cleanup that preceded this work: commit `37f6070`, "Clean up experimental
  sandbox pip support".
- Original feature: commit `c6d2085`, "Add experimental sandbox pip support".
- `thoughts/shared/plans/2026-06-08_21-59-31_orphan-blob-gc.md` for the grace
  window and re-adoption race design.
- `thoughts/shared/research/2026-06-08_21-12-01_orphan-blob-lifecycle.md`.
- `thoughts/shared/plans/2026-05-02_reduce-postgres-round-trips.md` for the
  composite CTE pattern `bulkGraft` should follow.

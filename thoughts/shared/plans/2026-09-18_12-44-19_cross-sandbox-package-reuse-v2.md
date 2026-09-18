---
date: 2026-09-18T12:44:19+09:30
researcher: Harry.Nguyen@insightfactory.ai
git_commit: 37f6070da5c32f3e8105db9da24af009ea81081b
branch: experiment/pip-install-databricks-cli
repository: virtualFS
task: "Sandbox package install: review of the v1 reuse plan, gaps found, revised design for memory and reuse"
tags: [implementation-plan, pip, packages, blobs, cas, dedup, postgres, gc, wasm, memory, concurrency, review]
status: superseded
superseded_by: 2026-09-18_14-10-00_cross-sandbox-package-reuse-v3.md
supersedes: 2026-09-18_11-49-20_cross-sandbox-package-reuse.md
last_updated: 2026-09-18
last_updated_by: Harry.Nguyen@insightfactory.ai
---

# Sandbox package install v2: reuse, memory, and the stuck states

This is a review of the v1 plan (`2026-09-18_11-49-20_cross-sandbox-package-reuse.md`)
against the installed code, followed by a revised design. The v1 research is
largely correct and is not repeated here; this document records what it got
wrong or missed, why those points change the design, and the plan that results.
Every claim below was verified against commit `37f6070` and `just-bash@3.0.1`
(`node_modules/just-bash/dist`). The unminified worker source at
`dist/bundle/chunks/worker.js` was the primary evidence for the bridge behaviour.

## Summary of what changed

Four findings invalidate parts of v1:

1. **The real wheel ceiling is 8 MB, not 16 MB or 10 MB.** The CPython worker
   reaches the sandbox filesystem through a SharedArrayBuffer whose data region is
   exactly 8 388 608 bytes. Any single file read or write through it throws
   `Data too large` / `Result too large`. The extractor opens the wheel with
   `zipfile.ZipFile(path)`, which the HOSTFS layer serves by reading the whole file
   into the buffer, so a wheel above 8 MB downloads, is written to `/tmp`, and then
   fails in extraction with "wheel extraction failed" and no reason. Raising
   `maxResponseSize` (v1 Phase 7) does nothing for this. Any *extracted* file above
   8 MB fails the same way.
2. **Each extracted file costs two full writes, not one.** HOSTFS `mknod` writes an
   empty file, then `close` writes the full content. Each write is
   `commitBlob` + `writeFileComposite`, so four Postgres round trips, two content
   cache insertions and up to two Redis SETs per file, plus a `stat` per path
   component and a `mkdir` per directory. v1's estimate of 600 to 1000 round
   trips is closer to 1200 to 2000 for a 300 to 500 file closure. On a pooled
   remote Postgres at 20 ms that is 25 to 40 s of the 60 s Python timeout that
   applies when `fetch` is configured. Large wheels can time out on slow links.
3. **Installs pollute the per-session caches.** Every extracted file and the wheel
   itself are inserted into the 50 MB content LRU on write (`sql-fs.ts:912`), so a
   48 MB install evicts the user's entire working set, and each file is SET into
   Redis. v1 did not account for this.
4. **Nothing bounds concurrent installs.** `pip` and `databricks` bypass
   `MAX_CONCURRENT_PYTHON` because the gate is a regex over the script text
   (`/\bpython3?\b/`, `session-manager.ts:211`). just-bash has no process-wide cap
   either, only a per-filesystem queue, and passes no `resourceLimits` to the
   worker. Fifty sandboxes running `pip install databricks-cli` at once means
   fifty CPython workers and fifty full downloads. v1 Phase 6 fixes the gating
   but not the duplicate work, and would hold a Python slot for the whole
   install even though the worker only runs during extraction.

The consequence is that v1's "not doing host-side unzip" is the wrong call.
Host-side unzip is not orthogonal to reuse; it is the change that removes the 8 MB
ceiling, the double write, the temp-file round trip, the cache pollution, the
worker boot, and the timeout coupling, and it produces the per-file hashes the
manifest needs as a by-product. It becomes the first-install path in this plan.

## Findings in detail

### F1: three download limits that disagree, and the lowest one is hidden

| Layer | Limit | Where |
|---|---|---|
| `PIP_LIMITS.maxDownloadBytes` | 16 MB | `pip-command.ts:16` |
| `secureFetch` default `maxResponseSize` | 10 MB | just-bash `network/types.d.ts:93`, no override passed at `session-manager.ts:612` |
| SAB bridge `DATA_BUFFER` | 8 MB | just-bash `chunk-5H5SCKJM.js`, `DATA_BUFFER:8388608` |

`SecureFetchOptions` has no per-call size override (`network/fetch.d.ts:10-16`),
so the only knob is the `NetworkConfig` given to `Bash`, which is shared with
`curl`.

The bridge failure does not even surface as a size error. When the host's
`setResult` throws `Result too large`, the error is returned to the worker,
and HOSTFS `open` converts any read failure into `ENOENT` unless the file is
being created for write (`worker.js` 3.0.1 lines 2352-2357). That is why the
live run below saw `[Errno 44] No such file or directory: '/host/tmp/.sqlfs-pip/
babel-2.18.0-py3-none-any.whl'` for a 10.2 MB wheel while an 8.04 MB wheel
worked. The file existed; the read of it was too large for the buffer. A wheel between 8 and 10 MB fails in extraction; between 10 and 16 MB it
fails in `fetchPypi` with `ResponseTooLargeError`, which is not a `PipError`, so
the user sees `pip: package installation failed`. Both are permanent for that
package. The same 8 MB region also bounds `jb_http` responses, which are base64
encoded into it, so the `databricks` CLI cannot receive a response body above
roughly 6 MB. That last point is a just-bash limitation and is noted, not fixed.

### F2: how a file actually reaches Postgres from the extractor

From `worker.js` HOSTFS (`createHOSTFS`, lines ~2151-2400):

- `open(path, "wb")` → `lookupPath` → `stat` per uncached component → `mknod` →
  `backend.writeFile(path, new Uint8Array(0))` (line 2292).
- each `.write(chunk)` → buffered in worker memory, zero host calls.
- `close()` → one `backend.writeFile(path, fullContent)` (line 2366).
- `os.makedirs` → `stat` + `mkdir` per level.

Each `writeFile` is `commitBlob` (own connection, ships full payload even on
conflict) plus the `writeFileComposite` CTE, then `#contentCache.set` and a Redis
SET for blobs ≤ 8 MB. The empty-file write hits the hot empty blob every time,
which is exactly the F6 contention case the decoupled `commitBlob` was built to
mitigate. There is no blob-existence check anywhere in the codebase; every write
path relies on `ON CONFLICT` after the bytes have been transmitted.

### F3: the permanently stuck states

These are the states where a sandbox can never install something again, or a
package can never be installed at all, without operator intervention:

| State | Cause | v1 status |
|---|---|---|
| Wheel > 8 MB | bridge buffer | not identified |
| Wheel 8 to 16 MB | fetch limit mismatch, opaque error | Phase 7, but the fix would not work because of the 8 MB ceiling |
| Any extracted file > 8 MB | bridge buffer | not identified |
| Cumulative `/site-packages` over 48 MB or 10 000 files | `existingPackageTotals` is checked before every install and there is no uninstall | Phase 7 "revisit" only |
| Partial extraction after a timeout or a mid-install failure | files written before the failure stay and count against the budget forever | not identified |
| Dependency mentions an unmodelled marker variable | `evaluateMarker` calls `fail()` | Phase 7 |
| Package needs an extra | `parseRequirement` refuses `pkg[extra]` | Phase 7 |

The cumulative budget is the most damaging. `botocore` alone unpacks to roughly
90 MB, so `pip install boto3` fails every time, and if the failure happens after
some files were written, that sandbox is bricked for `pip` from then on.

On partial state: SqlFs writes inside an exec join the script transaction, which
commits at the end of the exec regardless of the command's exit code. A `pip`
that returns exit 1 after extracting three of ten wheels leaves those three
committed. SECURITY.md's statement that "a failed install must not publish a
partial package set" is a requirement, not a description of current behaviour.
Phase 2 below makes it true by staging.

### F4: concurrency and memory under many simultaneous installs

- Gate bypass: `execWithRuntimeThrottle` tests `PYTHON_INVOCATION_REGEX` on the
  script (`session-manager.ts:1626`). `pip install x` and `databricks ...` do not
  match, yet both call `ctx.exec("python", ...)` (`pip-command.ts:794`, `:960`).
- just-bash: one fresh `worker_threads.Worker` per invocation, terminated after,
  no `resourceLimits`, queue keyed by `WeakMap<fs>` so distinct sandboxes run in
  parallel with no cap (`python3-*.js`, `function N(r)`).
- Per install in host memory at peak today: the fetch body (secureFetch holds
  chunk array plus assembled array, so two copies during assembly), the content
  cache entry for the wheel, the `postgres` driver's outgoing wire buffer, and the
  worker's copy of the wheel in WASM linear memory. Roughly 4 × wheel size plus an
  80 MB CPython instance. Ten sandboxes installing a 10 MB wheel concurrently is
  on the order of 1.2 GB transient.
- No singleflight: N sandboxes first-installing the same wheel do N downloads and
  N extractions and then N idempotent manifest upserts.
- There is no cross-session memory cap and no cap on the number of warm sessions.
  The only memory guard is the per-session `pathCacheMaxBytes` (50 MB) reaper
  eviction, which is a soft flag checked once per minute.

### F5: manifest design issues in v1

- Keying by `(name, version)` is weaker than keying by the wheel's SHA-256, which
  the resolver already has before download, is immutable by construction, and
  removes the open question about a platform component.
- A JSONB `files` column plus an expression index makes the GC anti-join awkward
  and slow. A normalised child table indexed by blob hash makes it an index probe
  and also makes "are all this manifest's blobs still present" a single anti-join.
- Manifests pin blobs forever. Without a manifest TTL the CAS grows monotonically
  with every version anyone has ever installed.
- Recording hashes from `pathCache` after extraction attributes the wrong hash
  when two packages in one install write the same path (namespace `__init__.py`
  files, `py.typed`, licences). The hash must come from the wheel entry.
- A stale manifest (blob missing despite the GC root, for example after
  `--min-age-ms 0` misuse) should be deleted on fallback, not merely bypassed.
- Grafting must re-run the `requests` compat overlay and must re-validate paths
  even though the recording install already validated them.

### F6: smaller items

- `existingPackageTotals` issues one `lstat` promise per path under
  `/site-packages`, up to 10 000, on every install. The installed record in
  Phase 3 makes it unnecessary.
- `getDatabricksEntrypoint` walks the whole path cache and reads every
  `entry_points.txt` on every `databricks` invocation. v1 Phase 3 already fixes
  this.
- `contentCacheMaxBytes` is never passed by `SessionManager`; the 50 MB default is
  the only value. `pathCacheMaxBytes` and the extracted-bytes budget are unrelated
  units; a sandbox whose path cache crosses 50 MB is evicted by every reaper tick
  and cold-starts on each exec. Package file counts feed directly into this.
- `deleteSandbox`'s doc comment (`types.ts:179-183`) wrongly lists blobs.
- `drizzle.config.ts` references a `schema.ts` that does not exist.
- `pip-command.test.ts` has no coverage for size-limit messaging, dependency
  limits, direct-install markers, metadata size, concurrent installs, upgrades, or
  any `SessionManager` gating; it builds a raw `Bash` so the semaphore path is
  never exercised.

## Empirical validation, live run on 2026-09-18

A separate session installed `databricks-cli` from live PyPI and ran it against
a real workspace with a `.databrickscfg`. The findings below either confirm the
analysis above or add bugs it did not find. Measured numbers replace estimates
where they exist.

### Confirmed

- `pip install databricks-cli`: exit 0 in 4.0 s, 22 HTTP requests, 4.24 MB
  transferred, 11 packages, depth ≤ 2, every wheel `py3-none-any`. Largest wheel
  160 KB. Largest index JSON `charset-normalizer` at 2.23 MB against the 4 MB
  `maxMetadataBytes`, the tightest real margin.
- `MARKER_VALUES` matches the runtime exactly (3.13.2, CPython, emscripten,
  Emscripten, posix, wasm32).
- The install survives a session restart and re-running is idempotent.
- Wheel size ladder on fresh sandboxes: 8 044 600 B (`pycountry`) installs,
  10 196 845 B (`babel`) fails after a successful download with the `ENOENT`
  described in F1. `botocore` at 15.8 MB fails with the generic
  `package installation failed` under default caps, and with the same `ENOENT`
  when `maxResponseSize` is raised to 20 MB. Both halves of F1 reproduced.
- The GET/HEAD restriction is client-side only. `jb_http.request("POST", ...)`
  from sandbox Python succeeds because production runs
  `dangerouslyAllowFullInternetAccess`. It is a guardrail against accidental
  writes, not containment, which matches the v1 Phase 8 argument.

### New bugs found

- **The `python3` override breaks script execution for every Python sandbox.**
  `pythonPackageCommands` is registered whenever `python: true`, not only
  when pip is used. `python3 /hello.py` and `python3 rel.py` fail with
  `FileNotFoundError`; only `python3 /host/hello.py` works, and
  `echo ... | python3 -` fails with `OSError: [Errno 29]`. `runpyProgram`
  passes the raw path into `runpy.run_path` inside the worker, where the
  sandbox is mounted at `/host`, and `runpy` reads the file through
  `io.open_code`, which the generated path shim does not patch. The stdin form
  reads `sys.stdin`, which the 3.0.1 `WorkerInput` does not carry. This is a
  regression for all Python sandboxes and is the highest-value fix in this
  document.
- **`pip install pandas` reports the wrong reason.** Every one of pandas' 64
  newest releases is native-only, so `maxCandidateVersions` trips before the
  "no pure wheel" message at the end of `selectPackage`. The user is told
  "too many candidate versions" when the truth is "no pure-Python wheel".
- **The real `requests` wheel is dead weight.** The compat shim is inserted at
  `sys.path[0]` after `SITE_PACKAGES`, so it always shadows the installed
  `requests 2.34.2`. The install still downloads `requests`, `urllib3`,
  `charset-normalizer`, `idna` and `certifi`, five of the eleven packages and
  the single largest index fetch, for code that is never imported.
- **`.databrickscfg` is only found under `/host`.** The CLI's default lookup
  resolves to the worker's own `/home/user`, not the sandbox, so a config file
  needs `DATABRICKS_CONFIG_FILE=/host/<path>`. This is a documentation point,
  not a fix: per-request `env` with `DATABRICKS_HOST` and `DATABRICKS_TOKEN`
  is the supported route and is preferable, since it keeps the token out of
  the sandbox filesystem and under output redaction.
- **`auth_type = databricks-cli` profiles fail.** That is the new Go CLI's
  OAuth flow. The legacy Python CLI needs `host` plus `token`. Real user
  configs written by the new CLI will not work as-is.
- **`databricks-sdk` cannot install.** `google-auth` requires `cryptography`
  unconditionally below Python 3.14, and `cryptography` is a C extension. This
  is the fundamental WASM limit, not a tunable one.
- **Extras abort transitively.** `pip install 'requests[socks]'` fails before
  the first HTTP request, and any `Requires-Dist` carrying an extra does too.

### Additional issues from a second source pass

Found while validating the live run against `pip-command.ts`; none were in
the live report or the v1 plan.

- **`python` and `python3` behave differently.** Only `python3` is overridden
  (`pythonPackageCommands` at the bottom of the file). `python -c "import
  databricks_cli"` fails because the built-in gets no bootstrap, while
  `python3 -c` works. Register the override for both names or for neither.
- **`--version`, `-V` and `--help` anywhere in argv bypass the override**, so
  `python3 script.py --version`, where the flag is meant for the script, runs
  the built-in without the bootstrap and with the untranslated path. Check only
  argv before the first non-option argument.
- **Option parsing is positional and fragile.** `packagePythonArgs` uses
  `indexOf("-c")` and `indexOf("-m")` over the whole argv, so a script argument
  literally equal to `-c` is misparsed, and interpreter options that take a
  value (`-W ignore`, `-X dev`) make the value look like the script path.
  Parse interpreter options properly up to the first positional.
- **Tokens from `.databrickscfg` are not redacted.** `redactDatabricksResult`
  only knows secrets present in `ctx.env`. A token read by the CLI from the
  config file is echoed verbatim if the CLI includes it in an error. Read the
  config file's `token` values on the host and add them to the redaction set.
  A very short secret would also over-redact; require a minimum length.
- **The resolver is greedy and never retracts constraints.** When a later
  constraint forces a name to a different version, `resolved` is overwritten
  but the dependencies added by the previous version stay in `constraints`, so
  packages the final version does not need are still installed, and a
  conflicting pair can loop until the work limit. Acceptable for the
  experiment; document it, and make the work-limit message say "could not
  resolve" rather than implying a size problem.
- **`Requires-Python` is ignored.** A `py3-none-any` wheel whose metadata
  says `Requires-Python: <3.13` is installed anyway and fails at import.
  PyPI's JSON carries `requires_python`; check it against 3.13.
- **All-prerelease projects are unresolvable.** Prereleases are excluded
  unless the spec names one, with no fallback when nothing else exists; pip
  falls back. Minor.
- **PEP 508 markers with the variable on the right** (`"3.8" < python_version`)
  hit `fail()` as "unsupported dependency marker". Rare but valid.
- **Budget check runs after the network.** `existingPackageTotals` is called
  after `resolvePlan`, so a sandbox already over budget still pays the full
  PyPI round trips before being refused. Check first. Moot once Phase 3
  replaces the walk with record arithmetic, but the ordering should still be
  budget, then network.
- **The `ssl` and `jwt` stubs shadow the stdlib and PyJWT for every import.**
  Intentional, and the comments say why, but the failure mode changes from
  `ModuleNotFoundError` to `AttributeError` for any package that reaches past
  the stubbed names. Worth a sentence in SECURITY.md so the next person does
  not chase it.
- **Wheel `.data/scripts` and `.data/data` trees are extracted verbatim** under
  `/site-packages/<pkg>.data/`, not relocated. Harmless for imports; console
  scripts other than `databricks` are not runnable, which matches the current
  design of a single hard-wired entrypoint.

### What an agent can do today

Install `databricks-cli` from PyPI; list workspace, clusters, DBFS, jobs and
Unity Catalog metadata; pull results into the sandbox and process them with
stdlib Python; persist across restarts; `python3 -c` and `python3 /host/x.py`.

It cannot write anything back to Databricks, use `databricks-sdk`, use
pandas or numpy or pyarrow, install anything with extras or a wheel over 8 MB,
run `python3 script.py` with a natural path, or pipe into `python3 -`.

## Design principles for v2

1. **Bytes that already exist in the tenant are never transmitted again.** Check
   blob existence by hash before shipping payloads, on first installs as well as
   grafts.
2. **The host never holds a whole extracted package in memory.** Inflate entry by
   entry from the wheel buffer into bounded batches and drop each batch after its
   INSERT.
3. **No CPython worker for `pip install`.** Extraction moves to the host.
   `databricks` still needs one and takes a Python slot at spawn.
4. **A failed install leaves nothing behind.** Stage under a temporary directory
   and rename into place, or roll back the script transaction.
5. **Every limit is expressed in one place, agrees with the layer below it, and
   produces a message that names the package and the number.**
6. **A sandbox can always recover.** `pip uninstall` exists, budgets are per
   install plus a soft per-sandbox quota, never a cumulative hard wall.

## Revised install pipeline

```
pip install A B
  │
  ├─ resolve (PyPI JSON, per-version endpoint when pinned)   [Phase 0]
  │
  ├─ for each resolved wheel (sha256 known from PyPI metadata):
  │     ├─ acquire singleflight lease  vfs:{tenant}:pip:{sha256}   [Phase 5]
  │     ├─ manifest lookup by sha256                                [Phase 4]
  │     │     hit  → verify blobs present (one anti-join) → bulkGraft
  │     │     miss → acquire MAX_CONCURRENT_PIP_INSTALLS slot       [Phase 0]
  │     │            download via pip-scoped secureFetch (PyPI-only allowlist,
  │     │              its own maxResponseSize)                     [Phase 0]
  │     │            verify sha256 in host
  │     │            host-side unzip, streaming, bounded inflate    [Phase 1]
  │     │            SELECT existing hashes; INSERT only missing blobs,
  │     │              ≤ 8 MB payload per statement                 [Phase 1]
  │     │            bulkIngest inodes/dirents under a staging dir  [Phase 1]
  │     │            record manifest rows                           [Phase 4]
  │     └─ release lease
  │
  ├─ remove files of any previously installed version of A/B        [Phase 3]
  ├─ rename staging → /site-packages, write requests compat if needed
  └─ update /site-packages/.sqlfs-installed.json                     [Phase 3]
```

Second and later installs of the same wheel within a tenant do zero network
requests, zero worker boots, and ship zero payload bytes. First installs ship only
the bytes the tenant has never seen.

## Phase 0: unblockers that land independently

Each item here is small, has no dependency on the rest, and removes a stuck
state or an unbounded resource.

### Changes

- **Fix the `python3` override.** In `packagePythonArgs`, map script paths to
  the worker's view: an absolute path becomes `/host` + path, a relative path
  becomes `/host` + join(cwd, path), and `-` is handled on the host by reading
  `ctx.stdin` and passing the program as `-c` code after the bootstrap. Parse
  interpreter options up to the first positional instead of `indexOf`, and only
  treat `--version`/`-V`/`--help` as interpreter flags when they appear before
  it. Register the same override for `python` so both names behave identically.
  Add tests for all four forms (`-c`, `-m`, file, `-`), for a relative path
  from a non-root cwd, for `python3 script.py --version`, and for `python`
  versus `python3` parity. Consider registering the override only when
  `/site-packages` exists, so sandboxes that never used pip keep the built-in
  behaviour untouched.
- **Redaction stays env-based.** With env as the documented route, the
  redaction gap for config-file tokens is a documentation matter, not a fix.
  Do add a minimum secret length to `redactDatabricksResult` so a short value
  cannot over-redact output.
- **Check `Requires-Python`.** Skip releases whose `requires_python` excludes
  3.13 during `selectPackage`, so the "no supported wheel" message is accurate
  instead of a later import failure.
- **Surface the real error.** In `install`'s catch, translate
  `ResponseTooLargeError` to a `PipError` naming the package and the limit, and
  include `error.message` for any other non-`PipError` instead of the fixed
  "package installation failed".
- **Report "no pure wheel" before the candidate counter trips.** In
  `selectPackage`, if the counter is about to exceed `maxCandidateVersions` and
  no inspected release had a pure wheel, emit the "no supported pure-Python
  wheel" message. Cheap and removes the pandas confusion.
- **Stop downloading the shadowed `requests` closure.** Treat `requests` as
  satisfied by the compat shim: when it appears in the resolved set, skip its
  wheel and do not follow its `Requires-Dist`. Five packages, the largest index
  fetch and roughly a third of the transferred bytes disappear from the
  databricks-cli install. Keep `writeRequestsCompat` as the thing that
  satisfies the requirement.
- **Document per-request env as the credential route.** `DATABRICKS_HOST` and
  `DATABRICKS_TOKEN` in the exec request's `env` work today, are scoped to one
  exec, never touch the sandbox filesystem, and are covered by output
  redaction. A `.databrickscfg` written into the sandbox is the wrong tool: it
  persists the token as a shared blob and a Redis entry, survives export, and
  is not redacted. Do not add a `DATABRICKS_CONFIG_FILE` default. Mention in
  the docs that if someone insists on a config file it must be addressed as
  `/host<path>` and use `host` plus `token`, not `auth_type = databricks-cli`.
- **Pip-scoped fetch.** In `SessionManager`, when `python && network`, build a
  second `createSecureFetch({ allowedUrlPrefixes: [pypi.org, files.pythonhosted.org],
  maxResponseSize: PIP_MAX_WHEEL_BYTES, maxRedirects: 5 })` and pass it into a
  factory `createPythonPackageCommands({ fetch, ... })`. `pip` stops using
  `ctx.fetch`. `curl` keeps its 10 MB default. The PyPI allow-list becomes enforced
  at the fetch layer, not only by `isPypiUrl`. Default `PIP_MAX_WHEEL_BYTES`
  32 MB, env-configurable.
- **Translate `ResponseTooLargeError`** into a `PipError` naming the package,
  the size, and the limit. Match on `error.name === "ResponseTooLargeError"`.
- **Install concurrency cap.** A process-wide `Semaphore` (reuse the existing
  implementation from `session-manager.ts:353-370` by exporting it) with
  `MAX_CONCURRENT_PIP_INSTALLS`, default 2, acquired around download plus
  extraction of one wheel. This bounds transient install memory to roughly
  `2 × 2 × PIP_MAX_WHEEL_BYTES` plus one inflate batch each. Excess installs
  queue FIFO with the same abort and timeout semantics as the Python queue.
- **Python slot for `databricks`.** Widen `PYTHON_INVOCATION_REGEX` to
  `/\b(python3?|databricks)\b/`. Do not add `pip`: after Phase 1 it spawns no
  worker, and before Phase 1 holding a slot for the network portion of an install
  starves real Python users. Comment that this is a heuristic over script text.
- **Unknown marker variable → unsatisfied, not fatal.** In `evaluateMarker`, when
  `MARKER_VALUES[identifier]` is undefined, return `false` and log once per
  install. Keep `fail()` for malformed syntax.
- **Extras.** Bind `extra` per requirement instead of the fixed empty string, parse
  `pkg[a,b]`, and include `Requires-Dist` entries whose marker is satisfied under
  each requested extra.
- **Per-version metadata first.** When the requirement pins `==`, fetch
  `/pypi/{name}/{version}/json` directly and skip the full release index.
  Raise `maxMetadataBytes` to 16 MB as a backstop.

### Success criteria

- `python3 /hello.py`, `python3 rel.py` from a subdirectory, `python3 -m mod`
  and `echo code | python3 -` all run in a Python sandbox with the override
  registered, asserted against the built-in `python` output.
- `pip install pandas` fails with the "no supported pure-Python wheel" message.
- `pip install databricks-cli` makes no request for `requests`, `urllib3`,
  `charset-normalizer`, `idna` or `certifi`, and `databricks workspace ls`
  still works.
- `databricks workspace ls` with `DATABRICKS_HOST` and `DATABRICKS_TOKEN` in
  the exec `env` succeeds and the token does not appear in stdout or stderr.
- A 12 MB wheel installs; a wheel above `PIP_MAX_WHEEL_BYTES` fails with a message
  containing the package name and both numbers.
- `curl` against a 12 MB URL still fails at 10 MB.
- Three sandboxes running `pip install` concurrently with
  `MAX_CONCURRENT_PIP_INSTALLS=1` serialise; a unit test asserts the third waits.
- `databricks x` acquires a Python slot; `mypython` and `pip install x` do not.
- A dependency with `platform_release` in its marker is skipped, not fatal.
- `pip install pkg[extra]` resolves the extra's pure-Python dependencies.

## Phase 1: host-side unzip and existence-aware bulk ingest

### Why this is the core change

Everything in F1, F2, and F3 that is not a policy choice traces to extraction
running inside the WASM worker and reaching the filesystem through the 8 MB
bridge. Moving extraction to the host with Node's `zlib` removes:

- the 8 MB ceiling on wheels and on individual files,
- one CPython boot (~80 MB, ~1 s) per wheel,
- the wheel round trip through SqlFs (blob, inode, content cache, Redis, GC orphan),
- two writes and several stats per extracted file,
- the coupling to the 60 s Python timeout,
- the per-file content cache and Redis pollution,

and gives the manifest recorder the per-entry SHA-256 for free.

`zlib.inflateRawSync(buf, { maxOutputLength })` is available on every supported
Node (`engines.node >= 22`) and throws `ERR_BUFFER_TOO_LARGE` when the declared
size is a lie, which is the zip-bomb guard. ZIP central-directory parsing for
wheels (stored or deflate, no encryption, no multi-disk, ZIP64 for the size
fields only) is on the order of 150 lines and needs no dependency.

### Changes

- **`src/api/commands/wheel-reader.ts`.** Parse the end-of-central-directory
  record, walk the central directory, and expose an iterator of
  `{ path, mode, size, compressedSize, method, read(): Uint8Array }`. Port every
  check from `EXTRACT_CODE` (unsafe path, traversal, symlink, duplicate, length
  cap) and add: reject encryption flags, reject methods other than 0 and 8, reject
  entries whose declared uncompressed size exceeds `PIP_MAX_FILE_BYTES` (32 MB)
  before inflating, and inflate with `maxOutputLength` equal to the declared size.
  Verify the CRC-32 from the central directory against the inflated bytes.
- **Streaming ingest in batches.** Iterate entries, hash each inflated payload,
  accumulate `{ path, sha256, mode, size, content }` until the batch reaches
  8 MB of payload or 500 entries, then flush. The wheel buffer stays resident;
  inflated bytes do not outlive their batch.
- **`SqlDialect.filterMissingBlobs(hashes)`.** One `SELECT sha256 FROM blobs WHERE
  sha256 = ANY($1)` on the pool connection; return the set that is missing. Also
  `UPDATE blobs SET last_referenced_at = now() WHERE sha256 = ANY($1)` for the
  present ones so the grace window protects them the way an insert would.
- **`bulkIngest` gains an option `{ presentBlobs?: Set<hex>, cacheContent?: boolean }`.**
  Phase C skips payloads in `presentBlobs`. `cacheContent: false` skips the
  content-cache insert in `SqlFs.bulkIngest` (`sql-fs.ts:826-836`) so installed
  files do not evict the session's working set; the read path fills lazily and
  `getBlobsForSandbox` prewarm still covers small files. Redis backfill happens
  only for blobs actually inserted.
- **Staging.** Extract under `/site-packages/.staging-<random>/`, and only after
  every wheel of the install succeeds, remove old-version files (Phase 3) and
  `mv` each top-level entry into `/site-packages`. `mv` on SqlFs is a dirent
  update, not a copy. On any failure, `rm -r` the staging directory. This makes
  SECURITY.md's "no partial publish" claim true without depending on script
  transaction rollback.
- **Delete `EXTRACT_CODE` and `runWasmPython`.** `pip install` no longer calls
  `ctx.exec`.
- **Revised limits**, all in one `PIP_LIMITS` block sourced from env with defaults:

  | Limit | v1 | v2 default | Reason |
  |---|---|---|---|
  | wheel bytes | 16 MB (really 8) | 32 MB | bounded by install semaphore, not by bridge |
  | total download per install | 64 MB | 256 MB | per install, transient |
  | single extracted file | none (really 8 MB) | 32 MB | `maxOutputLength` |
  | extracted bytes per install | 48 MB cumulative | 512 MB per install | never resident at once |
  | files per install | 10 000 cumulative | 50 000 per install | path cache ≈ 150 B each → 7.5 MB |
  | per-sandbox site-packages quota | none (the cumulative wall) | 1 GB soft, from the installed record | recoverable via `pip uninstall` |

  The quota check reads totals from the Phase 3 record, so `existingPackageTotals`
  and its 10 000 `lstat` calls go away. Keep the quota well under what
  `pathCacheMaxBytes` can hold: at ~150 B per entry, 50 MB is about 350 000 paths.

### Memory accounting after Phase 1

Per in-flight install: wheel buffer (up to 32 MB, plus a second transient copy
inside secureFetch during assembly), one inflate batch (≤ 8 MB), the `postgres`
driver's wire buffer for that batch (≤ 8 MB), hash state. No worker. With
`MAX_CONCURRENT_PIP_INSTALLS=2`, worst case is about 160 MB transient per
replica, against roughly 1.2 GB for ten concurrent installs today.

### Success criteria

- Fixture wheels at 9 MB and 20 MB install; a fixture with a 40 MB entry fails
  naming the file and the limit; a fixture whose entry declares 1 KB but inflates
  to 1 MB fails with a "corrupt or hostile archive" message.
- A first install of a two-wheel fixture where the second wheel shares 30 % of its
  files with the first ships only the unique blobs, asserted by counting rows
  passed to the blob INSERT in a mocked dialect.
- Content cache size is unchanged after an install (`cacheContent: false`).
- Killing the install after wheel one of two leaves no entries under
  `/site-packages` other than pre-existing ones.
- Postgres round trips for a 400-file wheel are under 30, asserted with a
  counting dialect mock.
- `pip install` does not call `ctx.exec`; a spy asserts zero calls.

## Phase 2: dialect graft capability

Unchanged from v1 Phase 2 except:

- `GraftFile` carries `sha256: Uint8Array` and the graft SQL takes it from the
  caller; the same `presentBlobs` touch of `last_referenced_at` runs first.
- `bulkGraft` re-validates every path with the same rules as the wheel reader.
- `bulkGraft` never inserts into the content cache.
- Mock updates: `bulkGraft: vi.fn()`, `filterMissingBlobs: vi.fn()` in the six
  test files that stub `bulkIngest`.

## Phase 3: per-sandbox installed record, uninstall, and upgrade

v1 Phase 3 plus:

- **`pip uninstall NAME`** removes exactly the record's file list for that package
  and deletes the entry. Empty directories left behind are removed. This is the
  recovery path for any sandbox that hits the quota.
- **`pip list` and `pip freeze`** read the record. Cheap and expected by agents.
- **Totals in the record** (`files`, `bytes` per package) so the quota check is
  arithmetic on the record, not a filesystem walk.
- **Self-heal for pre-record sandboxes.** If `/site-packages` has content but no
  record, treat as empty; the next install of a package that overwrites paths
  simply overwrites them, and the quota check uses record totals only. Document
  that legacy files are invisible to the quota until reinstalled.
- The record is written after the staging rename, in the same exec, so a failed
  install never updates it.

## Phase 4: manifest table and GC root

### Schema (migration 0007, Postgres only)

```sql
CREATE TABLE IF NOT EXISTS package_manifests (
    wheel_sha256   BYTEA PRIMARY KEY,
    name           TEXT NOT NULL,
    version        TEXT NOT NULL,
    file_count     INTEGER NOT NULL,
    total_bytes    BIGINT NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_package_manifests_name_version ON package_manifests(name, version);
CREATE INDEX IF NOT EXISTS idx_package_manifests_last_used_at ON package_manifests(last_used_at);

CREATE TABLE IF NOT EXISTS package_manifest_files (
    wheel_sha256   BYTEA NOT NULL REFERENCES package_manifests(wheel_sha256) ON DELETE CASCADE,
    path           TEXT NOT NULL,
    blob_sha256    BYTEA NOT NULL,
    mode           INTEGER NOT NULL,
    size           BIGINT NOT NULL,
    PRIMARY KEY (wheel_sha256, path)
);
CREATE INDEX IF NOT EXISTS idx_package_manifest_files_blob ON package_manifest_files(blob_sha256);
```

No RLS, no `sandbox_id`, matching `blobs`, with a comment saying why. A 500-file
manifest is 500 small rows; the index on `blob_sha256` is what makes the GC clause
an index probe.

### GC changes (`gcOrphanBlobs`, `postgres.ts:754-767`)

Run inside the same repeatable-read transaction, in this order:

1. `DELETE FROM package_manifests WHERE last_used_at < now() - $manifestTtl`
   (`PIP_MANIFEST_TTL_MS`, default 30 days; cascade removes the file rows).
2. The existing anti-join with one added clause:
   `AND NOT EXISTS (SELECT 1 FROM package_manifest_files f WHERE f.blob_sha256 = b.sha256)`.

A manifest used within the TTL keeps its blobs alive; an unused one expires and
its blobs become ordinary orphans on the next pass. This bounds CAS growth without
any operator action.

### Recording

After all wheels of an install succeed, one multi-row INSERT per wheel into
`package_manifest_files` from the wheel reader's per-entry hashes, and an upsert
into `package_manifests` with `ON CONFLICT (wheel_sha256) DO UPDATE SET
last_used_at = now()`. The `requests` compat overlay is not part of any manifest;
it is applied by the installer on both paths.

### Success criteria

- A blob referenced only by a manifest survives `gcOrphanBlobs` with `minAgeMs: 0`.
- Setting `PIP_MANIFEST_TTL_MS` to 0 makes the manifest and then the blob collectible.
- A genuinely unreferenced blob is still collected.
- Two packages installed together produce two manifests with disjoint path sets,
  including when both contain `py.typed` files with identical content.

## Phase 5: consult the manifest, with singleflight

### Changes

- After resolution, for each wheel: `SELECT ... FROM package_manifests WHERE
  wheel_sha256 = $1`. On hit, one anti-join checks every referenced blob exists;
  if all present, `bulkGraft` under the staging directory and bump
  `last_used_at`. If any missing, `DELETE` the manifest and fall through.
- **Singleflight per wheel.** Before the download path, acquire
  `vfs:{tenant}:pip:{wheel_sha256}` with `SET NX PX 120000` and the same jittered
  wait loop as `withDistributedLock`. On acquire, re-check the manifest (the
  previous holder may have just recorded it). Without Redis, an in-process
  `Map<string, Promise>` gives the same behaviour per replica. This turns "fifty
  sandboxes install databricks-cli at 09:00" into one download, one extraction,
  and forty-nine grafts.
- Log `pip_manifest_hit` / `pip_manifest_miss` / `pip_singleflight_wait` as
  structured events with wheel, file count, and bytes, so the numbers in
  "Performance" below can be replaced with measured ones.

### Success criteria

- End-to-end: install in sandbox A, then B; B's exec makes zero fetch calls and the
  path sets and per-path `content_sha256` in A and B are identical.
- Delete one referenced blob by hand; B falls back, succeeds, and the stale
  manifest row is gone.
- Two sandboxes started concurrently on a cold tenant: exactly one download,
  asserted with a counting fetch mock; both end up with identical trees.
- Graft of 0.18.0 into a sandbox holding 0.17.0 equals a fresh 0.18.0 install.

## Phase 6: write methods through the transport

v1 Phase 8 unchanged, with one addition: collapse the two shims so the method
policy lives in one place. Note the base64 response ceiling (~6 MB through
`jb_http`) in SECURITY.md as a known runtime limit.

## Phase 7: docs, mocks, and changeset

- `deleteSandbox` doc comment, `drizzle.config.ts`, CLAUDE.md file layout and env
  table (`PIP_MAX_WHEEL_BYTES`, `MAX_CONCURRENT_PIP_INSTALLS`,
  `PIP_MANIFEST_TTL_MS`, quota variables).
- SECURITY.md: replace the package limits section with the v2 table, state that
  extraction is host-side with bounded inflate and CRC verification, and rewrite
  "Network behavior".
- DEVELOPER.md GC section: manifests as a GC root and the TTL.
- Changeset: minor.

## What we are still not doing

- Native or platform wheels, source distributions, indexes other than PyPI.
  This rules out `databricks-sdk` (needs `cryptography`), pandas, numpy and
  pyarrow. The only route is a prebuilt WASM wheel source such as Pyodide's,
  which is a separate project.
- The new Databricks CLI's OAuth profiles (`auth_type = databricks-cli`). The
  legacy Python CLI supports `host` plus `token` only.
- Cross-tenant sharing.
- A wheel or PyPI metadata cache. Manifests make it redundant for repeats;
  singleflight removes the duplicate downloads on cold starts.
- Changing just-bash. The 8 MB bridge and the base64 response encoding are
  upstream; this plan routes around the first and documents the second.

## Testing strategy

Unit, mocked dialect, no DB: wheel reader (fixtures built with `node:zlib` in the
test, including hostile ones), batch flushing and existence filtering, staging
and cleanup, record and uninstall, manifest hit and miss, singleflight with a
fake lock, the install semaphore, and the regex gate. Integration behind
`describe.skipIf(!process.env.DATABASE_URL)`: GC root and TTL, real graft,
two-sandbox end-to-end, concurrent cold-tenant install. Split by concern, each
file under 300 lines.

## Performance expectations, to be replaced with measurements

| Path | Network | Worker boots | Postgres round trips | Payload bytes shipped |
|---|---|---|---|---|
| today, `databricks-cli`, 11 wheels (measured) | 22 requests, 4.24 MB, 4.0 s | 11 | est. 1200 to 2000 | 100 % |
| v2 first install, `requests` closure skipped | ~12 requests, ~2.8 MB | 0 | ~30 to 60 (batches × 5) | only hashes the tenant has never stored |
| v2 repeat install | 0 | 0 | ~4 per wheel | 0 |

Network and worker numbers for the first row are measured; the round-trip
column is still an estimate and should be replaced with a count from a
counting dialect mock once Phase 1 lands.

## Risks

- Host-side ZIP parsing handles untrusted input. The reader must reject anything
  outside the wheel subset (methods 0 and 8, no encryption, no data descriptors
  needed since sizes come from the central directory), bound inflate output, and
  verify CRC. Fuzz the reader with a few hundred mutated fixtures in a unit test.
- `maxOutputLength` bounds a single entry; the batch cap bounds the aggregate.
  Both must be enforced; a wheel with 50 000 entries of 30 MB declared each must
  fail at the total-bytes check before inflating.
- Singleflight lease of 120 s must exceed the slowest realistic first install.
  A holder that dies leaves waiters polling until expiry; they then race for the
  lease and the winner installs. Acceptable.
- `MAX_CONCURRENT_PIP_INSTALLS=2` may be low for a large replica; it is an env
  knob and the log events make it tunable from data.
- Legacy sandboxes with files but no record are invisible to the quota until
  reinstalled. Documented; self-heals on next install.
- The regex gate for `databricks` remains a heuristic. The real fix is a hook at
  the worker spawn point in just-bash; track upstream.

## References

- v1 plan: `thoughts/shared/plans/2026-09-18_11-49-20_cross-sandbox-package-reuse.md`.
- Bridge evidence: `node_modules/just-bash/dist/bundle/chunks/worker.js`
  (`createHOSTFS`, `mknod` at 2285-2296, `open` at 2340-2365, `close` at 2366),
  `dist/bundle/chunks/chunk-5H5SCKJM.js` (`DATA_BUFFER:8388608`),
  `dist/bundle/chunks/python3-*.js` (`new Worker`, `WeakMap` queue, `H=1e4,I=6e4`).
- Write path: `src/sql-fs/sql-fs.ts:848-914`, `src/sql-fs/dialects/postgres.ts:160-216`,
  `:614-634`, `:846-1124`, `:754-767`.
- Gate: `src/api/session-manager.ts:211`, `:1625-1711`.
- Orphan GC design: `thoughts/shared/plans/2026-06-08_21-59-31_orphan-blob-gc.md`.

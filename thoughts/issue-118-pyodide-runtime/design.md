# Design Discussion — Pyodide Python runtime (issue #118)

> **Revision (review pass).** This version resolves an 8-point design review. Decisions: the Deno boundary
> is an **explicit single-layer** boundary (Deno/V8 escape is out of the threat model); the **IPC transport
> is committed** (stdin/stdout + realm-lockdown, fixed frame-integrity invariants); **OOM isolation is not
> guaranteed** (accepted availability risk); the DB migration is **rolling-deploy-safe**. Corrections folded
> in: Deno module-loading flags, timeout-must-throw, first-class manager ownership, atomic LRU admission.

## Current State

A sandbox's Python capability is a single boolean toggling just-bash's built-in **CPython-emscripten**
`python3` (plain CPython in WASM — *no* JS↔Python bridge; only host contact is the `ctx.fs` SharedArrayBuffer
bridge + stdout/stderr, so it is genuinely air-gapped). The flag travels a fixed chain:

- **Validate** — inline Zod `python: z.boolean().optional()`, defaulted `?? false` (`routes/sandboxes.ts:15-23,50-52`).
- **Types** — `SandboxMeta`/`SandboxListEntry` carry `readonly python/javascript/network: boolean`
  (`sql-fs/types.ts:61-82`); `RuntimeOptions` + `DEFAULT_RUNTIME_OPTIONS` (`session-manager.ts:110-122`).
- **Persist** — `updateSandboxMeta` `UPDATE sandboxes SET … python,javascript,network` (`dialects/postgres.ts:345-362`);
  read via `getSandboxMeta` (`:316-343`).
- **Rehydrate** — cold start reads meta, threads `resolvedRuntime` into `new Bash({ python: … })`
  (`session-manager.ts:930-959,487-497`), stored on `Session.runtimeOptions` (`:522`).
- **Respond** — create 201 echoes all three (`sandboxes.ts:134`); list maps all three (`:142-159`);
  **single GET omits them** (`:179-196`) — a known asymmetry.

`new Bash({ python: true })` registers the built-in `python3`, which spawns a `worker_threads` worker; output
files persist to SqlFs *only because* its SharedArrayBuffer bridge calls `ctx.fs` per op (`research.md` Q6).
A prior audit (**C1**) rejected a host-process `py-exec` for sandbox-escape risk; Python is WASM-only
(`session-manager.ts:475-477`). The existing `nodeCommand` (`commands/node-command.ts:48`) is the template:
`defineCommand`, registered only when `javascript` is on, delegating via `ctx.exec`; custom commands **shadow
built-ins** (`Bash.d.ts:111`); `python` is a *separate* registry entry from `python3` (no alias mechanism).

Concurrency: `pythonSem`/`jsSem` (`session-manager.ts:313-314,357-374`), limits default 5, routed by regex
gated on the session flag (`:143-146,1235-1237`). Timeout/cancel is enforced **in routes** via
`AbortController`→`bash.exec` (`exec.ts:154-202,219-229`); a command sees only `ctx.signal`. The readOnly exec
path holds the per-session RWLock in **shared** mode → **concurrent readers** (`session-manager.ts:640-647`).
Sessions evict on idle (`SESSION_IDLE_MS`, default 600 000 ms); cleanup today only disconnects `session.fs`
(`session-manager.ts:1038,1088`). Migrations: **only `migrations/postgres/` exists**, **no tracking table** —
*every* `.sql` re-runs on *every* boot under `pg_advisory_lock`, so **every migration MUST be idempotent**
(`migrations.ts:40-65`). The `python` field is duplicated across both SDKs, MCP, OpenAPI, docs (`research.md` Q5).

## Desired End State

`python_runtime: "stdlib" | "pyodide" | null` replaces boolean `python`.

- `"stdlib"` → `new Bash({ python: true })` (built-in CPython-emscripten, unchanged, air-gapped).
- `"pyodide"` → register **two** custom commands (`python3` + `python`, one shared handler) running
  numpy/pandas/scipy/openpyxl **fully offline inside an OS-isolated Deno subprocess** (Decision 1).
  `python: undefined` so the custom commands are the only Python.
- `null` → no Python.

**Verify:** create a `pyodide` sandbox; upload a CSV; `python3 analyze.py` runs `import pandas`, writes
`out.xlsx`, and the file is **retrievable via the files API** (the issue's core requirement). `python_runtime`
round-trips create/list/**get**, both SDKs, MCP, OpenAPI; `pnpm typecheck && lint && test:unit` green; the
migration integration test asserts the column.

**Threat model (explicit — finding 1).** The boundary is **single-layer**: a zero-permission Deno subprocess
spawned with a **scrubbed env**. A successful escape *out of Deno itself* (a Deno/V8 0-day) is **out of the
threat model** — it would expose the host under the same uid. Compensating controls keep that escape low-value:
**no secrets in the child** (`env:{}` — `AUTH_SECRET`/`DATABASE_URL` are simply absent) and `--allow-read`
scoped to read-only Pyodide assets only. We **recommend** (do not require) operators add a gVisor/seccomp layer.
**Security acceptance is first-class:** an adversarial suite proves `import js; js.process.env`, `js.fetch(...)`,
`pyodide.code.run_js(...)`, `ctypes.CDLL(None)`, `import('node:child_process')` **fail closed** (no secret read,
no network, no host-FS reach) **and** that escaped JS **cannot forge, interleave, or replay an IPC control
frame** — proving capability denial, not merely a thrown error.

## Patterns to Follow

- **Custom command shape** — `defineCommand` + `ExecResult {stdout,stderr,exitCode}`; parse `-c CODE` /
  script-path / stdin / `--version`; resolve args with `ctx.fs.resolvePath(ctx.cwd, arg)`; match the built-in
  `python3` arg surface (`research.md` Q2). Register `python3` + `python` as two commands, one handler.
- **Bash construction** — extend the existing `new Bash({…})` block (`session-manager.ts:487-497`); no parallel
  path. Store resolved runtime on `Session` (`:522`).
- **First-class manager ownership (required — finding 7)** — `CommandContext` exposes no `Session` handle, but
  the manager must **not** live only inside a command closure (it has to participate in the global residency
  LRU and complete teardown). Add a first-class field `Session.pyodideSandbox?: PyodideSandbox` (or a generic
  session-resource disposer); the command handler reaches it via the session captured at `getOrCreate` time.
  Teardown MUST run on **every** path: session destroy, **reaper eviction**, **shutdown**, partial
  `getOrCreate` failure, runtime timeout, IPC corruption, LRU eviction, unexpected child exit — extend the
  `session.fs`-only cleanup at `session-manager.ts:1038,1088`.
- **Per-subprocess serialization (required)** — readOnly execs run concurrently (`session-manager.ts:640`), so
  the manager serializes execs to its single subprocess via a mutex/queue; a queued waiter is removed on
  `ctx.signal` abort.
- **Cancellation = throw, never return (required — finding 6)** — `bash.exec` cancel is cooperative and the
  route's `AbortController` is invisible to the command (only `ctx.signal` is). The handler observes
  `ctx.signal` + its own timer and **kills the subprocess** (`child.kill('SIGKILL')`), then:
  - **route abort** → **reject with `AbortError`**, aborting the script transaction (route returns **408**);
  - **internal runtime timeout** → **throw a typed timeout error**;
  - **never drain files** from a timed-out / protocol-invalid run; **never reuse that subprocess generation**.
  Returning a normal `{exitCode}` is forbidden — it would let `bash.exec` resolve, the route return 200, and the
  script transaction **commit** a partial/garbage drain. Throwing triggers SqlFs `abortScriptScope` rollback
  (`research.md` Q6).
- **Migration** — numbered, **fully idempotent** SQL in `migrations/postgres/` (re-runs every boot), reflected
  in `types.ts`/`postgres.ts`; integration test asserts the column.

**Do NOT follow / avoid:**
- No in-process / `worker_threads` Pyodide. Pyodide-on-Node is **not** a security boundary: `import js`→
  `globalThis` exposes `process.env`/`fetch`; `pyodide.code.run_js`, `ctypes`, `_pyodide._base.eval_code`,
  `__subclasses__` survive `jsglobals`/`unregisterJsModule` hardening (live RCEs: n8n CVE-2025-68668 9.9, Grist
  CVE-2026-24002 9.0). worker_threads can scrub `env:{}` but cannot block network or `import('node:fs')`.
- Do **not** reintroduce host-*capability* Python (audit C1) — the Deno child has no net/run/write/env/ffi/sys
  permissions and read-only access only to vendored assets.
- Do **not** rely on NODEFS to bridge SqlFs; do **not** use `micropip`/PyPI at runtime — pre-stage offline.
- Do **not** trust subprocess output — untrusted code controls it. Enforce the frame invariants (Decision 1) and
  **validate every drain path stays under cwd** (reject `..`, absolute, null-byte) before applying to SqlFs.
- Do **not** repeat the single-GET omission — fix GET to echo `python_runtime`.

## Design Decisions

1. **Isolation = explicit single-layer Deno subprocess (headline; findings 1, 2, 3).** The per-session
   `PyodideSandbox` spawns a **Deno subprocess** with a **scrubbed env** (`env:{}` plus `DENO_NO_UPDATE_CHECK=1`).
   Flags (spike-validated against the pinned Deno version, S1): `--no-prompt` + the deny belt `--deny-net
   --deny-run --deny-write --deny-env --deny-ffi --deny-sys --deny-import`, **plus the module-loading air-gap
   flags `--no-remote --no-npm --cached-only --no-config`** (finding 2 — `--deny-net` alone does not gate the
   module graph; remote registries load by default), with `--allow-read` scoped to the vendored asset dir only.
   Note `--deny-import` blocks *remote* imports only — **local** dynamic imports under `--allow-read` remain
   possible, contained because the read scope is read-only Pyodide assets. Deno gates the *JS layer itself*, so a
   full Python→JS escape lands capability-less.
   - **IPC is committed, not an alternative (finding 3).** Transport = **Node↔Deno over the child's stdin/stdout**,
     with **realm-lockdown**: at startup the harness captures the writer, then deletes `Deno`/`console`/other
     write primitives from `globalThis` **before** any untrusted Python runs. Every frame (both directions) is
     **length-prefixed JSON** carrying **mandatory integrity fields**: random **requestId**, monotonic
     **sequence number**, exact **message type**, **child-generation id**; with **max per-frame and aggregate
     size caps** and **exactly one response per request**. The Node side **kills the child immediately** on any
     malformed, oversized, duplicate, out-of-sequence, wrong-generation, or unexpected frame. Defense-in-depth:
     Node independently re-enforces cwd path-validation, RLS, and size caps, so even a forged frame cannot
     escalate beyond what the sandboxed code could already write to its own cwd. Spike S2 **confirms feasibility**
     of this committed design (it does not choose between transports).
2. **Capability field — full external break, rolling-safe expand/contract migration (findings 5).** Add
   `python_runtime TEXT` (`CHECK IN ('stdlib','pyodide')`, nullable). **Migration N (this release):**
   `ADD COLUMN IF NOT EXISTS`; idempotent backfill **only `WHERE python_runtime IS NULL`** (so repeated boot
   re-runs never clobber `pyodide`), guarded by a `DO` block checking `pg_attribute` for `python`
   (`python=true → 'stdlib'`). **Mixed-version safety:** new **reads** use
   `COALESCE(python_runtime, CASE WHEN python THEN 'stdlib' END)` so an old replica's `python=true`/NULL row is
   read correctly; new **writes dual-write** `python` (`stdlib → true`, `pyodide → false`, `null → false`) so old
   replicas keep working. **Migration N+1 (later release):** `DROP COLUMN IF EXISTS python` and remove the
   COALESCE/dual-write. API/SDKs/MCP/OpenAPI/docs accept/return only `python_runtime`; legacy `python: bool`
   rejected. `javascript`/`network` unchanged. Fix single-GET to echo capabilities (`sandboxes.ts:179-196`).
3. **Execution model — per-session warm Deno subprocess, serialized (Q1 + findings 2,3).** One subprocess per
   sandbox session, spawned lazily on first `pyodide` exec, reused across that session's execs (amortizes the
   multi-second cold start for the iterative LibreChat loop), serialized by the per-subprocess mutex. Between
   execs: fresh Python `globals` + wipe staged MEMFS paths (bounds variable scope + staged files only;
   `sys.modules`/package globals persist within a session — same trust boundary). Cross-session isolation comes
   from per-session subprocesses. Timeout/abort kills the subprocess; next exec re-inits (new generation).
4. **Residency LRU — explicit state machine + atomic admission (findings 7, 8).** A **global registry** caps
   resident subprocesses at `MAX_RESIDENT_PYODIDE` (small default, e.g. 2), independent of `SESSION_IDLE_MS`
   (else warm subprocesses accumulate per active session); a shorter `PYODIDE_IDLE_MS` idle-kills them. Each
   worker has an explicit state: `cold → starting → idle → busy → terminating → dead`. **`starting` and `busy`
   are never evictable.** A **registry mutex** makes admission atomic — it covers *reserve a slot → select an
   eviction victim → spawn → roll back on failed init* as one critical section, so concurrent cold starts cannot
   both observe a free slot and exceed the cap. **Capacity is reserved before** expensive Pyodide init.
5. **Concurrency + memory — dedicated semaphore; OOM isolation NOT guaranteed (Q4 + finding 4).** New
   `MAX_CONCURRENT_PYODIDE` (low default, **2**) + queue/wait-timeout env vars mirroring the python set; routed by
   `python_runtime==="pyodide"` so `stdlib` keeps `MAX_CONCURRENT_PYTHON=5`. The semaphore caps *in-flight execs*,
   not RAM; Decision 4 caps residency. **Invariant `MAX_RESIDENT_PYODIDE >= MAX_CONCURRENT_PYODIDE`** (a busy
   proc cannot be evicted). **OOM is an accepted availability risk, not an isolation guarantee:** a container
   memory limit covers Node + *all* Deno children together, so a runaway child may OOM-kill Node or the whole
   container. `prlimit --as` is **unsuitable** (V8 reserves huge virtual address space); on `node:22-slim` as
   non-root `app`, per-process cgroup v2 `memory.max` is **best-effort** (likely no cgroup-write access). The
   **operator-set container memory limit is the real guard** — operators size `MAX_RESIDENT × per-proc ceiling`
   (`MAX_RESIDENT=1` on small hosts). The Pyodide ~2 GB WASM cap is only a per-instance heap ceiling. The manager
   reports an error + respawns (new generation) on child exit.
6. **File staging — cwd subtree + script over IPC, diff-and-drain with explicit semantics (Q2 + finding 5/6).**
   Before run: ship the cwd subtree **plus the resolved script path** (even if outside cwd, for `python3 FILE`
   parity) to Deno, written into MEMFS. After a **successful** run only: Deno reports the created/modified/deleted
   set; Node applies it to `ctx.fs` **inside the existing script transaction** (atomic rollback on failure,
   `research.md` Q6). **Never drain from a timed-out / aborted / protocol-invalid run** (finding 6). **Semantics:**
   reject **symlinks** (SqlFs default-deny); files written 0644 default (`sql-fs.ts:738`), exec-bit via `chmod`
   only if needed; dirs-before-files, delete depth-first; hardlinks drained as independent copies; **cwd-scoped
   only** (keep script + inputs under cwd). Per-file + total byte caps on both directions.
7. **Offline packaging — Deno + full distribution + lockfile tooling (finding 6 prior).** Pin pyodide to stable
   **0.29.x** (not the `314.0.0-alpha` `next` tag). The build/Docker step bakes the **Deno binary**, the full
   `pyodide-0.29.x` distribution (numpy/pandas/scipy wheels + `pyodide-lock.json`), and a **custom lock**
   incorporating openpyxl + `et_xmlfile` + transitive deps via tooling (`micropip.freeze`) — **not** hand-edited.
   `loadPyodide({ indexURL, lockFileURL, packageBaseUrl })` from local paths. Preload {numpy,pandas,scipy,openpyxl}
   at subprocess init.

## Required Tests (acceptance contract)

Each test names the decision it protects; `/4-structure` distributes these into per-phase checkpoints.

- **Migration (D2):** an old-replica-style `python=true` write is read back as `stdlib` (COALESCE); re-running
  the migration **after** the N+1 `python`-drop is idempotent (no error, no clobber).
- **Residency / LRU (D4):** concurrent admissions never exceed `MAX_RESIDENT_PYODIDE` (atomic-admission mutex);
  LRU **never evicts a `busy` or `starting` worker**.
- **Cancellation (Patterns + D6, finding 6):** abort while **waiting on the subprocess mutex**; abort **during
  init / package preload**; abort **after the child response but before drain completion** — each kills the
  child, **retires that generation**, and **drains nothing**.
- **Teardown (Patterns, finding 7):** session **reaper, destroy, shutdown, and failed `getOrCreate`** each kill
  the child.
- **Drain / FS (D6):** a read-only exec's MEMFS mutation is rejected (`EREADONLY_VIOLATION`), never silently
  dropped; a script **resolved outside cwd cannot drain outside its cwd** (`..` / absolute / null-byte rejected).
- **IPC integrity (D1):** **malformed, oversized, duplicate, stale-generation, and forged** frames each kill the
  child; the size cap is measured on the **base64-encoded wire size** (accounts for ~33% expansion), not raw bytes.
- **Deny-belt (D1 + escape suite):** **remote import, npm import, update check, filesystem write, env read,
  subprocess spawn, FFI (`Deno.dlopen`), and network** are each denied (fail closed).

## What We're NOT Doing

- No in-process / `worker_threads` Pyodide (Decision 1). **No required gVisor/microVM** — Deno permissions + env
  scrub are the boundary; a Deno/V8 runtime escape is **out of the threat model**; gVisor/seccomp is a
  **recommended** operator add-on, not a hard requirement (finding 1).
- **No guaranteed per-child OOM isolation** — whole-service termination on a runaway child is an accepted
  documented risk; cgroup `memory.max` is best-effort only (finding 4).
- No mysql/azure-sql migrations (none exist; postgres-only). No `micropip`/PyPI or arbitrary packages at runtime.
  No NODEFS-backed Python; no network egress from Pyodide.
- No `python_runtime` mutation after create (capabilities immutable, `endpoints.md:148`). No broader
  `schema.ts`/Drizzle fix. No change to `javascript`/`network` or `node`.

## Required Spikes (pre-implementation merge gates)

Each must pass a POC before its dependent phase is built; fail any → revisit the architecture with the user.

1. **Pyodide-on-Deno feasibility (gates P3).** Under the **exact** committed flags (Decision 1) + scoped
   `--allow-read`, a Deno subprocess `loadPyodide` from the **local offline** `indexURL`, `loadPackage`
   numpy/pandas/scipy from disk, install the **frozen openpyxl+et_xmlfile** lock, run a pandas→openpyxl
   round-trip, and capture stdout/stderr — all with **zero network**.
2. **IPC integrity (gates P3/P4) — confirm the *committed* design, do not re-choose transport.** The
   stdin/stdout + realm-lockdown framing works under the deny flags with binary payloads, and after lockdown an
   adversarial `Deno.stdout.write`/`console.log`/raw-fd attempt **cannot forge, interleave, or replay** a control
   frame; verify generation-id rejection of a killed-generation message.
3. **Per-child memory behavior (gates P6).** Confirm `node:22-slim` non-root cannot reliably set cgroup
   `memory.max` (and that `prlimit --as` is unusable with V8); validate the container-limit guard + accepted
   availability risk (Decision 5) is the operating model.

## Open Risks

- **New runtime dependency: Deno** must be vendored and available on self-hosted installs — adds image size + a
  portability constraint. Pin the Deno version + the full flag set cleanly.
- **C1 reversal needs security sign-off** — reintroduces a Python-running *subprocess*, justified by Deno's
  zero-permission boundary + env scrub. The adversarial escape/forgery suite is the explicit gate; get
  maintainer/security review before merge, and have them confirm the **single-layer threat model** (Deno/V8
  escape out of scope) is acceptable for the deployment.
- **IPC integrity** — untrusted code shares the harness realm, so it can send hostile payloads *and* (via escaped
  JS on stdout) attempt to forge frames. The committed invariants (generation id, sequence, single-response,
  size caps, kill-on-anomaly) + realm-lockdown are the defense; both are spike- and adversarially-tested.
- **Memory under load** — worst case ≈ `MAX_RESIDENT_PYODIDE × ~2 GB` (WASM heap ceiling) + Node baseline + DB
  pools. **A runaway child can OOM the whole container** (accepted risk, Decision 5); operators must size the
  container against `MAX_RESIDENT × per-proc ceiling` (`MAX_RESIDENT=1` on small hosts). Multi-replica + restart
  mitigates the availability hit. Validate defaults + `PYODIDE_IDLE_MS` on the target host.
- **Cold-start UX** — first `pyodide` exec (or any after eviction) pays Deno spawn + Pyodide init + package load
  (several seconds); exec timeout defaults must account for it.
- **Intra-session state persistence** — warm subprocess preserves `sys.modules`/package globals across a session's
  execs (Decision 3); add a fresh-globals isolation test; fall back to kill-and-respawn per exec if per-exec
  purity is ever required.
- **Coordinated breaking release** — every `research.md` Q5 surface ships together; reconcile the second-class
  `network` field (absent from MCP/OpenAPI/SDK records) at the same time. The DB layer rolls safely (Decision 2),
  but the API/SDK break still requires clients to upgrade.

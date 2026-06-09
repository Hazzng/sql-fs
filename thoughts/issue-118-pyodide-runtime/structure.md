# Structure Outline

## Approach

Replace boolean `python` with `python_runtime: "stdlib" | "pyodide" | null` end-to-end (rolling-safe
expand/contract migration), then build the `pyodide` runtime as an **OS-isolated Deno subprocess** with zero
permissions, a **committed** stdin/stdout + realm-lockdown IPC with fixed frame-integrity invariants, cwd-scoped
file diff-and-drain, dedicated concurrency + atomic-admission residency caps, and a first-class adversarial
escape suite. Field slices (1–2) ship `stdlib`/`null` on their own; runtime slices (3–7) build the Deno boundary
bottom-up. Three POC **spikes gate** the runtime phases.

> **Coordinated-release note (design Open Risk).** The boolean→enum break and the `pyodide` runtime land in
> **one breaking release**. Phases are *implementation* slices on one branch, not separate releases. Between
> Phase 2 and Phase 5 a `pyodide` sandbox creates fine and `stdlib` works, but `python3` in a `pyodide` sandbox
> is "not yet registered" — an intermediate state that never reaches a cut release. The DB layer is
> rolling-safe (Phase 1); the API/SDK break still requires clients to upgrade.

---

## Phase 0: Spikes (merge gates — throwaway POCs, not shippable)

Three POCs from design §"Required Spikes". Each must pass before its dependent phase; fail any → revisit the
architecture with the user.

**Files**: `thoughts/issue-118-pyodide-runtime/spikes/` (scratch scripts + a short findings note per spike)
**Key checks**:
- **S1 — Pyodide-on-Deno offline** (gates P3): a Deno subprocess under the **committed flags** (`--no-prompt
  --deny-net --deny-run --deny-write --deny-env --deny-ffi --deny-sys --deny-import --no-remote --no-npm
  --cached-only --no-config`, `--allow-read=<assetdir>`, env `{DENO_NO_UPDATE_CHECK:1}`) can `loadPyodide` from a
  **local** `indexURL`, `loadPackage` numpy/pandas/scipy from disk, install the frozen openpyxl+et_xmlfile lock,
  run a pandas→openpyxl round-trip, capture stdout/stderr — **zero network**.
- **S2 — IPC integrity** (gates P3/P4): **confirm the committed design** (stdin/stdout + realm-lockdown), not
  choose a transport. Length-prefixed JSON framing works under the deny flags with binary payloads; after realm
  lockdown an adversarial `Deno.stdout.write`/`console.log`/raw-fd attempt **cannot forge, interleave, or replay**
  a control frame; a stale-generation message is rejected.
- **S3 — Per-child memory** (gates P6): confirm `node:22-slim` non-root **cannot** reliably set cgroup
  `memory.max` (and that `prlimit --as` is unusable with V8's vaddr reservation); confirm the container-limit
  guard + **accepted availability risk** (design D5) is the operating model.

**Verify**:
- Programmatic: each spike script exits 0 and prints its asserted result (round-trip bytes, rejected forged
  frame, memory-limit probe).
- Agent: review the three findings notes; confirm each gate's pass/fail is explicit before starting P3/P6.

---

## Phase 1: `python_runtime` field — server-side break, rolling-safe (stdlib + null end-to-end)

Replace boolean `python` with the nullable enum across DB, types, persistence, validation, runtime resolution,
and HTTP responses, **safely under a mixed-version rolling deploy**. `stdlib`→`new Bash({ python: true })`;
`null`→no Python; `pyodide` is a valid stored value but Python stays unregistered until P5.

**Files**: `src/sql-fs/migrations/postgres/0006_python_runtime.sql` (new), `src/sql-fs/types.ts`,
`src/sql-fs/dialects/postgres.ts`, `src/api/routes/sandboxes.ts`, `src/api/session-manager.ts`,
`src/api/tests/integration/migrations.integration.test.ts`
**Key changes**:
- Migration `0006`: idempotent `ADD COLUMN IF NOT EXISTS python_runtime TEXT` + `CHECK (python_runtime IN
  ('stdlib','pyodide'))`; backfill **only `WHERE python_runtime IS NULL`**, guarded by a `DO` block checking
  `pg_attribute` for `python` (`python=true → 'stdlib'`) so it survives the later `python`-drop release.
- `type PythonRuntime = "stdlib" | "pyodide" | null` — new; `SandboxMeta`/`SandboxListEntry` gain
  `readonly python_runtime: PythonRuntime` (`types.ts:61-82`).
- `RuntimeOptions { pythonRuntime: PythonRuntime; … }` + `DEFAULT_RUNTIME_OPTIONS` (`session-manager.ts:110-122`);
  `getOrCreate` maps `pythonRuntime==="stdlib"` → `python:true` in the `new Bash({…})` block (`:487-497`);
  `pyodide` → leave `python:undefined` (commands added P5).
- **Rolling-safe persistence** (design D2): `getSandboxMeta`/list **read**
  `COALESCE(python_runtime, CASE WHEN python THEN 'stdlib' END)`; `updateSandboxMeta` **dual-writes** `python`
  (`stdlib→true`, `pyodide/null→false`) alongside `python_runtime` (`postgres.ts:316-402`).
- `createBodySchema`: `python_runtime: z.enum(["stdlib","pyodide"]).nullable().optional()`; reject legacy
  `python: bool` (`sandboxes.ts:15-23`). Create-201, list, **and GET** echo `python_runtime` — **fix the GET
  omission** (`:134,142-159,179-196`).

**Verify**:
- Programmatic: `pnpm typecheck && pnpm lint:fix && pnpm test:unit`; integration test re-runs `0006` idempotently,
  asserts the column + CHECK exist, asserts an **old-replica-style `python=true` (python_runtime NULL) row reads
  back as `stdlib`** (COALESCE), and asserts re-running the migration **after a simulated `python`-drop** does not
  error (pg_attribute guard).
- Agent: create a `stdlib` and a `null` sandbox against the dev server; confirm create/list/GET all echo
  `python_runtime` and a `stdlib` sandbox runs `python3 -c "print(1)"`.

---

## Phase 2: `python_runtime` — client & contract surfaces (SDKs, MCP, OpenAPI, docs)

Propagate the enum to every external representation (research Q5) and reconcile the second-class `network` field.
One coordinated break across the consistency surface.

**Files**: `clients/python/src/sqlfs/models.py`+`client.py`, `clients/typescript/src/models.ts`+`client.ts`,
`src/api/mcp/tools.ts`, `src/api/openapi-spec.ts`, `plugins/sql-fs/skills/api/ref/endpoints.md` (+ `bash.md`,
`py-sdk/ref/*`), changeset.
**Key changes**:
- `SandboxRecord.python_runtime: PythonRuntime` + `CreateSandboxOptions.python_runtime?` in both SDKs; drop
  `python: bool`; add `network` to the response records (reconcile asymmetry).
- MCP `sandbox_create` input `python_runtime` enum; `sandbox_list`/handler echo it (`tools.ts:37-99`).
- OpenAPI `sandboxRecordSchema` + create-body `python_runtime` enum, `required` updated; add `network`
  (`openapi-spec.ts:23-26,321-322`). Version bump via changeset (no manual edits).
- Docs: replace `python` with `python_runtime` (values + immutability note `endpoints.md:148`).

**Verify**:
- Programmatic: `pnpm typecheck && pnpm lint:fix && pnpm test:unit`; SDK suites (py + ts), `mcp-tools.test.ts`
  pass with new assertions; OpenAPI spec validates.
- Agent: diff every Q5 surface against a checklist; confirm no remaining boolean `python` and that `network`
  now appears in both SDK records + OpenAPI.

---

## Phase 3: Offline assets + Deno harness (the untrusted side)

Vendor the runtime assets and write the Deno-side harness that loads Pyodide offline, runs untrusted Python,
locks down its realm, and speaks the committed IPC. Hardens S1/S2 into product. Standalone-testable without Node.

**Files**: `Dockerfile`, `vendor/deno/` + `vendor/pyodide/` (baked; gitignore/LFS decided in plan),
`scripts/build-pyodide-lock.mjs` (new — `micropip.freeze`), `src/pyodide-runner/runner.ts` (new, Deno entry),
`src/pyodide-runner/protocol.ts` (shared frame types).
**Key changes**:
- Pin pyodide **0.29.x**; build step bakes Deno binary + full distribution + **custom lock** (openpyxl +
  et_xmlfile + transitive) generated by tooling, **not** hand-edited.
- `runner.ts`: `loadPyodide({ indexURL, lockFileURL, packageBaseUrl })` from local paths; preload
  {numpy,pandas,scipy,openpyxl}; **realm lockdown** (capture the stdout writer, then delete `Deno`/`console`/other
  write primitives from `globalThis`) **before** any untrusted Python; IPC read→eval→respond loop; stdout/stderr
  via Pyodide stream callbacks into JSON fields; stage input files into MEMFS; report `{created,modified,deleted}`
  diff.
- `protocol.ts`: `RunRequest`/`RunResponse` frame schemas carrying `requestId` (random), `seq` (monotonic),
  `type`, `generation` (shared by P4).

**Verify**:
- Programmatic: build script produces the lock + asset tree; `deno run <committed-flags> --allow-read=<assets>
  runner.ts < fixture-frame` returns a valid response frame with pandas→openpyxl output bytes, **zero network**.
- Agent: re-run an S2 forge attempt against the built `runner.ts`; confirm the forged frame is not emitted on the
  control channel; confirm the deny-belt blocks remote/npm imports, update check, FS, env, subprocess, FFI, net.

---

## Phase 4: Node-side `PyodideSandbox` manager + IPC client

The trusted Node half: spawn/own the Deno subprocess, frame the protocol with full integrity checks, serialize
execs, enforce **throw-not-return** cancellation and respawn. No session wiring yet — unit-testable in isolation.

**Files**: `src/api/pyodide/manager.ts` (new), `src/api/pyodide/ipc.ts` (new),
`src/api/pyodide/tests/unit/*.test.ts` (new)
**Key changes**:
- `type WorkerState = "cold"|"starting"|"idle"|"busy"|"terminating"|"dead"`;
  `class PyodideSandbox { readonly state: WorkerState; readonly generation: number;
  run(req: RunRequest, signal: AbortSignal): Promise<RunResponse>; dispose(): Promise<void> }` — spawns
  `deno run <committed-flags> --allow-read=<assets>` with **scrubbed `env:{DENO_NO_UPDATE_CHECK:"1"}`**.
- `ipc.ts`: `encodeFrame(obj): Buffer` / `decodeFrames(chunk): Frame[]` (length-prefixed); **schema-validate +
  enforce integrity on every inbound frame** — match `requestId`, monotonic `seq`, exact `type`, current
  `generation`, **single response per request**; **per-frame + aggregate size caps measured on base64-encoded
  wire size**. Any malformed/oversized/duplicate/stale-generation/unexpected frame → **kill the child**.
- **Per-subprocess mutex/queue** serializes `run()` (readOnly execs are concurrent — design §Patterns); a queued
  waiter is removed on `signal` abort.
- **Cancellation = throw, never return**: `run()` observes `signal` + own timer → `child.kill("SIGKILL")` →
  **route abort rejects `AbortError`; internal timeout throws a typed timeout error**; **retire the generation**.
  Manager reports error + respawns (new `generation`) on unexpected child exit.

**Verify**:
- Programmatic: `pnpm typecheck && pnpm lint:fix`; new unit tests cover serialization order; **abort while
  waiting on the mutex**, **abort during init/preload** — each kills the child and rejects/throws (never returns
  a normal result); malformed/oversized/duplicate/stale-generation/forged frame each kill the child; **base64
  expansion counted against the size cap**; respawn-on-exit increments `generation`.
- Agent: exercise `manager.run()` with two overlapping calls; confirm they serialize and an aborted call kills
  the child within the timeout.

---

## Phase 5: `pyodide` custom commands + file staging drain (core requirement)

Wire `python_runtime: "pyodide"` to register `python3`+`python` custom commands backed by a per-session
`PyodideSandbox` owned as a **first-class `Session` field**, with cwd-scoped diff-and-drain into SqlFs.
**Delivers the issue's core requirement.**

**Files**: `src/api/commands/pyodide-command.ts` (new — `createPyodideCommands(session)` factory),
`src/api/session-manager.ts`, `src/api/tests/integration/pyodide.integration.test.ts` (new)
**Key changes**:
- `createPyodideCommands(session: Session): CustomCommand[]` — two commands, one shared handler; parse `-c CODE` /
  script FILE / stdin / `--version` matching the built-in `python3` surface; resolve paths via
  `ctx.fs.resolvePath(ctx.cwd, arg)`; return `ExecResult`.
- **First-class ownership** (design finding 7): add `Session.pyodideSandbox?: PyodideSandbox`. In `getOrCreate`
  (`:438-560`), when `pythonRuntime==="pyodide"` build/attach the manager on the session, push its commands into
  `customCommands`, keep `python:undefined`. **Teardown kills the child on every path** — session destroy,
  **reaper eviction, shutdown** (`:1038,1088`), and **failed `getOrCreate`** — extending the `session.fs`-only
  cleanup.
- **Staging**: ship cwd subtree + resolved script path to Deno; on a **successful** run, drain
  `{created,modified,deleted}` into `ctx.fs` **inside the script transaction** (atomic rollback). **Never drain on
  timeout/abort/protocol-invalid** (design finding 6). **Validate every drain path stays under cwd** (reject
  `..`/absolute/null-byte); reject symlinks; dirs-before-files, delete depth-first; exec-bit via `chmod`; per-file
  + total byte caps both directions.

**Verify**:
- Programmatic: `pnpm typecheck && pnpm lint:fix && pnpm test:unit`; integration test: create `pyodide` sandbox,
  write a CSV, `python3 analyze.py` does `import pandas` + writes `out.xlsx`, assert `out.xlsx` **retrievable via
  files API**; a drain path with `..`/absolute is rejected; a **read-only exec's MEMFS mutation is rejected
  (`EREADONLY_VIOLATION`)**; an **abort after the child responds but before drain completes drains nothing**;
  **reaper/destroy/shutdown/failed-create each kill the child**.
- Agent: run a `-c` one-liner and a script-file form in a `pyodide` sandbox on the dev server; confirm stdout,
  exit code, and written-file persistence.

---

## Phase 6: Concurrency semaphore + atomic-admission residency LRU + memory posture

Bound in-flight `pyodide` execs and resident subprocesses independently (both required per design §5), with
**atomic admission** over the worker state machine.

**Files**: `src/api/session-manager.ts`, `src/api/pyodide/residency.ts` (new),
`src/api/tests/unit/session-manager.test.ts` (extend), `src/api/pyodide/tests/unit/residency.test.ts` (new)
**Key changes**:
- New `pyodideSem` (`MAX_CONCURRENT_PYODIDE` default **2**) + `MAX_PYODIDE_QUEUE`/`PYODIDE_QUEUE_TIMEOUT_MS`
  mirroring the python set; route by `python_runtime==="pyodide"` in `execWithRuntimeThrottle` (`:1235-1307`) so
  `stdlib` keeps `MAX_CONCURRENT_PYTHON=5`.
- `class PyodideResidency` — global cap `MAX_RESIDENT_PYODIDE` (default **2**). An **atomic admission mutex**
  covers *reserve slot → select eviction victim → spawn → roll back on failed init* as one critical section.
  Eviction only targets `idle` workers; **`starting`/`busy` are never evictable**. `PYODIDE_IDLE_MS`
  (< `SESSION_IDLE_MS`) idle-kills subprocesses. **Invariant `MAX_RESIDENT_PYODIDE >= MAX_CONCURRENT_PYODIDE`**
  enforced at startup.
- **Memory posture (design D5, accepted availability risk):** best-effort cgroup `memory.max` per child only
  where supported (gated on S3); **container memory limit is the documented real guard** — no per-child OOM
  isolation guarantee.

**Verify**:
- Programmatic: `pnpm typecheck && pnpm lint:fix && pnpm test:unit`; new tests: N concurrent pyodide execs queue +
  `queue_full`/`wait_timeout`; **concurrent resident admissions never exceed the cap**; **LRU never evicts a
  `busy` or `starting` worker**; invariant violation fails startup; `stdlib` routing unaffected.
- Agent: drive >`MAX_RESIDENT` concurrent `pyodide` sessions; confirm an idle subprocess is killed and an evicted
  session cold-starts on next exec.

---

## Phase 7: Adversarial escape suite (first-class security acceptance — merge gate)

Prove the boundary holds. This suite is the security sign-off gate (design Open Risk: C1 reversal).

**Files**: `src/api/pyodide/tests/integration/escape.integration.test.ts` (new),
`src/api/pyodide/tests/integration/frame-forgery.integration.test.ts` (new)
**Key changes**:
- Escape cases each **fail closed**: `import js; js.process.env`, `js.fetch(...)`, `pyodide.code.run_js(...)`,
  `ctypes.CDLL(None)`, `import('node:child_process')` — none read secrets, reach network, or touch host FS.
- **Deny-belt coverage**: remote import, npm import, update check, filesystem write, env read, subprocess spawn,
  FFI (`Deno.dlopen`), network — each denied.
- **Frame-forgery**: escaped JS attempting `Deno.stdout.write`/`console.log`/raw-fd cannot forge a control frame,
  replay a stale-generation frame, nor redirect a drain write outside cwd.
- Fresh-globals isolation between a session's execs (design Open Risk: intra-session state).

**Verify**:
- Programmatic: escape + deny-belt + forgery + isolation suites pass (every escape blocked); full
  `pnpm test:integration` green with both containers up.
- Agent: review each escape's assertion proves *capability denial* (no secret/net/FS), not just a thrown error;
  confirm S3 memory behavior is exercised or documented.

---

## Testing Checkpoints

- **After P0**: three spike gates explicitly pass (or architecture revisited with user).
- **After P1**: `python_runtime` column + CHECK exist; `stdlib`/`null` work end-to-end via HTTP; GET fixed;
  old-replica `python=true` reads as `stdlib`; migration re-runs idempotently after a simulated `python`-drop.
- **After P2**: every Q5 surface uses `python_runtime`; no boolean `python` remains; `network` reconciled.
- **After P3**: `runner.ts` loads Pyodide offline under the committed flags, round-trips pandas→openpyxl, blocks
  the deny-belt; a forged frame is rejected.
- **After P4**: manager serializes execs; aborts (waiting / init / preload) throw-not-return and kill the child;
  malformed/oversized/duplicate/stale-generation/forged frames kill the child (base64-aware cap); respawn bumps
  generation — unit-proven.
- **After P5**: CSV→`python3 analyze.py`→`out.xlsx` retrievable via files API; drain path-validation holds;
  read-only mutation rejected; abort-before-drain drains nothing; all teardown paths kill the child.
- **After P6**: concurrency + atomic-admission residency caps + invariant enforced; LRU spares busy/starting;
  `stdlib` routing unchanged.
- **After P7**: all escape/deny-belt/forgery/isolation cases fail closed; security sign-off can proceed.

## Human Verification (end of plan)

- **Security sign-off**: a maintainer/security reviewer reads the escape suite, confirms it covers the C1-reversal
  surface, and **accepts the single-layer threat model** (Deno/V8 runtime escape out of scope) for the deployment.
- **Memory under load on the target host**: run `MAX_RESIDENT_PYODIDE` heavy scripts concurrently on the real
  container; confirm behaviour matches the **accepted availability risk** (no surprise parent OOM beyond what's
  documented) and that defaults (+`PYODIDE_IDLE_MS`) are sane.
- **Cold-start UX**: time a first `pyodide` exec (Deno spawn + Pyodide init + package load) and confirm the exec
  timeout default accommodates it acceptably for the LibreChat loop.
- **Image portability**: confirm the vendored Deno + Pyodide assets build and run on a clean self-hosted install
  (image size acceptable).
- **End-to-end issue acceptance**: a human runs the real workflow (upload CSV → analyze → download xlsx) through
  the product UI/LibreChat and confirms the output file is correct.

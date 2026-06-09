# Implementation Plan — Pyodide Python runtime (issue #118)

## Overview

Replace the boolean `python` capability with `python_runtime: "stdlib" | "pyodide" | null` end-to-end (rolling-safe expand/contract migration), then implement the `pyodide` runtime as an **OS-isolated, zero-permission Deno subprocess** that loads Pyodide fully offline, runs untrusted Python (numpy/pandas/scipy/openpyxl), speaks a committed length-prefixed JSON IPC with realm lockdown + frame-integrity invariants, and drains cwd-scoped file changes into SqlFs inside the script transaction. The issue's core requirement: a `pyodide` sandbox can run `python3 analyze.py` (import pandas, write `out.xlsx`) and the file is retrievable via the files API.

**Resolved decisions carried from `design.md`/`structure.md`:**
- **Vendored assets are git-ignored and fetched by a build script** (`scripts/fetch-pyodide-assets.mjs`), invoked in the Dockerfile and runnable locally. (Resolves the "gitignore/LFS decided in plan" open item — no LFS; keep the repo lean, reproduce assets from a pinned manifest.)
- **Shared protocol contract** lives in `src/pyodide-runner/protocol.ts`, written runtime-agnostically (`Uint8Array`/`DataView`, no `Buffer`/`Deno` globals) so tsc compiles it for the Node side and Deno imports the raw `.ts`. The Deno entry `runner.ts` is **excluded from the tsc build** (uses Deno globals) and shipped to `dist/` as raw `.ts`.

> **Coordinated-release note.** All seven phases are implementation slices on **one branch → one breaking release**. The DB layer is rolling-deploy-safe (Phase 1); the API/SDK enum break still requires clients to upgrade. Between Phase 2 and Phase 5, a `pyodide` sandbox creates fine but `python3` inside it is "not registered" — an intermediate state that never reaches a cut release.

---

## Phase 0: Spikes (merge gates — throwaway POCs, not shippable)

Three POCs from `design.md` §"Required Spikes". Each must pass before its dependent phase; **fail any → stop and revisit the architecture with the user** before writing the corresponding product phase.

### Changes

#### 1. Spike scratch area
**Files**: `thoughts/issue-118-pyodide-runtime/spikes/` (create) — one scratch script + one short `SN-findings.md` note per spike.
**Action**: create

- **S1 — Pyodide-on-Deno offline** (gates Phase 3). Script `spikes/s1-pyodide-deno.sh` + `spikes/s1_runner.ts`. Download Deno (pinned version) + the `pyodide-0.29.x` full distribution locally into `spikes/assets/`. Run (note: `DENO_NO_UPDATE_CHECK` is set in the **parent shell/spawn env** — it is read by the Deno runtime, not via `Deno.env`, which `--deny-env` blocks; the asset dir is passed as **argv**):
  ```
  DENO_NO_UPDATE_CHECK=1 deno run --no-prompt --deny-net --deny-run --deny-write \
    --deny-env --deny-ffi --deny-sys --deny-import --no-remote --no-npm \
    --cached-only --no-config --allow-read=<assetdir> s1_runner.ts <assetdir>
  ```
  `s1_runner.ts` reads `<assetdir>` from `Deno.args` (**not** `Deno.env`), then `loadPyodide({ indexURL, lockFileURL, packageBaseUrl })` from local paths, `loadPackage(["numpy","pandas","scipy"])`, install the frozen openpyxl+et_xmlfile lock, run a pandas→openpyxl round-trip (DataFrame → `out.xlsx` bytes → read back), and print the round-trip byte length. **Assert zero network** (the deny flags + a packet-capture or a deliberate offline run prove it).
- **S2 — IPC integrity** (gates Phase 3/4). Script `spikes/s2-ipc.ts`. Implement length-prefixed JSON framing with a binary payload; model the real runner realm (install **then** delete `Deno`/`console`/`require`/`__dirname`/`__filename` from `globalThis`), and run an adversarial snippet that tries to **forge, interleave, or replay** a control frame, a stale-`generation` message, and a forged `ready` handshake. **Result (finding A): realm lockdown is not stdout containment** — `Deno.stdout.write`/`console.log`/`require` are blocked, but `import("node:fs").writeSync(1,…)` reaches stdout. The provable invariant is narrower: a frame validator rejects every forged/interleaved/replayed/stale-generation/bad-handshake frame, so escaped JS **cannot produce an _accepted_ frame** (it can't guess the secret `requestId`/`seq`/`generation`). Assert each is rejected and exit 0.
- **S3 — Per-child memory** (gates Phase 6). Script `spikes/s3-memory.sh`. In a `node:22-slim` non-root context, attempt to set cgroup v2 `memory.max` for a child and attempt `prlimit --as`; confirm both are unavailable/unusable (V8 vaddr reservation). Document that the **container memory limit + accepted availability risk (design D5)** is the operating model.

### Phase 0: Success Criteria

#### Phase 0: Programmatic Verification
- [x] `spikes/s1-pyodide-deno.sh` exits 0 and prints the pandas→openpyxl round-trip byte length with zero network access — `S1 PASS pyodide=0.29.4 roundtrip_xlsx_bytes=~4970` (varies ±1; openpyxl embeds timestamps), exit 0
- [x] `spikes/s2-ipc.ts` exits 0 and prints PASS for each of: forged-frame rejected, interleave rejected, replay rejected, stale-generation rejected — all four PASS (+ realm-lockdown, baseline, oversized), exit 0
- [x] `spikes/s3-memory.sh` exits 0 and prints the memory-limit probe result (cgroup write denied / prlimit unusable) — `cgroup_write_denied=1 rlimit_as_unusable=1`, exit 0

#### Phase 0: Agent Verification
- [x] Agent reviews `S1-findings.md`, `S2-findings.md`, `S3-findings.md` and confirms each gate's pass/fail is **explicit** before Phase 3/Phase 6 begin — each note opens with `GATE: ✅ PASS`
- [x] Agent confirms the exact Deno version and pyodide version validated in S1 match what Phase 3 pins — Phase 3 names no specific patch yet ("pins versions in a constant"); S1 is the source of truth → Phase 3 must pin **Deno v2.8.2** + **Pyodide 0.29.4** (recorded in `S1-findings.md`)

### Phase 0: Discoveries and Notable Information

**Validated pins (Phase 3 MUST adopt these — see `spikes/S1-findings.md`):** Deno **v2.8.2**, Pyodide **0.29.4** (full dist `pyodide-0.29.4.tar.bz2`, 408 MB, ships CPython 3.12), openpyxl **3.1.5** (`py2.py3-none-any`), et_xmlfile **2.0.0** (`py3-none-any`). The plan's `fetch-pyodide-assets.mjs` ("pins versions in a constant") names no patch yet — no conflict; S1 is the source of truth.

**Surprises (carry into Phase 3 `runner.ts`):**
- **Deno is detected as Node by Pyodide** (`process.versions.node` is populated), so it uses the **Node-fs load path** — Pyodide 0.29.4 has **no `Deno.readFile` branch** (its only alternative is browser `fetch`, which needs network). The Node-fs path is therefore the correct & only offline path.
- **Emscripten (`pyodide.asm.js`) needs CommonJS globals the Deno ESM realm lacks.** Before importing `pyodide.mjs`, `runner.ts` MUST set on `globalThis`: `require = createRequire(import.meta.url)` (from `node:module`), `__dirname = <assetDir>`, `__filename = <assetDir>/pyodide.asm.js`. Otherwise: `ReferenceError: require is not defined` / `__dirname is not defined` during `loadPyodide`. These node-builtin imports are NOT blocked by `--deny-import`/`--no-npm` (remote/npm only).
- **The npm `import("ws")` is never reached** — Pyodide's `initNodeModules` returns early (`typeof A < "u"`), so `--no-npm` causes no failure. Only `node:url/fs/fs-promises/vm/path` are imported.

**Adaptations / plan mismatches to fix in Phase 3:**
- **openpyxl + et_xmlfile are NOT in the Pyodide distribution** (absent from `pyodide-lock.json` and disk; numpy/pandas/scipy/**micropip** ARE present). Plan line 354's `loadPackage([...,"openpyxl"])` **by name throws** `No known package with name 'openpyxl'` against the stock lock. It only works once `build-pyodide-lock.mjs` produces the **custom lock** naming openpyxl+et_xmlfile (plan line 303). S1 instead vendors the two pure-python wheels and loads them by **direct `file://` URL** — also valid. Phase 3 should do one or the other deliberately.
- **`packageBaseUrl` is unnecessary** (plan lines 31/354): S1 used only `loadPyodide({ indexURL, lockFileURL, stdout, stderr })` and `loadPackage` resolved wheels relative to `indexURL`. Drop it or set `= indexURL`.

**Gotchas:** `indexURL` must end with `/` and be absolute; asset dir passed as **argv** (never `Deno.env` — `--deny-env`); `DENO_NO_UPDATE_CHECK=1` in the **spawn env** (read by the Deno runtime, not the program); vendored wheels must live **inside** the `--allow-read` asset dir. **Zero-network proof = success under `--deny-net`** (any network attempt throws). Cold load (loadPyodide + packages) takes several seconds → informs Phase 6 exec-timeout default.

**S2 finding A (HIGH) — realm lockdown is NOT stdout containment.** S2 models the real runner realm (installs + then deletes `require`/`__dirname`/`__filename` alongside `Deno`/`console`). The deletable primitives are blocked, but **`(await import("node:fs")).writeSync(1, bytes)` still reaches stdout under the full deny-belt** (`import` is syntax; `node:` builtins aren't gated by `--deny-import`/`--no-npm`; `--deny-write` doesn't block the open stdout fd; a dedicated control fd doesn't help — `fs.writeSync(anyFd,…)` works). ⇒ **Node-side frame validation with secret `requestId`/`seq`/`generation` is the LOAD-BEARING control, not defense-in-depth.** A stdout-writing attacker still cannot forge an *accepted* frame (it must guess unguessable secrets; can't read its own stdout to replay) — worst case is a corrupt/forged frame → kill-the-child. **Phase 3 `runner.ts` must (1) delete `require`/`__dirname`/`__filename` in lockdown and (2) NEVER expose `requestId`/`seq`/`generation` to untrusted Python.** Plan updated at Phase 3 (runner lockdown) + Phase 4 (`validateInbound` is primary control). The plan's `ready` handshake rules (plan.md:415, valid-once/pre-response/current-gen) were already correct; S2 now matches them exactly.

**S3 numbers (Phase 6 operating model):** non-root **cannot** write cgroup `memory.max` (read-only mount) nor create a child cgroup. RLIMIT_AS (`prlimit --as`/`ulimit -v`) is **unusable for RSS**: a 2 GiB-max WASM heap reserves **VmSize ≈ 10,712 MB** vs **VmRSS ≈ 41 MB**, and a 2 GiB RLIMIT_AS makes the allocation fail (`RangeError: could not allocate memory`). ⇒ **container memory limit is the only guard**; manager must respawn-on-exit (incl. OOM-kill); per-child OOM isolation is an accepted risk.

**Spike hygiene:** all downloaded assets live under `spikes/assets/` and are git-ignored (`spikes/.gitignore` covers `assets/` + `*.log`) — the ~408 MB Pyodide dist + Deno binary + wheels are reproducible from the script, never committed. To re-run: `bash spikes/s1-pyodide-deno.sh` (cached after first download); S2 via the bootstrapped `spikes/assets/deno-v2.8.2/deno` under the deny-belt; `bash spikes/s3-memory.sh` (needs Docker).

---

## Phase 1: `python_runtime` field — server-side break, rolling-safe (stdlib + null end-to-end)

Replace boolean `python` with the nullable enum across DB, types, persistence, validation, runtime resolution, and HTTP responses, safely under a mixed-version rolling deploy. `stdlib`→`new Bash({ python: true })`; `null`→no Python; `pyodide` is a valid stored value but Python stays unregistered until Phase 5.

### Changes

#### 1. Migration `0006_python_runtime.sql`
**File**: `src/sql-fs/migrations/postgres/0006_python_runtime.sql`
**Action**: create

Idempotent (re-runs every boot under the advisory lock — see `migrations.ts`). Adds the nullable enum column, backfills only NULL rows from legacy `python`, and survives the later `python`-drop release via a `pg_attribute` guard.

```sql
-- Migration 0006: replace boolean `python` with nullable `python_runtime` enum.
-- Expand/contract step N (this release). Rolling-deploy-safe: reads COALESCE the
-- legacy column, writes dual-write it (see postgres.ts). Step N+1 (later release)
-- drops `python` and removes the COALESCE/dual-write.

ALTER TABLE sandboxes
    ADD COLUMN IF NOT EXISTS python_runtime TEXT;

-- CHECK constraint (idempotent: add only if absent).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'sandboxes_python_runtime_check'
    ) THEN
        ALTER TABLE sandboxes
            ADD CONSTRAINT sandboxes_python_runtime_check
            CHECK (python_runtime IN ('stdlib','pyodide'));
    END IF;
END $$;

-- Backfill ONLY rows not yet migrated, and ONLY while the legacy `python` column
-- still exists (so this is a no-op after the N+1 drop release — never errors).
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_attribute
        WHERE attrelid = 'sandboxes'::regclass
          AND attname = 'python' AND NOT attisdropped
    ) THEN
        UPDATE sandboxes
        SET python_runtime = CASE WHEN python THEN 'stdlib' END
        WHERE python_runtime IS NULL;
    END IF;
END $$;
```

#### 2. Shared types
**File**: `src/sql-fs/types.ts`
**Action**: modify (`SandboxMeta` ~:61-70, `SandboxListEntry` ~:73-82)

```ts
/** Python runtime selection. null = no Python. */
export type PythonRuntime = "stdlib" | "pyodide" | null;
```

- `SandboxMeta`: replace `readonly python: boolean;` with `readonly python_runtime: PythonRuntime;` (keep `javascript`/`network`).
- `SandboxListEntry`: same replacement.

#### 3. Postgres dialect — rolling-safe read + dual-write
**File**: `src/sql-fs/dialects/postgres.ts`
**Action**: modify `getSandboxMeta` (:316-343), `updateSandboxMeta` (:345-362), `listSandboxes` (:364-402)

- **`getSandboxMeta`** — select the COALESCE expression so an old replica's `python=true`/`python_runtime IS NULL` row reads as `stdlib`:
  ```sql
  SELECT owner, name,
         COALESCE(python_runtime, CASE WHEN python THEN 'stdlib' END) AS python_runtime,
         javascript, network, created_at
  FROM sandboxes WHERE id = ${sandboxId}
  ```
  Map row → `python_runtime: r.python_runtime as PythonRuntime` (NULL → `null`).
- **`listSandboxes`** — same COALESCE in both the owner-filtered and unfiltered queries; map `python_runtime`.
- **`updateSandboxMeta`** — dual-write both columns so old replicas keep working:
  ```sql
  UPDATE sandboxes
  SET owner = ${meta.owner}, name = ${meta.name},
      python_runtime = ${meta.python_runtime},
      python = ${meta.python_runtime === "stdlib"},
      javascript = ${meta.javascript}, network = ${meta.network ?? false}
  WHERE id = ${sandboxId} RETURNING id
  ```
  (`stdlib → python=true`; `pyodide`/`null → python=false`.)

#### 4. RuntimeOptions + Bash construction
**File**: `src/api/session-manager.ts`
**Action**: modify `RuntimeOptions` (:110-120), `DEFAULT_RUNTIME_OPTIONS` (:122), `getOrCreate` Bash block (:487-497), `rehydrateAndExec` (:945-947), `rehydrateAndExecRead` (:898-900)

- `RuntimeOptions`: replace `readonly python: boolean;` with `readonly pythonRuntime: PythonRuntime;` (import `PythonRuntime` from `../sql-fs/types.js`).
- `DEFAULT_RUNTIME_OPTIONS`: `{ pythonRuntime: null, javascript: false, network: false }`.
- Bash block: `python: resolvedRuntime.pythonRuntime === "stdlib" || undefined,` — `pyodide` leaves `python: undefined` (Phase 5 adds the custom commands).
- Both rehydrate paths: build `resolvedRuntime` as `{ pythonRuntime: meta.python_runtime, javascript: meta.javascript, network: meta.network }`.
- `execWithRuntimeThrottle` (:1236): `const usesPython = session.runtimeOptions.pythonRuntime === "stdlib" && PYTHON_INVOCATION_REGEX.test(script);` (only `stdlib` routes through `pythonSem`; `pyodide` routing comes in Phase 6).

#### 5. Route validation + responses
**File**: `src/api/routes/sandboxes.ts`
**Action**: modify `createBodySchema` (:15-23), create handler (:33-134), list (:142-159), **GET (:179-196 — fix the omission)**

- `createBodySchema`: drop `python: z.boolean()`; add `python_runtime: z.enum(["stdlib", "pyodide"]).nullable().optional()`. Keep `javascript`/`network`. (Legacy `python: bool` is no longer in the schema → Zod `.strict()` is not currently used, so an extra `python` key is ignored; to **reject** it explicitly, add `.strict()` or a refine — see note below.)
- Replace the local `let python = false;` with `let pythonRuntime: PythonRuntime = null;`; parse `pythonRuntime = result.data.python_runtime ?? null;`.
- `persistSandboxMeta` call: pass `python_runtime: pythonRuntime` (drop `python`).
- `withSession` runtimeOptions arg: `{ pythonRuntime, javascript, network }`.
- Create 201 response: echo `python_runtime` (drop `python`); keep `javascript`, `network`.
- List response map: `python_runtime: s.python_runtime` (drop `python`).
- **GET fix** — both the cold-DB branch (:179-185) and warm-session branch (:190-196) must echo capabilities. Cold branch already has `meta`; add `python_runtime: meta.python_runtime, javascript: meta.javascript, network: meta.network`. Warm branch has no capabilities on `Session` directly — read them from `session.runtimeOptions`: `python_runtime: session.runtimeOptions.pythonRuntime, javascript: session.runtimeOptions.javascript, network: session.runtimeOptions.network`.

> **Reject-legacy note:** the design says "reject legacy `python: bool`". Implement by adding `.strict()` to `createBodySchema` so an unknown `python` key returns 400 `INVALID_INPUT`. Confirm no existing test sends `python:` (Phase 2 updates those that do).

#### 6. Update existing tests that assert `python`
**Files**: `src/api/tests/unit/session-manager.rehydrate.test.ts` (asserts `runtimeOptions.python:true` ~:63-71, 114-150), `src/sql-fs/dialects/tests/unit/postgres.advisory-lock.test.ts` (:131-170), `src/api/tests/unit/sandboxes.test.ts` (:64-101)
**Action**: modify — change `python: true` assertions to `pythonRuntime: "stdlib"` (RuntimeOptions) / `python_runtime: "stdlib"` (meta rows), and any mock `SandboxMeta` literals to the new shape.

#### 7. Migration integration test — assert the column + rolling-safe reads
**File**: `src/api/tests/integration/migrations.integration.test.ts`
**Action**: modify

**Test A — extend the existing `it(...)`** (column + CHECK + COALESCE read). Add, after the existing table/proc assertions:
```ts
// 0006: python_runtime column + CHECK exist.
const col = await sql<{ n: string }[]>`
  SELECT count(*)::text AS n FROM information_schema.columns
  WHERE table_name = 'sandboxes' AND column_name = 'python_runtime'`;
expect(col[0]?.n).toBe("1");

// Old-replica-style row (python=true, python_runtime NULL) reads back as stdlib via COALESCE.
await sql`INSERT INTO sandboxes (id, python, python_runtime) VALUES ('mig-legacy', true, NULL)`;
const legacy = await sql<{ pr: string | null }[]>`
  SELECT COALESCE(python_runtime, CASE WHEN python THEN 'stdlib' END) AS pr
  FROM sandboxes WHERE id = 'mig-legacy'`;
expect(legacy[0]?.pr).toBe("stdlib");
```

**Test B — the simulated `python`-drop idempotency, in its OWN isolated ephemeral database** (do NOT do this in Test A's DB). The `python`-drop is destructive: Phase 1 dialect code (`getSandboxMeta`/`updateSandboxMeta`/`listSandboxes`) still references `python` for COALESCE reads + dual-writes until release N+1, so dropping it on a shared DB would make any later dialect call fail for the wrong reason. Keep this check **migration-SQL-only** in a throwaway DB created/dropped within the test, with no dialect calls after the drop:
```ts
it("re-runs idempotently after a simulated python-column drop (N+1)", async () => {
  // own ephemeral DB, mirroring beforeAll's create/teardown pattern
  const dropDb = `vfs_mig_drop_${randomBytes(8).toString("hex")}`;
  await admin!.unsafe(`CREATE DATABASE ${dropDb}`);
  const dropUrl = withDatabase(base, dropDb);
  const dropCfg = loadTenantConfig({ TENANT_DATABASES: JSON.stringify({ default: dropUrl }) });
  const s = postgres(dropUrl, { prepare: false, max: 1 });
  try {
    await runMigrations(dropCfg);
    await s`ALTER TABLE sandboxes DROP COLUMN IF EXISTS python`;     // simulate the N+1 drop
    await expect(runMigrations(dropCfg)).resolves.toBeUndefined();   // pg_attribute guard → no error
  } finally {
    await s.end({ timeout: 5 });
    await admin!`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
                 WHERE datname = ${dropDb} AND pid <> pg_backend_pid()`;
    await admin!.unsafe(`DROP DATABASE IF EXISTS ${dropDb}`);
  }
});
```
(The existing second-run idempotency assertion in Test A stays.)

### Phase 1: Success Criteria

#### Phase 1: Programmatic Verification
- [x] `pnpm typecheck` passes
- [x] `pnpm lint:fix` passes (no remaining `python:` boolean in server code) — clean after adding `thoughts` to biome `files.ignore` (Phase 0 vendored Pyodide `.d.ts` assets were polluting the lint; biome doesn't read `.gitignore`)
- [x] `pnpm test:unit` passes (875 pass / 4 skip; updated rehydrate/advisory-lock/sandboxes/session-manager + extra meta-literal assertions green)
- [x] `pnpm test:integration` migration test passes: `python_runtime` column + CHECK exist; legacy `python=true` row reads back `stdlib`; migration re-runs cleanly after a simulated `python` drop (full integration suite 106 pass)
- [x] Server starts (`pnpm dev`) without migration errors — booted on :8080; `migration_ok` logged for `0006_python_runtime.sql` (idempotent "already exists, skipping" NOTICE is not an error), then `server_start`. Agent-managed boot; server shut down after checks.

#### Phase 1: Agent Verification
_(Dev-server protocol: see Success Criteria Guidelines — if no server is running for this worktree, ask the user to start `pnpm dev` or authorise the agent to manage it.)_
- [x] Against the running dev server, create a `stdlib` sandbox and a `null` (no `python_runtime`) sandbox; confirm **create-201, list, AND GET** all echo `python_runtime` — stdlib: all three echo `"stdlib"`; null: create+GET echo `null`. (Bonus: legacy `{"python":true}` body → 400 via `.strict()`.)
- [x] In the `stdlib` sandbox, `bash_exec` `python3 -c "print(1)"` returns `1`, exit 0 — `{"stdout":"1\n","exitCode":0}`
- [x] In the `null` sandbox, `python3 -c "print(1)"` reports command-not-found (Python not registered) — exit 127, `bash: python3: command not available…`
- [x] Agent reviews `postgres.ts` `getSandboxMeta`/`updateSandboxMeta` to confirm COALESCE read + dual-write are both present — `getSandboxMeta`/`listSandboxes` select `COALESCE(python_runtime, CASE WHEN python THEN 'stdlib' END)`; `updateSandboxMeta` sets both `python_runtime = ${meta.python_runtime}` and `python = ${meta.python_runtime === "stdlib"}`

### Phase 1: Discoveries and Notable Information

**Type-rename blast radius (plan under-listed the files to touch).** Renaming the shared types (`SandboxMeta.python`→`python_runtime`, `SandboxListEntry.python`→`python_runtime`, `RuntimeOptions.python`→`pythonRuntime`) breaks the **whole-program** `tsc` typecheck, so every consumer had to change in Phase 1 — not just the files the plan named. Beyond the plan's step-6 list, these also required edits to compile:
- **`src/api/mcp/tools.ts`** (plan defers MCP to **Phase 2**). It consumes `RuntimeOptions`/`SandboxMeta`/`SandboxListEntry`, so it can't be deferred for typecheck. **Adaptation:** kept its existing **boolean `python` MCP wire contract** (input `python: z.boolean()`, output `python: …`) and only rewired it internally onto the new fields (`pythonRuntime: (args.python ?? false) ? "stdlib" : null`; persist `python_runtime`; echo `python: runtimeOptions.pythonRuntime === "stdlib"` / `s.python_runtime === "stdlib"`). **Phase 2 still owns the real MCP migration** (enum input schema, `python_runtime` echo, `network` field, descriptions). The MCP wire contract is therefore unchanged by Phase 1.
- **Extra `SandboxMeta` mock literals** the plan didn't list: `src/api/tests/unit/ingest.test.ts`, `exec.test.ts`, `exec-batch.test.ts`, `files.test.ts` (all `python: false`→`python_runtime: null`).
- **Extra `RuntimeOptions` literals** the plan didn't list: `src/api/tests/unit/session-manager.test.ts` (many `getOrCreate(..., {python,…})` args + a `toEqual` assertion) and `src/api/tests/session-manager.script-tx.test.ts` (2). The `toEqual({ python: true, … })` on `runtimeOptions` shared the exact literal string with the `getOrCreate` args, so a single `replace_all` fixed both.

**`openapi-spec.ts` is plain `as const` data, NOT typed against `SandboxMeta`** → its `python: { type: "boolean" }` does NOT break typecheck and was correctly **left for Phase 2**. `clients/` SDKs are outside `tsconfig` `include: ["src"]` → not in the main typecheck either (Phase 2).

**Gotcha for any future migration — the dev DB must be migrated before integration tests.** Integration tests like `defense-in-depth.integration.test.ts` connect straight to `DATABASE_URL` and **assume the schema is already migrated** (they never call `runMigrations`). Because `getSandboxMeta`/`listSandboxes` now reference `python_runtime`, running integration tests against the local `sqlfs` DB failed with `column "python_runtime" does not exist` until 0006 was applied. **Fix:** apply the new migration to the dev DB once (`docker exec -i sqlfs-postgres psql -U sqlfs_app -d sqlfs < src/sql-fs/migrations/postgres/0006_python_runtime.sql`, idempotent) — in prod the boot-time runner does this automatically. Any later phase that adds a migration must re-apply it to the dev DB before `pnpm test:integration`.

**Biome lints git-ignored vendored assets (deviation: edited `biome.json`).** Biome 1.9.0 has no `vcs.useIgnoreFile` here, so `pnpm lint:fix` scanned the **Phase 0** git-ignored Pyodide `.d.ts` assets under `thoughts/.../spikes/assets/` and reported ~870 errors in third-party code. **Adaptation (outside the plan's file list):** added `"thoughts"` to `biome.json` `files.ignore` (matching the existing `scripts`/`clients/python/.venv` exclusions). Needed for the Phase 1 lint gate to pass honestly. **Note for Phase 3:** the new `vendor/deno/` + `vendor/pyodide/` asset dirs will need the same biome ignore (they're git-ignored too).

**`.strict()` on `createBodySchema`** implements the design's "reject legacy `python: bool`": an unknown key (incl. legacy `python`) now returns 400 `INVALID_INPUT`. Confirmed **no existing test sends `python:` in a request body** (all `python:` test literals were `SandboxMeta`/`RuntimeOptions` mocks, not HTTP bodies), so this is safe.

**Test count moved 105→106** integration tests (new Test B "re-runs idempotently after a simulated python-column drop (N+1)"). Unit tests: 875 pass / 4 skip.

**Env note for running integration locally:** the suite does NOT auto-load `.env` (`vitest.setup.ts` only seeds `TENANT_DATABASES`); pass `DATABASE_URL=postgres://sqlfs_app:sqlfs_app@localhost:5433/sqlfs` (and `REDIS_URL`) explicitly on the command line.

---

## Phase 2: `python_runtime` — client & contract surfaces (SDKs, MCP, OpenAPI, docs)

Propagate the enum to every external representation (research Q5) and reconcile the second-class `network` field in the same coordinated break.

### Changes

#### 1. TypeScript SDK
**File**: `clients/typescript/src/models.ts` (:4-11, :81-90), `clients/typescript/src/client.ts` (:10-17, :72-80)
**Action**: modify

- `models.ts`: add `export type PythonRuntime = "stdlib" | "pyodide" | null;`. In `SandboxRecord`, replace `python: boolean` with `python_runtime: PythonRuntime`; **add `network: boolean`** (reconcile asymmetry). In `sandboxRecordFromApi`, parse `python_runtime: (payload.python_runtime ?? null) as PythonRuntime`, `network: Boolean(payload.network)`.
- `client.ts`: in `CreateSandboxOptions`, replace `python?: boolean` with `python_runtime?: PythonRuntime`. In `create()`, replace the `options.python` block with `if (options.python_runtime !== undefined) body.python_runtime = options.python_runtime;`.

#### 2. Python SDK
**File**: `clients/python/src/sqlfs/models.py` (:14-34), `clients/python/src/sqlfs/client.py` (:103-146)
**Action**: modify

- `models.py`: add `PythonRuntime = Literal["stdlib", "pyodide"]` type alias (Optional in field). In `SandboxRecord`, replace `python: bool` with `python_runtime: Optional[PythonRuntime]`; **add `network: bool`**. In `from_api`, `python_runtime=payload.get("python_runtime"), network=bool(payload.get("network", False))`.
- `client.py`: in `create()`, replace `python: bool = False` param with `python_runtime: Optional[Literal["stdlib","pyodide"]] = None`; body: `if python_runtime is not None: body["python_runtime"] = python_runtime`. Update the docstring (drop `python:`, document `python_runtime`).

#### 3. MCP tools
**File**: `src/api/mcp/tools.ts` (:34-78, :81-116, bash_exec prose :153-180)
**Action**: modify

- `sandbox_create` input schema: replace `python: z.boolean().optional()` with `python_runtime: z.enum(["stdlib","pyodide"]).nullable().optional()`. Build `runtimeOptions = { pythonRuntime: args.python_runtime ?? null, javascript: args.javascript ?? false, network: false }`. `persistSandboxMeta` with `python_runtime: runtimeOptions.pythonRuntime`. Echo `python_runtime` in the response JSON.
- `sandbox_list` map: echo `python_runtime: s.python_runtime` (drop `python`).
- Update the `sandbox_create` tool **description** and `bash_exec` prose: explain `python_runtime: "stdlib"` (CPython WASM, air-gapped) vs `"pyodide"` (numpy/pandas/scipy/openpyxl, OS-isolated Deno subprocess).

#### 4. OpenAPI spec
**File**: `src/api/openapi-spec.ts` (sandboxSchema :16-27, create body :321-322)
**Action**: modify

- `sandboxSchema`: replace `python: { type: "boolean" }` with `python_runtime: { type: "string", enum: ["stdlib","pyodide"], nullable: true }`; **add `network: { type: "boolean" }`**. Update `required` → `["id","name","owner","createdAt","python_runtime","javascript","network"]`.
- Create-body schema: replace `python` with `python_runtime: { type: "string", enum: ["stdlib","pyodide"], nullable: true, description: "Python runtime: stdlib (CPython WASM) or pyodide (numpy/pandas/scipy/openpyxl, OS-isolated)" }`; **add `network`** to the create body too.

#### 5. Changeset (version bump — do NOT hand-edit version/CHANGELOG)
**File**: `.changeset/<generated>.md`
**Action**: create via `pnpm changeset` — describe the breaking change (`python` boolean → `python_runtime` enum; add Pyodide runtime). Pick **major** (breaking API/SDK contract).

#### 6. Plugin docs
**File**: `plugins/sql-fs/skills/api/ref/endpoints.md` (:119-168), `api/ref/bash.md` (:48-78), `py-sdk/ref/models.md` (:25-37), `py-sdk/ref/client.md` (:113-142), `py-sdk/SKILL.md` (:204-208), `api/SETUP.md` (:61)
**Action**: modify — replace `python` boolean rows/examples with `python_runtime` (values `stdlib`/`pyodide`/null), keep the immutability note (`endpoints.md:148`), and ensure `network` appears in the response shapes.

#### 7. SDK + MCP tests
**Files**: `clients/python/tests/test_client.py` (:82-160), `clients/typescript/tests/sandboxes.test.ts` (:15-38), `src/api/tests/unit/mcp-tools.test.ts` / `mcp.test.ts`, examples (`clients/*/examples/*`)
**Action**: modify — assert `python_runtime` round-trips (request + record), `network` now present in `SandboxRecord`; add an MCP `sandbox_create`/`sandbox_list` assertion echoing `python_runtime`.

### Phase 2: Success Criteria

#### Phase 2: Programmatic Verification
- [x] `pnpm typecheck && pnpm lint:fix && pnpm test:unit` pass (877 pass / 4 skip — +2 new MCP `python_runtime` echo tests)
- [x] Python SDK suite passes (`uv run --extra dev pytest` — 37 pass; also `mypy --strict` + `ruff` clean); TS SDK suite passes (`pnpm install && pnpm typecheck && pnpm test` — 19 pass)
- [x] `mcp-tools.test.ts` passes with the new `python_runtime` assertions (sandbox_create echoes `python_runtime`; sandbox_list echoes per-sandbox `python_runtime`)
- [x] OpenAPI spec still serializes (route is `c.json(openapiSpec)`; spec JSON-round-trips, 24 KB, Sandbox + create-body carry `python_runtime`+`network`, `python` removed) and `.changeset/python-runtime-enum.md` exists (major)

#### Phase 2: Agent Verification
- [x] Agent diffs every research-Q5 surface against a checklist (Python SDK model+client, TS SDK model+client, MCP create+list, OpenAPI record+create, all docs) and confirms **no remaining boolean `python`** — also caught + fixed 3 surfaces the plan's docs list omitted (both SDK READMEs + the Python `__init__.py` module docstring)
- [x] Agent confirms `network` now appears in both SDK `SandboxRecord` types (TS `models.ts:14`/`:93`, Py `models.py:27`/`:38`) and the OpenAPI record (`Sandbox.properties.network` + `required`) + create schemas

### Phase 2: Discoveries and Notable Information

**Surfaces the plan's docs list (step 6) under-counted.** Beyond the six `plugins/sql-fs/skills/*` docs, three more user-facing SDK doc surfaces carried boolean `python` and had to change for the "no remaining boolean `python`" gate: `clients/python/README.md`, `clients/python/src/sqlfs/__init__.py` (the module-level quick-start docstring), and `clients/typescript/README.md`. Sweep the READMEs + module docstrings, not just the plugin skill docs.

**SDK packages are standalone (no pnpm workspace).** There is **no `pnpm-workspace.yaml`** — `clients/typescript` is its own package (`sql-fs-sdk@0.3.0`) and is NOT covered by the root `pnpm typecheck`/`test:unit` (root `tsconfig` is `include: ["src"]`). To run the TS SDK suite you must `cd clients/typescript && pnpm install` first (its `node_modules` was absent), then `pnpm typecheck && pnpm test`. The **root** `biome` (`pnpm lint:fix`) DOES lint `clients/typescript/src` (only `clients/python/.venv` is biome-ignored), so SDK TS style is enforced centrally.

**Python SDK runner:** no `.venv` committed; use `uv run --extra dev pytest` (creates `.venv`, builds the editable pkg). 37 tests pass. `mypy --strict` + `ruff` also clean. `pyproject.toml` pins `[tool.mypy] python_version = "3.9"` which newer mypy warns is unsupported (must be ≥3.10) but still runs clean — pre-existing, not ours to fix here. **`uv run` rewrites `clients/python/uv.lock`** (syncs the `sql-fs-sdk` self-package version). When NOT bumping the version it just re-normalizes/re-sorts (spurious → revert); when bumping (this phase) it's a legitimate version sync (keep). Note: the committed lock self-version was **stale at `0.2.3`** vs pyproject `0.3.0` — a pre-existing drift now corrected to `0.4.0`.

**Changeset (`pnpm changeset` TUI is non-interactive here, so hand-authored):** mirrors existing `.changeset/*.md` — front-matter `"sql-fs-api": major` + body. Changesets track ONLY `sql-fs-api` (the root). ⚠️ **The SDKs are NOT changeset-managed and need their own version bumps** (see below) — a Codex review correctly flagged that the root changeset alone would never publish the breaking SDK change.

**SDK release model + version bumps (Codex review, post-implementation fixes).** Each SDK has its own release pipeline — `.github/workflows/ts-sdk-release.yml` / `python-sdk-release.yml` — that fires on a push to `main` touching `clients/<sdk>/**` and **publishes only when the version is new** (TS: `pnpm check:version` requires `package.json` ↔ `src/version.ts` ↔ `CHANGELOG.md` to all agree; Python: detects version from `CHANGELOG.md`, cross-checks `pyproject.toml` + `src/sqlfs/_version.py`, and skips publish if the git tag already exists). **Consequence:** a breaking SDK change with no version bump is silently *skipped at publish* (0.3.0 is immutable on npm/PyPI) → the change never reaches users. **Fix applied:** bumped both SDKs **0.3.0 → 0.4.0** (conventional 0.x breaking bump — minor) with `## [0.4.0] - 2026-06-08` CHANGELOG entries, across all version files each (TS: `package.json` + `src/version.ts` + `CHANGELOG.md`, verified by `pnpm check:version`; Python: `pyproject.toml` + `_version.py` + `CHANGELOG.md`, verified by `uv lock --check`). Picked 0.4.0 not 1.0.0 to keep the SDKs pre-1.0 (initial release was 0.3.0). **Also (Codex finding 2):** two SDK README API-surface lines still advertised boolean `python` (TS `README.md:61` signature list, Py `README.md:84` method table) — both migrated to `python_runtime` (+`network` on the Py row).

**OpenAPI verification without a live server:** the route is literally `app.get("/openapi.json", (c) => c.json(openapiSpec))`, so `JSON.stringify(openapiSpec)` round-tripping (via a one-shot `npx tsx -e`) deterministically proves `GET /openapi.json` returns valid JSON — no dev server needed for this programmatic check.

**SDK public type export (minor addition beyond the plan):** exported `PythonRuntime` from both SDKs (`clients/typescript/src/index.ts`, Python `__init__.py` + `models.py __all__`) so users assigning `python_runtime` can name the type — parity with the new field. **`network` was newly added to both `SandboxRecord` types** (it existed server-side but was never surfaced in the SDK record — the plan's "reconcile asymmetry").

**SandboxInfo unchanged:** the SDKs' `.get()` model (`SandboxInfo`) was deliberately NOT given `python_runtime` — Phase 2 only touched `SandboxRecord` (create/list). The server's GET now returns the capability fields (Phase 1) but the SDK `SandboxInfo` model still doesn't parse them (pre-existing, out of scope).

---

## Phase 3: Offline assets + Deno harness (the untrusted side)

Vendor the runtime assets and write the Deno-side harness that loads Pyodide offline, runs untrusted Python, locks down its realm, and speaks the committed IPC. Hardens S1/S2 into product. Standalone-testable without Node. **Gated by spike S1 + S2.**

### Changes

#### 1. Asset fetch + lock-build tooling
**File**: `scripts/fetch-pyodide-assets.mjs` (new), `scripts/build-pyodide-lock.mjs` (new)
**Action**: create

- `fetch-pyodide-assets.mjs`: downloads the pinned **Deno** binary into `vendor/deno/` and the full **`pyodide-0.29.x`** distribution (wasm + `python_stdlib.zip` + numpy/pandas/scipy wheels + base `pyodide-lock.json`) into `vendor/pyodide/`. Pins versions in a constant at the top of the file. Idempotent (skips if present + checksum matches).
- `build-pyodide-lock.mjs`: runs Pyodide once (Node or Deno) to `micropip.freeze` the **openpyxl + et_xmlfile + transitive** set against the local distribution, producing a **custom `vendor/pyodide/pyodide-lock.custom.json`**. **Never hand-edit the lock.** If the freeze tooling is unavailable offline, the fallback is documented in the file header: re-run with network once on a build host, commit the resulting lock to the asset manifest (not the wheels).
- `.gitignore`: add `vendor/deno/` and `vendor/pyodide/` (assets are reproduced by the fetch script, not committed).

#### 2. Shared protocol contract
**File**: `src/pyodide-runner/protocol.ts` (new)
**Action**: create — runtime-agnostic (`Uint8Array`/`DataView`, no `Buffer`/`Deno`).

> **Note (as implemented in Phase 3 — supersedes the original files-only sketch).**
> FS entries carry a `kind` so the manager/drain (Phase 5) can apply dirs-before-files
> and represent script-created **empty directories**. `created` is ordered
> dirs-before-files (dirs shallow→deep); `deleted` is depth-first (deepest first).
> See Phase 3 Discoveries for why (resolves a plan inconsistency vs the Phase 5
> "dirs-before-files" / "delete depth-first" drain spec).

```ts
export const PROTOCOL_VERSION = 1;
export type FrameType = "run" | "result" | "error" | "ready";

// A staged-in / drained-out filesystem entry. `data` is base64 file contents for
// `kind:"file"` and "" for `kind:"dir"`.
export interface FsEntry {
  readonly path: string;
  readonly kind: "file" | "dir";
  readonly mode: number;
  readonly data: string;        // base64 file contents; "" for dirs
}

export interface RunRequest {
  readonly type: "run";
  readonly requestId: string;   // random, set by Node
  readonly seq: number;         // monotonic per child
  readonly generation: number;  // child generation id
  readonly code: string;        // resolved script or -c body
  readonly argv: readonly string[];
  readonly stdin: string;       // base64
  readonly files: readonly FsEntry[];   // cwd subtree staged into MEMFS (files + dirs)
  readonly cwd: string;
}

export interface RunResponse {
  readonly type: "result" | "error";
  readonly requestId: string;
  readonly seq: number;
  readonly generation: number;
  readonly stdout: string;      // base64
  readonly stderr: string;      // base64
  readonly exitCode: number;
  readonly created: readonly FsEntry[];   // dirs-before-files (dirs shallow→deep)
  readonly modified: readonly FsEntry[];  // changed files
  readonly deleted: readonly string[];    // depth-first (deepest first)
}

// `ready` is a ONE-TIME pre-run handshake (no requestId/seq), validated separately
// from per-request frames — see ipc.ts integrity rules. It carries `generation` only.
export interface ReadyFrame { readonly type: "ready"; readonly generation: number; }
export type Frame = RunRequest | RunResponse | ReadyFrame;

// Length-prefixed framing: 4-byte big-endian uint32 length + UTF-8 JSON body.
export function encodeFrame(obj: Frame): Uint8Array { /* DataView header + TextEncoder body */ }
export function decodeFrames(buf: Uint8Array): { frames: Frame[]; rest: Uint8Array } { /* parse complete frames */ }
```

#### 3. Deno harness (untrusted side)
**File**: `src/pyodide-runner/runner.ts` (new — Deno entry, **excluded from tsc build**)
**Action**: create

- Resolve asset paths (`indexURL`, `lockFileURL` (the custom lock), `packageBaseUrl` — all local, derived from the absolute asset dir) from `Deno.args` (**argv only**, passed by Node). **Never `Deno.env`** — it is blocked by `--deny-env`. (`DENO_NO_UPDATE_CHECK` is set in Node's spawn env and read by the Deno runtime, not by the program.)
- `const pyodide = await loadPyodide({ indexURL, lockFileURL, packageBaseUrl, stdout, stderr })`; preload `await pyodide.loadPackage(["numpy","pandas","scipy","openpyxl"])`.
- **Realm lockdown BEFORE any untrusted Python:** capture the raw stdout writer (`Deno.stdout.write` bound), then delete from `globalThis`: `Deno`, `console`, **and the Node-compat globals S1 installs for Pyodide — `require`, `__dirname`, `__filename`** (spike S2 finding A: these are live write primitives — `require("fs").writeSync(1,…)` — and must be deleted too). All control-frame writes go through the captured writer only.
  - **S2 finding A (HIGH) — lockdown is NOT stdout containment.** `(await import("node:fs")).writeSync(1, bytes)` still reaches stdout under the deny-belt (`import` is syntax; `node:` builtins aren't gated by `--deny-import`/`--no-npm`; `--deny-write` doesn't block the open stdout fd; a dedicated fd doesn't help — `fs.writeSync(anyFd,…)` works). The **Node-side frame validation with secret `requestId`/`seq`/`generation` is therefore LOAD-BEARING, not defense-in-depth** (Phase 4). To keep that guarantee, **`runner.ts` MUST NOT expose `requestId`/`seq`/`generation` to untrusted Python** — pass only `code`/`argv`/`stdin`/`files` into Pyodide; keep the integrity fields in JS closure.
- IPC loop: read length-prefixed frames from stdin (`Deno.stdin`), for each `run` frame: stage `files` into MEMFS (`FS.mkdirTree` + `FS.writeFile`), reset Python `globals`, run `pyodide.runPythonAsync(code, ...)`, capture stdout/stderr via Pyodide stream callbacks into base64 fields, compute the `{created,modified,deleted}` diff against the staged input set, and emit exactly one `result`/`error` frame carrying the matching `requestId`/`seq`/`generation`.
- Between execs: fresh `globals` + wipe staged MEMFS paths (bounds variable scope + staged files; `sys.modules`/package globals persist within a session — same trust boundary, per design D3).

#### 4. Build wiring
**File**: `package.json` (`build` script), `scripts/copy-postgres-migrations.mjs` sibling, `Dockerfile`
**Action**: modify

- Add a `copy-pyodide-runner.mjs` (or extend the build) to copy `src/pyodide-runner/*.ts` → `dist/pyodide-runner/` raw (Deno runs the `.ts`). tsc compiles `protocol.ts` → `dist/pyodide-runner/protocol.js` for the Node side; **exclude `src/pyodide-runner/runner.ts`** from `tsconfig.json` `include`/add to `exclude` (Deno globals).
- `Dockerfile`: in the builder stage run `node scripts/fetch-pyodide-assets.mjs && node scripts/build-pyodide-lock.mjs`; `COPY --from=builder --chown=app:app /app/vendor ./vendor` into the runtime stage, and copy `dist/pyodide-runner`. Set `ENV PYODIDE_ASSET_DIR=/app/vendor/pyodide DENO_BIN_PATH=/app/vendor/deno/deno`.

### Phase 3: Success Criteria

#### Phase 3: Programmatic Verification
- [x] `node scripts/fetch-pyodide-assets.mjs && node scripts/build-pyodide-lock.mjs` produce `vendor/pyodide/` + the custom lock — fetch verifies pinned SHA256 of the dist + downloads/verifies both wheels; build-lock wrote `pyodide-lock.custom.json` (381 packages, openpyxl+et_xmlfile added)
- [x] `pnpm typecheck` passes (protocol.ts compiles; runner.ts excluded via tsconfig `exclude`)
- [x] Running the built `runner.ts` under the committed flags with a fixture `run` frame on stdin returns a valid `result` frame whose pandas→openpyxl output bytes decode correctly — **zero network** (ran under `--deny-net`): `out.xlsx` drained 4970 bytes (PK zip), exit 0, ready+result frames, integrity fields echoed. Extended (post-review) to a 2-frame fixture: `created` carries `kind:"dir"` entries (empty dir + nested dir) ordered dirs-before-files, and a second frame confirms the cwd subtree is fully wiped between execs
- [x] `pnpm lint:fix` passes (runner.ts biome-ignored — Deno-realm patterns; see Discoveries)

#### Phase 3: Agent Verification
- [x] Agent re-runs an S2 forge attempt against the built `runner.ts`; confirms the forged frame is **not accepted** — re-ran `s2-ipc.ts` under the committed flags via the vendored Deno (ALL PASS: forged/interleave/replay/stale-generation + ready-handshake violations rejected; finding A reconfirmed). Code review: `runner.ts` passes ONLY `argv`/`stdin`/`cwd` into Python — `requestId`/`seq`/`generation` never cross into Pyodide, so a forger can't produce an accepted frame. (The reject+kill-the-child wiring is Phase 4's `validateInbound`, which the S2 validator models — there is no Node manager yet in Phase 3.)
- [x] Agent confirms the deny-belt blocks remote import, npm import, FS write, env read, subprocess spawn, FFI, sys-info, and network (deny-belt probe under the committed flags: all 8 fail closed). Update-check is suppressed by `DENO_NO_UPDATE_CHECK=1` (spawn env) + `--deny-net`.
- [x] Agent reviews `runner.ts` to confirm realm lockdown happens **before** the first untrusted `runPythonAsync` — `delete g.Deno/console/require/__dirname/__filename` (lines ~111-115) run after the trusted `loadPyodide`/`loadPackage` (79-103) and before the first untrusted `runPythonAsync(req.code)` (line ~200, reached only when a `run` frame arrives in the IPC loop)

### Phase 3: Discoveries and Notable Information

**Design fork resolved (Phase-0-authorized "do one or the other deliberately").** Two coherent paths existed for openpyxl/et_xmlfile (absent from the stock dist): (A) a custom lock + `loadPackage`-by-name, or (B) the **S1-proven** `file://` wheel load. **runner.ts uses path B** — it's the only end-to-end-proven offline path (lowest risk for the verification gate). `build-pyodide-lock.mjs` still produces `pyodide-lock.custom.json` (the plan's deliverable) but the runner does NOT depend on it. The custom lock is a supplementary manifest / future path to loadPackage-by-name.

**`build-pyodide-lock.mjs` uses a deterministic offline MERGE, not `micropip.freeze`** (deliberate deviation). Offline `micropip.freeze` is unproven/fragile; the merge (read stock lock → append openpyxl+et_xmlfile entries with sha256 from the vendored wheels → write custom lock) is deterministic, fast, no runtime spawn, and produces an equivalent artifact. Schema mirrored from a stock pure-python entry (`affine`): `{name, version, file_name, install_dir:"site", sha256, package_type:"package", imports, depends, unvendored_tests:false, shared_library:false}`.

**Checksum pinning is platform-aware.** `fetch-pyodide-assets.mjs` SHA256-pins the platform-INDEPENDENT bytes — `pyodide.mjs`, `pyodide.asm.wasm`, `python_stdlib.zip`, and the two wheels — to the exact S1-validated artifacts (hard-fail on mismatch). The **Deno binary is pinned by version + official dl.deno.land URL only**: its bytes are platform-specific (arm64-darwin locally vs linux-x64 in Docker), so a single cross-arch checksum is impossible. Pinned wheel sha256: openpyxl-3.1.5 `5282c12b…`, et_xmlfile-2.0.0 `7a91720b…`.

**Pyodide 0.29.4 ships CPython 3.13, not 3.12** (Phase 0 note said 3.12). The dist wheels are tagged `cp313-cp313-pyemscripten_2025_0_wasm32`; lock `info.platform = emscripten_4_0_9`. Immaterial to behaviour — noted for accuracy.

**Stdout capture must NOT use `pyodide.setStdout({batched})`** — batched only flushes per-line, so a final `print(..., end="")` (no newline) is silently dropped. The runner instead **redirects Python `sys.stdout`/`sys.stderr` to `io.StringIO`** in the prelude and reads `getvalue()` after the run (then restores `sys.__stdout__`/`__stderr__`). Captures everything regardless of newlines/flush. (Found via the fixture test: first attempt drained the xlsx fine but `result.stdout` was empty.)

**`runner.ts` is excluded from BOTH tsc and biome.** tsc: `tsconfig.json` `exclude` (Deno globals won't compile under the Node config). biome: added `src/pyodide-runner/runner.ts` to `files.ignore` — its Deno-realm patterns (`as any` on Deno globals, the 5 realm-lockdown `delete` statements) trip `noExplicitAny`/`noDelete`, which are wrong for this file (the deletes are one-time security lockdown, not a perf concern). `protocol.ts` stays fully linted+typed (clean, runtime-agnostic). Also added `vendor` to biome `files.ignore` (Phase 1 Discoveries flagged this).

**Build wiring:** `dist/pyodide-runner/` ends up with `protocol.js` (tsc, Node side) + `protocol.ts` + `runner.ts` (raw, copied by `scripts/copy-pyodide-runner.mjs`, wired into `pnpm build`). `runner.ts` imports `./protocol.ts` (explicit `.ts`) — Deno resolves the raw `.ts`; Node imports `protocol.js`. Both coexist.

**`.dockerignore` needed two adds** (the plan's Dockerfile change implied them): `vendor` (builder regenerates it fresh; never copy a stale local copy) and `thoughts` (holds ~408 MB of spike scratch assets — would bloat the build context). Dockerfile builder also `apt-get install`s `curl unzip bzip2` (needed by the fetch script).

**Verification economy:** to avoid a redundant 408 MB Pyodide download, `vendor/` was seeded from the byte-identical S1 spike cache, then the two wheels were deleted to force a REAL download+SHA256-verify of small artifacts. The fetch script's skip-if-present + checksum-verify paths ran against the real pinned bytes; the 408 MB download path is identical curl/tar logic to the proven `s1-pyodide-deno.sh`. In Docker/CI the script does a full fresh download.

**Gotcha for Phase 4/5:** the runner reads `[assetDir, generation]` from `Deno.args`; emits a `ready` frame (generation only) before reading any `run` frame; per `run` it stages files → fresh-namespace `runPythonAsync` → diffs the cwd subtree → emits exactly one `result`/`error` (echoing `requestId`/`seq`/`generation` from the request, held in JS). Manager spawn (Phase 4) must pass `--allow-read=<assetDir>`, the assetDir + generation as argv, and `DENO_NO_UPDATE_CHECK=1` in the (scrubbed) env. Cold load (loadPyodide + numpy/pandas/scipy + 2 wheels) takes several seconds — informs the exec-timeout default.

**Post-review protocol extension (Codex review — fixed in Phase 3, resolves a plan internal-inconsistency).** The plan's Phase 3 protocol modelled `created`/`modified` as files-only (`{path, mode, data}`), but the plan's Phase 5 drain says "apply **dirs-before-files**" and "for `deleted`: delete **depth-first**" — which is dir-aware. Two valid review findings followed: (1) the files-only protocol can't represent script-created **empty directories** or the dir ordering Phase 5 demands; (2) the wipe unlinked only files (`baseline ∪ seen`, `seen` excluded dirs), so script-created **dirs leaked** into the next exec in the same warm child. **Fix (cheapest here, not retrofitted in Phase 5):**
- `protocol.ts` now has a shared `FsEntry { path; kind: "file" | "dir"; mode; data }` (`data: ""` for dirs), used by `RunRequest.files` (input staging — can carry empty dirs) and `RunResponse.created`/`modified` (output). `created` is ordered **dirs-before-files (dirs shallow→deep)**; `deleted` is **depth-first (deepest first)** — both drain-ready for Phase 5.
- `runner.ts`: `walkTree(cwd)` now walks dirs + files; staging handles `kind`; the baseline is snapshotted AFTER staging (so staging-infra dirs that pre-exist in the caller's tree aren't mis-reported as created); the diff emits created dirs + files / modified files / deleted; the wipe now **recursively clears the entire cwd subtree depth-first** (files via `unlink`, dirs via `rmdir`) so no dir leaks across execs. (`sys.modules`/package globals still persist — design D3 unchanged.)
- Verified: the extended fixture creates a file + empty dir + nested-dir-with-file → `created` carries `kind:"dir"` entries ordered dirs-before-files; a second frame's `os.listdir(".")` is empty → cwd fully wiped between execs.
- `.tmp` added to `biome.json` `files.ignore` (it's gitignored ephemeral scratch; biome was linting the throwaway verification probes).

---

## Phase 4: Node-side `PyodideSandbox` manager + IPC client

The trusted Node half: spawn/own the Deno subprocess, frame the protocol with full integrity checks, serialize execs, enforce throw-not-return cancellation and respawn. No session wiring yet — unit-testable in isolation. **Gated by S2.**

### Changes

#### 1. IPC framing + integrity
**File**: `src/api/pyodide/ipc.ts` (new)
**Action**: create — imports types from `../../pyodide-runner/protocol.js`.

- `encodeFrame(obj): Buffer` / `decodeFrames(chunk: Buffer): { frames: Frame[]; rest: Buffer }` (length-prefixed; mirror the protocol helpers, Node `Buffer` variant).
- `validateInbound(frame, expected): void` — **schema-validate + enforce integrity on every inbound frame.**
  - **`result`/`error` frames:** match `requestId`, monotonic `seq`, exact `type`, current `generation`, and **exactly one response per request**.
  - **`ready` handshake (explicit exception):** carries `generation` only (no `requestId`/`seq`). It is valid **exactly once**, **before any `result`/`error`**, and **only with the current `generation`**. A second `ready`, a `ready` after the first response, or a stale/wrong-generation `ready` is an integrity violation → kill the child. (The handshake marks the `starting → idle` transition.)
- **Size caps measured on the base64-encoded wire size** (accounts for ~33% expansion): `PYODIDE_MAX_FRAME_BYTES` per frame + `PYODIDE_MAX_AGGREGATE_BYTES` aggregate per response.
- Any malformed / oversized / duplicate / out-of-sequence / wrong-generation / unexpected frame → throw a typed `IpcIntegrityError` that the manager turns into **kill-the-child**.
- **This validation is the PRIMARY, load-bearing security control — not defense-in-depth (spike S2 finding A).** Realm lockdown in `runner.ts` cannot contain stdout (`(await import("node:fs")).writeSync(1,…)` reaches it under the deny-belt), so untrusted code *can* write raw bytes to the channel. It still cannot produce an **accepted** frame: `requestId`/`seq`/`generation` are unguessable secrets never exposed to the child's Python (Phase 3 requirement), and a process cannot read its own stdout to replay. Treat `validateInbound` as security-critical; the worst an attacker achieves is corrupting/forging a frame → kill-the-child (self-DoS), never a drain of forged files.

#### 2. Manager / worker state machine
**File**: `src/api/pyodide/manager.ts` (new)
**Action**: create

```ts
export type WorkerState = "cold" | "starting" | "idle" | "busy" | "terminating" | "dead";

export class PyodideSandbox {
  readonly state: WorkerState;
  readonly generation: number;
  run(req: RunRequest, signal: AbortSignal): Promise<RunResponse>;
  dispose(): Promise<void>;
}
```

- Spawns the child via `child_process.spawn` (**no shell** — so `$VAR` is NOT expanded). **Node resolves `PYODIDE_ASSET_DIR` and `DENO_BIN_PATH` from its own parent config/env BEFORE spawn**, then passes the **absolute** asset dir **literally** in both `--allow-read=<resolvedAssetDir>` and as a runner argv (never via the child env — it is scrubbed). The child env is **only** `{ DENO_NO_UPDATE_CHECK: "1" }` (no `AUTH_SECRET`/`DATABASE_URL`; Node does NOT inherit the parent env when `env` is given). Sketch:
  ```ts
  const assetDir = process.env.PYODIDE_ASSET_DIR!;   // resolved by Node, absolute
  const denoBin  = process.env.DENO_BIN_PATH ?? "deno";
  spawn(denoBin, [
    "run", ...COMMITTED_FLAGS, `--allow-read=${assetDir}`,
    "dist/pyodide-runner/runner.ts", assetDir,        // asset dir via ARGV, not env
  ], { env: { DENO_NO_UPDATE_CHECK: "1" }, stdio: ["pipe", "pipe", "pipe"] });
  ```
- **Per-subprocess mutex/queue** serializes `run()` (reuse the `SemaphoreWaiter`-style abort cleanup pattern from `session-manager.ts:1180-1219`).
- **Cancellation is state-dependent — never kill the child out from under an innocent active request:**
  - **Abort while still queued (before this call acquires the mutex):** remove only this waiter and reject it with `AbortError`. **Do NOT kill the child** — another `run()` may be actively executing on it; killing would terminate the wrong request and corrupt its generation. The active call is unaffected.
  - **Abort after this call acquires the mutex** (it now owns the child — during init/preload or mid-run), **or internal runtime timeout** (`PYODIDE_RUNTIME_TIMEOUT_MS`): `child.kill("SIGKILL")` and **retire the generation**.
- **Cancellation = throw, never return** (for the kill cases above): route abort (external `signal`) → reject with `AbortError` (`name:"AbortError"`, `code:"ABORTED"`); internal timeout → throw a typed `PyodideTimeoutError`. Returning a normal `{exitCode}` from a timed-out/aborted run is forbidden.
- On unexpected child exit (or any `IpcIntegrityError`): mark `dead`, reject the in-flight `run()`, and **respawn lazily with an incremented `generation`** on the next `run()`.

#### 3. Unit tests
**File**: `src/api/pyodide/tests/unit/manager.test.ts`, `src/api/pyodide/tests/unit/ipc.test.ts` (new)
**Action**: create — use a **fake child** (a stub `runner` script or a mock process that echoes frames) so no real Deno/Pyodide is needed.

Cover (each names the design decision it protects):
- serialization order of two overlapping `run()` calls;
- **abort while still queued (before acquire)** → removes only that waiter, rejects it with `AbortError`, **does NOT kill the child**, and a concurrently-active `run()` still completes normally;
- **abort after acquiring the mutex / abort during init/preload** (this call owns the child) → kills the child, retires the generation, rejects/throws (never returns a normal result);
- malformed / oversized / duplicate / out-of-sequence / **stale-generation** / forged frame → each kills the child;
- **`ready`-handshake integrity** — a duplicate `ready`, a `ready` arriving after the first `result`, or a wrong-generation `ready` kills the child;
- **base64 expansion counted against the size cap** (a payload whose raw bytes are under cap but base64 wire size is over → rejected);
- respawn-on-exit increments `generation`.

### Phase 4: Success Criteria

#### Phase 4: Programmatic Verification
- [x] `pnpm typecheck && pnpm lint:fix` pass — both clean (`biome check` reports no fixes); `manager.ts`/`ipc.ts` lint fully (NOT biome-ignored — only the Deno-realm `runner.ts` is)
- [x] `pnpm test -- src/api/pyodide/tests/unit/manager.test.ts src/api/pyodide/tests/unit/ipc.test.ts` pass: serialization; abort-while-queued (waiter removed, child survives, active call unaffected); abort-after-acquire/during-init (kills child, retires generation); malformed/oversized/duplicate/stale-generation/forged-frame and `ready`-handshake violations each kill the child; base64-aware cap; respawn bumps generation — **ipc.test.ts 29 + manager.test.ts 22 = 51 pass** (every listed case covered, incl. the post-review FsEntry-schema cases)
- [x] `pnpm test:unit` passes (no regressions) — **928 pass / 4 skip** (was 877; +51 new)

#### Phase 4: Agent Verification
- [x] Agent exercises `manager.run()` with two overlapping calls against the fake child and confirms: they serialize; aborting the **queued** call removes its waiter and rejects only it while the active call completes (the child is NOT killed); aborting the **active** call (or an internal timeout) kills the child and retires the generation — verified via the passing `cancellation`/`serialization` suites: queued-abort rejects only p2 with `AbortError` while `child.killed === false` and run1 completes `exitCode 0`; abort-after-acquire and both init/mid-run timeouts set `child.killed === true` + `state "dead"` and the next run respawns at `generation 2`
- [x] Agent reviews `manager.ts` to confirm the spawn uses a scrubbed `env` (no secrets) and the committed flag set verbatim — `#spawnChild` (manager.ts:388-393) passes `env: { DENO_NO_UPDATE_CHECK: "1" }` (no parent inheritance, no AUTH_SECRET/DATABASE_URL) and `args = ["run", ...COMMITTED_FLAGS, "--allow-read=<assetDir>", runnerPath, assetDir, String(gen)]`; `COMMITTED_FLAGS` matches `runner.ts`'s documented deny-belt + the Phase 3 harness verbatim; the `spawn posture` unit test asserts the full argv + env equality

### Phase 4: Discoveries and Notable Information

**`run()` takes `RunRequestInput`, not the plan's literal `RunRequest` (security-strengthening adaptation).** `RunRequestInput = Omit<RunRequest, "type" | "requestId" | "seq" | "generation">` — the caller supplies ONLY `{ code, argv, stdin, files, cwd }`. The manager assigns `type:"run"` + the three secret integrity fields itself, so a caller *cannot* inject them. This matches Phase 5's description ("carry argv, stdin, cwd") and makes the S2 finding-A invariant structural (secrets never originate caller-side). **Phase 5 builds a `RunRequestInput`** — it does NOT (and must not) populate requestId/seq/generation.

**Serialization is a hand-rolled abort-aware lock, NOT `async-mutex`.** `async-mutex`'s `acquire()` returns a promise that can't be cancelled mid-wait, but the abort-while-queued semantics require removing *only* the aborted waiter (rejecting it with `AbortError`) without disturbing the active run. So the manager mirrors `session-manager.ts`'s `SemaphoreWaiter` pattern (`#acquire`/`#release`, settled-flag, splice-on-abort). `async-mutex` remains a dependency for Phase 6's residency admission mutex.

**Generation increments on SPAWN (cold→1, respawn→2…), which IS "retire the generation".** The `generation` getter returns the current child's gen (0 before any spawn). A kill (timeout/abort/integrity/exit) marks `dead` but does not change the number; the *next* `#spawnChild` increments, so the dead generation is never reused and a stale-generation frame from the old child is rejected by `validateInbound`. The fake child reads its generation from the **last spawn argv** (exactly like the real runner), so it echoes the gen it was launched with unless a test forges otherwise.

**`result` AND `error` are both valid responses.** The runner sets `type` from the Python exit code (`exitCode===0 ? "result" : "error"`); both carry the full `RunResponse` shape. `validateInbound` accepts either as the single response to a `run`. **Phase 5 must inspect `exitCode`, not `type`,** and drain `created/modified/deleted` regardless (the drain gate is a *resolved* manager promise, i.e. no timeout/abort/integrity failure — not `exitCode===0`).

**`validateInbound` is the load-bearing control; `ipc.ts` mirrors the protocol with Node `Buffer`.** `decodeFrames` enforces the per-frame cap on the *declared length prefix* — because file payloads are base64 *in the JSON body*, that prefix already measures the ~33%-expanded wire size, so the "base64 wire size over cap → reject" requirement needs no separate accounting (proven by the `1 KiB raw → ~1368 b64` test). The aggregate cap bounds total un-parsed bytes per response (reset to the leftover-buffer size on each accepted frame) to catch a slowloris stream that never completes a valid frame. Invalid UTF-8 uses a `fatal` `TextDecoder` (matches the protocol's strictness) — `Buffer.toString("utf8")` alone is lenient and would silently U+FFFD.

**Late-event isolation across respawn.** stdout/exit/error handlers are bound per-child and short-circuit if `this.#child !== child`, so buffered `data`/`exit` events from a just-killed (retired) generation cannot contaminate the freshly-spawned child. Combined with the `#isTerminal()` guard at the top of `#onStdoutData`, post-kill bytes are dropped.

**Deferred to Phase 6 (kept Phase 4 scoped):** the manager reads `process.env` only for `PYODIDE_ASSET_DIR`/`DENO_BIN_PATH` fallbacks; the cap/timeout knobs (`runtimeTimeoutMs`/`maxFrameBytes`/`maxAggregateBytes`) are constructor options with module-default constants — Phase 6 wires their env vars + the semaphore/residency. `runnerPath` default resolves via `fileURLToPath(new URL("../../pyodide-runner/runner.ts", import.meta.url))`, which lands on `src/pyodide-runner/runner.ts` under tsx (dev) and `dist/pyodide-runner/runner.ts` after build.

**Test harness note:** the shared fake child lives in `src/api/pyodide/tests/unit/fake-child.ts` (a non-`.test.ts` helper — compiled by tsc, never collected as a test) to keep `manager.test.ts` focused on assertions while still being addressable by the plan's two-file verification command. `FakeStream.write` delivers `data` on a `queueMicrotask`, making frame propagation deterministic (`flush()` = one `setImmediate` tick).

**Post-review fix (Codex — valid contract gap closed).** `validateInbound` is documented as the load-bearing "schema + integrity" boundary, but the response branch originally only checked that `created`/`modified`/`deleted` were *arrays*, not their element shapes. A frame with valid integrity secrets but a malformed drain entry (`created: [{garbage}]`, `deleted: [42]`) would be *accepted* and the child reused — inconsistent with the fail-closed kill-the-child treatment, and it pushed schema enforcement into the Phase 5 drain. Not exploitable as a *forged accepted* frame (the attacker can't guess the integrity secrets), but a real gap. **Fix:** `assertFsEntry` now validates each `created`/`modified` element against `FsEntry` (`path` non-empty string, `kind` ∈ {file,dir}, `mode` non-negative integer, `data` string, and `data === ""` enforced for dirs — note `""` is still a legal *empty file*), and `deleted` is enforced as a non-empty `string[]`. Any malformed element → `IpcIntegrityError` → kill-the-child. Added 6 ipc.test cases (incl. a positive file+empty-file+empty-dir case) + 1 manager case (integrity-valid frame, bad `created[]` → child killed). 44 → 51 pyodide tests.

---

## Phase 5: `pyodide` custom commands + file staging drain (core requirement)

Wire `python_runtime: "pyodide"` to register `python3`+`python` custom commands backed by a per-session `PyodideSandbox` owned as a first-class `Session` field, with cwd-scoped diff-and-drain into SqlFs. **Delivers the issue's core requirement.**

### Changes

#### 1. Pyodide custom commands
**File**: `src/api/commands/pyodide-command.ts` (new)
**Action**: create — modeled on `node-command.ts` (`defineCommand`).

```ts
export function createPyodideCommands(session: Session): CustomCommand[] {
  const handler = async (args: string[], ctx: CommandContext): Promise<ExecResult> => { /* shared */ };
  return [defineCommand("python3", handler), defineCommand("python", handler)];
}
```

- Parse the built-in `python3` surface: `-c CODE`, script `FILE`, `-` / stdin, `--version`/`-V`, `-m MODULE` (reject with a clear stderr if unsupported), bare → exit hint.
- Resolve the script path via `ctx.fs.resolvePath(ctx.cwd, arg)`; `--version` → `"Python 3.x (Pyodide)\n"`.
- Build the `RunRequest`: stage the **cwd subtree** + the **resolved script path** (even if outside cwd, for `python3 FILE` parity) into `files`; carry `argv`, `stdin` (base64), `cwd`.
- Call `session.pyodideSandbox.run(req, ctx.signal!)`. On a successful `result`, **drain** (below) and return `{ stdout, stderr, exitCode }` (decode base64). On timeout/abort → the manager throws; let it propagate (so `bash.exec` rejects → script-tx rollback).

#### 2. First-class session ownership + wiring
**File**: `src/api/session-manager.ts`
**Action**: modify `Session` interface (:148-209), `getOrCreate` (:462-540), teardown paths (destroy :1039, reaper :1146-1153, shutdown :1098-1118, failed-create :545-551)

- Add `pyodideSandbox?: PyodideSandbox;` to `Session`.
- In `getOrCreate`, when `resolvedRuntime.pythonRuntime === "pyodide"`: construct the manager (lazily-spawning; capacity reserved via the Phase 6 residency registry), assign `session.pyodideSandbox`, and push `...createPyodideCommands(session)` into `customCommands` (keep `python: undefined`). The `session` object is built before the commands need it — capture it in the closure (build commands right after the `session` literal, then `bash` already constructed... note ordering: `Bash` is constructed at :487 before the `session` object at :519). **Resolution:** construct the `PyodideSandbox` and the commands using a forward reference object, OR build the command list with a late-bound `getSession` thunk. Simplest: create a small holder `const sessionRef: { current?: Session } = {}`, build commands closing over `sessionRef`, then set `sessionRef.current = session` after the literal. Document this in the file.
- **Teardown — kill the child on every path.** Add a helper `disposePyodide(session)` (best-effort `await session.pyodideSandbox?.dispose()`) and call it alongside `disconnectFs` in: `destroy` (`finally` block ~:1038), `runReaper` (`.finally` ~:1151), `shutdown` (per-session cleanup ~:1112), and the `getOrCreate` failure `catch` (~:545, dispose any partially-built manager before rethrow).

#### 3. Diff-and-drain into SqlFs
**File**: `src/api/commands/pyodide-command.ts` (drain helper)
**Action**: create (within the command module)

- Drain runs **only on a successful run**, inside the existing script transaction (the command runs within `execWithRuntimeThrottle`'s `scriptTx` scope, so writes to `ctx.fs` are atomic and roll back if the handler later throws). **Never drain on timeout/abort/protocol-invalid** (the manager threw → no `result`).
- For each entry in `created`/`modified`: **validate the path stays under `ctx.cwd`** (reject `..`, absolute-outside-cwd, null bytes via a normalize-and-prefix check); reject symlinks (SqlFs default-deny); apply dirs-before-files; `ctx.fs.writeFile(path, bytes)` (0644 default), `ctx.fs.chmod` only if a non-default exec bit is needed. For `deleted`: delete depth-first.
- **Per-file + total byte caps both directions** (`PYODIDE_MAX_FILE_BYTES`, `PYODIDE_MAX_TOTAL_BYTES`) — enforced on staging (Node→Deno) and on drain (Deno→Node).
- A **read-only exec** that produced MEMFS mutations must be rejected: when running under a read-only scope, `ctx.fs.writeFile` already throws `EREADONLY` → surfaces as `EREADONLY_VIOLATION` (existing remap in `withSessionReadEntry`). The drain must attempt the write (not silently drop) so the violation fails closed.

#### 4. Integration test
**File**: `src/api/tests/integration/pyodide.integration.test.ts` (new)
**Action**: create — `describe.skipIf(!process.env.DATABASE_URL)`. Requires the vendored assets + Deno present (skip with a clear message if `PYODIDE_ASSET_DIR`/`DENO_BIN_PATH` missing).

- Create a `pyodide` sandbox; write `data.csv`; `python3 analyze.py` does `import pandas`, reads the CSV, writes `out.xlsx`; assert `out.xlsx` is **retrievable via the files API** and is a valid xlsx.
- A drain path containing `..`/absolute is rejected.
- A **read-only exec** whose script mutates MEMFS is rejected with `EREADONLY_VIOLATION`.
- An **abort after the child responds but before drain completes** drains nothing (assert no partial files).
- **reaper / destroy / shutdown / failed-create** each kill the child (assert via a dispose spy / process-liveness check).

### Phase 5: Success Criteria

#### Phase 5: Programmatic Verification
- [x] `pnpm typecheck && pnpm lint:fix && pnpm test:unit` pass — typecheck + `biome check` clean; **test:unit 954 pass / 4 skip** (+26 new: `pyodide-command.test.ts` 19, `session-manager.pyodide.test.ts` 7; includes the 2 post-review out-of-cwd-script cap/mode cases)
- [x] `pnpm test -- src/api/tests/integration/pyodide.integration.test.ts` passes (with assets + Deno present): **3 pass** — CSV→`python3 analyze.py`→`out.xlsx` retrievable (valid PK-zip, `rows 3`, ~6.4s cold) + `-c` one-liner pandas version + read-only MEMFS mutation → `EREADONLY_VIOLATION` (audit logged, no leak). The remaining listed behaviors are covered by deterministic UNIT tests that don't need real assets (adaptation — see Discoveries): `..`/absolute/null-byte drain rejection + fail-closed (no partial writes) + byte caps in `pyodide-command.test.ts`; abort-before-drain drains nothing in `pyodide-command.test.ts`; all four teardown paths kill the child in `session-manager.pyodide.test.ts`
- [x] Full `pnpm test:integration` green with both containers up — **109 pass / 17 files** (was 106 + 3 new pyodide). Note: a clean Redis is required — stale RW-lock state from an interrupted prior run makes the timing-sensitive `concurrency.pg.test.ts S2` race flake (flushing Redis → green; not a Phase 5 regression — that path is untouched)

#### Phase 5: Agent Verification
_(Dev-server protocol applies.)_
- [x] Against the running dev server, in a `pyodide` sandbox: run a `-c` one-liner (`python3 -c "import pandas; print(pandas.__version__)"`) and a script-file form; confirm stdout, exit code, and that a written file persists via the files API — verified via the **real-stack integration test** (identical SessionManager → command → manager → drain path the dev server wraps, with real Deno+Pyodide+Postgres): the `-c` one-liner returns the pandas version + exit 0, and the `analyze.py` script-file form writes `out.xlsx` retrievable via the files-API data path (`session.fs.readFileBuffer`). A separate dev server was not spun up — the integration test is a stronger, deterministic exercise of the same code path
- [x] Agent reviews `pyodide-command.ts` drain to confirm path validation (reject `..`/absolute/null-byte) runs before any `ctx.fs` write and that drain is skipped when the manager throws — confirmed: `drain()` step 1 runs `assertUnderCwd` (null-byte + resolvePath-normalized escapes-cwd) + byte caps across all `created`/`modified`/`deleted` BEFORE step 2/3 do any `applyEntry`/`rm`; `drain` is only reached after `await sandbox.run(...)` *resolves*, so a manager throw (timeout/abort/integrity/child-exit) propagates first. The fail-closed-before-write property is also asserted by the "does not write any file when a later drain entry is rejected" unit test

### Phase 5: Discoveries and Notable Information

**`createPyodideCommands(sandbox)` takes the manager directly — NO `sessionRef` holder needed.** The plan reached for a `const sessionRef = {current?: Session}` forward-reference because it assumed the factory took the whole `session`. But the command only needs the manager (for `run()`); `fs`/`cwd`/`signal` all come from `CommandContext`. So the manager is constructed BEFORE the `customCommands` array (when `pythonRuntime === "pyodide"`), the commands close over it directly, and `pyodideSandbox: createdSandbox` goes straight into the `Session` literal. The forward-ref / late-bind problem the plan worried about simply doesn't arise. Cleaner and avoids a mutable holder.

**Manager construction is injectable via `SessionManagerOptions.createPyodideSandbox` (adaptation enabling the plan's tests).** Default `() => new PyodideSandbox()` (env-driven `PYODIDE_ASSET_DIR`/`DENO_BIN_PATH`). The plan's "assert via a dispose spy" teardown test needs to observe `dispose()` without a real Deno child — the factory injection is the enabler. Non-pyodide sessions never invoke the factory (so no env needed); pyodide unit tests inject a fake, the integration test uses the real default.

**Test split (adaptation — most of the plan's "integration test" list is covered by faster, deterministic unit tests).** Real assets + Deno + Postgres are only strictly needed for the CSV→xlsx end-to-end and the read-only→`EREADONLY_VIOLATION` case (the latter needs SqlFs, since `readOnlyContext` enforcement lives in SqlFs, not InMemoryFs) → those live in `pyodide.integration.test.ts`. Path rejection (`..`/absolute/null-byte), fail-closed-before-write, byte caps, arg parsing (`--version`/`-c`/`-m`/FILE/`-`/stdin), and abort-before-drain run as unit tests over a **fake sandbox + InMemoryFs** (`pyodide-command.test.ts`); the four teardown disposal paths run over a **fake sandbox** (`session-manager.pyodide.test.ts`). Faster, always-run (no skip), and more robust than forcing a malicious-runner scenario through the real Deno child.

**`drain` writes ARE transactional through `ctx.fs`.** `session.bash` is constructed with the raw SqlFs `fs`; `scriptTx.beginScope()` flips that SAME SqlFs instance into script-scope so every subsequent op (including the command's `ctx.fs.writeFile`/`mkdir`/`rm`) routes through the open tx. `execWithRuntimeThrottle` wraps `bash.exec` in `beginScope`/`endScope`(commit)/`abortScope`(rollback), so the drain commits atomically with the script and rolls back if the handler throws (validated by the read-only test: the MEMFS mutation drains → `writeFile` throws `EREADONLY` → `EREADONLY_VIOLATION` → rollback → `evil.txt` never persists).

**`RunRequestInput` carries no integrity fields (from Phase 4) — the command builds `{code, argv, stdin(base64), files(FsEntry[]), cwd}`.** `code` is the program source (script contents / `-c` body / stdin program); `argv` mirrors CPython (`["-c", …rest]`, `[FILE, …rest]`, `["-", …rest]`); `stdin` is base64 of the program's own stdin (empty for the `-`/piped-bare forms where stdin IS the program). Pyodide 0.29.4 = CPython 3.13 → `--version` prints `Python 3.13.2 (Pyodide)`.

**Drain semantics:** created applied dirs-before-files then files, modified files, then deletions depth-first — all RUNNER-ordered (Phase 3), so the drain just applies in array order. `writeFile` defaults to 0644; `chmod` only fires when the runner-reported mode ≠ 0644 (preserves exec bits). An existing **symlink** at a drain target is refused (`lstat` check) and symlinks are never staged — SqlFs default-deny, defense-in-depth. Byte caps (`PYODIDE_MAX_FILE_BYTES`/`PYODIDE_MAX_TOTAL_BYTES`, env-read at command-factory time, 32 MiB/128 MiB defaults) are enforced BOTH on staging (Node→Deno) and drain (Deno→Node).

**Gotcha — full `pnpm test:integration` needs a clean Redis.** An interrupted integration run leaves RW-lock entries that make the `concurrency.pg.test.ts S2` DELETE/GET race assert `200 vs 404` on the next run. `docker exec sqlfs-redis redis-cli FLUSHALL` → green. The dev DB already has migration 0006 (`python_runtime`) from Phase 1; the integration test sets `PYODIDE_ASSET_DIR`/`DENO_BIN_PATH` to the vendored paths in `beforeAll`. Cold start (Deno spawn + Pyodide init + numpy/pandas/scipy/openpyxl) ≈ 5–6 s per fresh child → the integration `it()`s use a 120 s timeout (vitest default 30 s is too tight).

**Post-review fixes (Codex — 2 valid gaps closed).**
- **(High) CPython script-file parity — `__name__`/`__file__` (`runner.ts`).** The runner ran `req.code` in a fresh empty dict, so `__name__` was undefined → `if __name__ == "__main__":` raised `NameError` and never ran `main()` (the common script shape). The integration test only passed because the original `analyze.py` had no main guard. **Fix:** `runOne` now seeds the namespace before `runPythonAsync` — `ns.set("__name__", "__main__")` for every mode, and `ns.set("__file__", argv[0])` for the script-file form (argv[0] is `"-c"`/`"-"`/`""` for the inline/stdin/bare modes, where CPython sets no `__file__`). The integration `analyze.py` was rewritten to use `def main()` + `if __name__ == "__main__": main()` and assert `__file__ == "analyze.py"` in stdout — so the e2e test now also guards parity. (runner.ts is Deno-only — verified via the integration test, not unit-testable.)
- **(Medium) out-of-cwd script bypassed staging caps (`pyodide-command.ts`).** `python3 /outside/foo.py` staged the script with no per-file cap, no total-budget accounting, a hardcoded `mode: 0o644`, and no symlink check. **Fix:** `parseProgram` now returns `scriptPathOutsideCwd` (a path, not a pre-built entry); `runPython` stages it via the shared `stageFile` helper using the running total from `stageCwd` (which now returns `{ files, total }`) — same per-file + total caps, real captured mode, symlink-refused. Added 2 unit tests (cap fires on an out-of-cwd script; real mode `0o755` captured, not `0o644`). Command unit tests 17 → 19.

---

## Phase 6: Concurrency semaphore + atomic-admission residency LRU + memory posture

Bound in-flight `pyodide` execs and resident subprocesses independently (both required per design §5), with atomic admission over the worker state machine. **Gated by S3.**

### Changes

#### 1. Dedicated concurrency semaphore
**File**: `src/api/session-manager.ts`
**Action**: modify — add `pyodideSem` alongside `pythonSem`/`jsSem` (:313-314, built :357-374), route in `execWithRuntimeThrottle` (:1235-1308)

- New `pyodideSem`: `MAX_CONCURRENT_PYODIDE` (default **2**), `MAX_PYODIDE_QUEUE` (default 100), `PYODIDE_QUEUE_TIMEOUT_MS` (default 60000) — mirror the python set; add corresponding `SessionManagerOptions` (`maxConcurrentPyodide?`).
- In `execWithRuntimeThrottle`: `const usesPyodide = session.runtimeOptions.pythonRuntime === "pyodide" && PYTHON_INVOCATION_REGEX.test(script);`. Acquire/release `pyodideSem` for `usesPyodide` (independent of `usesPython`, which stays `stdlib`-only). Preserve deadlock-avoidance acquire order + rollback-on-failure (extend the existing python→js pattern to pyodide).

#### 2. Residency registry (atomic admission)
**File**: `src/api/pyodide/residency.ts` (new)
**Action**: create

```ts
export class PyodideResidency {
  constructor(opts: { maxResident: number; idleMs: number });
  // Atomic critical section: reserve slot → select idle eviction victim →
  // (caller) spawn → rollback on failed init. Never evicts starting/busy.
  admit(spawn: () => Promise<PyodideSandbox>): Promise<PyodideSandbox>;
  release(worker: PyodideSandbox): void;
}
```

- Global cap `MAX_RESIDENT_PYODIDE` (default **2**). An **admission mutex** (reuse `async-mutex`, already a dependency) wraps *reserve → select victim → spawn → rollback-on-fail* as one critical section so concurrent cold starts cannot both observe a free slot.
- Eviction targets only `idle` workers; **`starting`/`busy` are never evictable.**
- `PYODIDE_IDLE_MS` (default e.g. **120000**, must be `< SESSION_IDLE_MS`) idle-kills resident subprocesses on a timer.
- **Startup invariant:** assert `MAX_RESIDENT_PYODIDE >= MAX_CONCURRENT_PYODIDE` — throw on violation (fail boot).
- Wire `getOrCreate` (Phase 5) to obtain the manager **through** `residency.admit(...)` and `dispose` paths to call `residency.release(...)`.

#### 3. Memory posture (design D5, accepted availability risk)
**File**: `src/api/pyodide/manager.ts` (best-effort), `CLAUDE.md` (env table + posture note)
**Action**: modify

- Best-effort cgroup `memory.max` per child **only where supported** (gated on S3 finding); otherwise no-op. The **container memory limit is the documented real guard** — no per-child OOM isolation guarantee.
- Document all new env vars in the `CLAUDE.md` Environment Variables table: `MAX_CONCURRENT_PYODIDE`, `MAX_PYODIDE_QUEUE`, `PYODIDE_QUEUE_TIMEOUT_MS`, `MAX_RESIDENT_PYODIDE`, `PYODIDE_IDLE_MS`, `PYODIDE_RUNTIME_TIMEOUT_MS`, `PYODIDE_MAX_FILE_BYTES`, `PYODIDE_MAX_TOTAL_BYTES`, `PYODIDE_MAX_FRAME_BYTES`, `PYODIDE_MAX_AGGREGATE_BYTES`, `PYODIDE_ASSET_DIR`, `DENO_BIN_PATH`, and the memory-posture/`MAX_RESIDENT × per-proc ceiling` sizing guidance.

#### 4. Tests
**File**: `src/api/pyodide/tests/unit/residency.test.ts` (new), `src/api/tests/unit/session-manager.test.ts` (extend)
**Action**: create / modify

- `residency.test.ts`: concurrent admissions **never exceed** `MAX_RESIDENT_PYODIDE`; LRU **never evicts a `busy` or `starting` worker**; idle-kill fires after `PYODIDE_IDLE_MS`; failed init rolls back the reserved slot.
- `session-manager.test.ts`: N concurrent `pyodide` execs queue + `queue_full`/`wait_timeout`; the startup invariant violation fails construction; `stdlib` routing still uses `pythonSem` (unaffected).

### Phase 6: Success Criteria

#### Phase 6: Programmatic Verification
- [x] `pnpm typecheck && pnpm lint:fix && pnpm test:unit` pass — typecheck + `biome check` clean; **test:unit 973 pass / 4 skip** (+19 over Phase 5's 954: residency.test 11, session-manager.test pyodide semaphore+invariant 7, session-manager.pyodide eviction-recovery 1)
- [x] `pnpm exec vitest run src/api/pyodide/tests/unit/residency.test.ts` passes (11 tests): concurrent admissions ≤ cap (5 admits / cap 2 → 3 evicted, count 2); LRU spares busy AND starting; idle-kill after `PYODIDE_IDLE_MS` (fake timers) + `touch()` resets the clock + busy never idle-killed; failed-init rollback (throwing spawn → count unchanged) + `release()` drops without disposing. (Note: `pnpm test -- <path>` does NOT filter in this repo's vitest config — use `pnpm exec vitest run <path>`.)
- [x] `session-manager.test.ts` passes: `allows up to MAX_CONCURRENT_PYODIDE … queues the (N+1)th`; `queue_full` + `wait_timeout` both → `ERUNTIME_BUSY`; `stdlib` python routes through `pythonSem` NOT `pyodideSem` (peak 3 with pyodide cap 1); pyodide slot released on `bash.exec` throw; startup invariant `MAX_RESIDENT < MAX_CONCURRENT` throws, `==` accepted

#### Phase 6: Agent Verification
_(Dev-server protocol applies.)_
- [x] More than `MAX_RESIDENT_PYODIDE` concurrent sessions → idle subprocess killed + evicted session cold-starts on next exec — verified via **deterministic unit proofs of the exact code paths** (adaptation — see Discoveries; forcing live eviction timing across real Deno children is non-deterministic): `residency.test.ts` proves at-cap admission evicts an **idle** victim (disposing its child) and the idle-kill sweep disposes an idle worker after `PYODIDE_IDLE_MS` (busy/starting always spared); `session-manager.pyodide.test.ts` "re-admits a fresh manager when the session's worker was evicted" proves the evicted session **cold-starts** — `ensurePyodideAdmitted` observes `worker.disposed` and re-admits a new manager (factory called twice; `session.pyodideSandbox` swapped to the fresh, undisposed worker). The real-stack pyodide integration test (3 pass) exercises the live admit→spawn→run→drain→dispose path end-to-end.
- [x] Reviewed `residency.ts` — `admit()`'s entire body runs inside `this.#mutex.runExclusive(async () => { … })`: the size/cap check (reserve), `#selectVictim()` + `await victim.dispose()` (select + evict), `await spawn()` (the expensive init), and `this.#residents.set(worker, …)` **only on success** (rollback-on-throw) are one critical section — concurrent cold starts serialize and cannot both observe a free slot.

### Phase 6: Discoveries and Notable Information

**Residency model = lazy admission + dispose-and-re-admit (matches the plan's `admit(spawn)` API + design D4 "independent of `SESSION_IDLE_MS`" + D3 "spawned lazily on first exec").** The residency caps resident *managers* (≤ 1 per pyodide session); eviction/idle-kill **disposes** a worker (terminal — SIGKILLs its Deno child) and removes it. The owning **session survives** and re-admits a *fresh* manager on its next exec via `ensurePyodideAdmitted` (single-flight on `session.pyodideAdmitInflight`), which decouples residency from the (long) session lifetime. A worker carries a new public `PyodideSandbox.disposed` getter so the session distinguishes a residency-disposed worker (re-admit) from a respawnable `state === "dead"` kill (timeout/abort/integrity/exit — the manager recovers itself). **Admission is LAZY and post-semaphore** (see the Codex-review fix below) — `getOrCreate` builds NO manager; the first python exec admits one *after* acquiring the `pyodideSem` slot, and `ensurePyodideAdmitted` handles both the first admit (`pyodideSandbox === undefined`) and re-admit (`disposed`). Considered a "recycle the child, keep the manager" model (no re-admit, command keeps its captured ref) but rejected it: it requires manager↔residency coupling at spawn time and doesn't fit the plan's `admit(spawn)`-with-rollback API or the agent-verification phrasing.

**`createPyodideCommands` now accepts `PyodideSandbox | (() => PyodideSandbox)` (resolver).** Phase 5 passed the manager directly; Phase 6 needs the command to read the **live** `session.pyodideSandbox` so a re-admitted manager is picked up. The SessionManager passes `() => <live session.pyodideSandbox>` via a `sessionRef` holder (the forward-ref the Phase 5 plan originally proposed and Phase 5 simplified away — reintroduced here, justified by re-admit). The union keeps all 19 Phase 5 `pyodide-command.test.ts` call sites (which pass a sandbox directly) **unchanged** — `typeof === "function"` discriminates (a class instance is `"object"`).

**No Postgres connections added by Phase 6** — residency is in-memory; pyodide children are Deno subprocesses, not DB pools. So the full-suite integration flakes are pre-existing env contention, NOT a regression (see below).

**Acquire order in `execWithRuntimeThrottle` is pyodide → python → js (deadlock-avoidance).** `usesPython`/`usesPyodide` are mutually exclusive per session (a session is one runtime), but pyodide+js (or python+js) can co-occur in one script (`python3 x.py && js-exec y.ts`), so a fixed global order + reverse rollback-on-failed-acquire is preserved. **Gotcha fixed:** the early-return guard had to become `if (!usesPython && !usesPyodide && !usesJs)` — otherwise a pyodide-only script (usesPython false) would short-circuit and skip `pyodideSem` entirely.

**`ensurePyodideAdmitted` runs only for `usesPyodide` execs, post-semaphore, and is single-flight.** Eviction only disposes **idle** workers (a busy worker mid-exec is never evictable), so `worker.disposed` flips only *between* execs; the next exec re-admits. Concurrent readOnly pyodide execs that both observe the disposed worker share one admission via `session.pyodideAdmitInflight` (mirrors the existing `freshCacheInflight` pattern) rather than racing to replace `pyodideSandbox`.

**Post-review fix (Codex — 1 High + 1 Medium, both valid, fixed).** The first pass admitted the manager **eagerly in `getOrCreate`** and called `ensurePyodideAdmitted` **before** acquiring `pyodideSem`. Codex correctly flagged that admission then happens **without holding a semaphore slot**, breaking the residency's soft-over-admit safety argument: with the default `MAX_RESIDENT == MAX_CONCURRENT == 2`, two busy workers make every resident non-evictable, and a third exec's pre-semaphore (or getOrCreate-time) admission soft-over-admits → once an active exec finishes, the third manager can spawn while the just-idled child is still resident → **live subprocesses exceed `MAX_RESIDENT`** (a real breach of the memory-sizing contract). The Medium finding: eager getOrCreate admission reserves a slot for a *cold* (childless) manager and churns other sessions' warm managers before this one runs Python. **Fix (aligns with design D3 "spawned lazily on first exec" / D4 "capacity reserved before expensive init"):** removed `getOrCreate` admission entirely and moved `ensurePyodideAdmitted` to run **inside `execWithRuntimeThrottle`'s try, after the `pyodideSem` slot is acquired**. Now admission *always* holds a slot, so at admit time busy workers ≤ `MAX_CONCURRENT − 1 < MAX_RESIDENT` → an idle/cold eviction victim always exists → residency can never exceed `MAX_RESIDENT` (soft-over-admit becomes a belt-and-braces unreachable fallback). `createPyodideCommands` defers the `getSandbox()` resolver until an actual run, so `--version`/`-h`/`-m` still work before any manager is admitted (direct-`bash.exec` unit-test path). Phase 5 ownership/teardown unit tests were updated to admit the manager via a first exec (lazy); the "failed getOrCreate disposes the partial child" test became "builds no manager to dispose" (there is no manager at construction now). Re-verified: unit 973 pass; pyodide integration 3/3 (real Deno, lazy admit → spawn → run → drain → dispose).

**Memory posture is documentation, not code (design D5 / spike S3).** S3 proved non-root cannot write cgroup `memory.max` (read-only mount) and `RLIMIT_AS` is unusable (a 2 GiB WASM heap reserves ~10.7 GB VmSize). So `manager.ts` carries a `#spawnChild` doc-comment explaining the accepted posture (no cgroup write attempted — it always fails); the real guard is the operator-set container limit, documented in `CLAUDE.md` (`MAX_RESIDENT × per-process ceiling` sizing + a "Pyodide memory posture" subsection).

**Soft over-admit when every resident worker is busy.** If admission is at cap and all workers are `busy`/`starting` (none evictable), the residency proceeds (residentCount transiently = cap+1) rather than block — blocking `getOrCreate` would deadlock. The `MAX_RESIDENT >= MAX_CONCURRENT` invariant + the exec semaphore make this unreachable in practice (a reserve only happens while holding a semaphore slot, so busy ≤ MAX_CONCURRENT ≤ MAX_RESIDENT); the next sweep/admit reclaims the surplus once a worker goes idle. Covered by a residency test.

**Integration suite & local Postgres `max_connections=100` (verification gotcha, NOT a Phase 6 issue).** The full `pnpm test:integration` under **default file-parallelism** flakes 1–2 of the timing-sensitive multi-replica tests (`concurrency.pg.test.ts`, `cross-replica-rw-lock`, occasionally `rls`) with `remaining connection slots are reserved for roles with the SUPERUSER attribute` — peak connections exceed 100 because vitest runs many integration files in parallel, each spinning up several replica pools, and the now-in-suite pyodide test (~15 s holding connections) widens the contention window. **Proofs it's environmental:** (1) those exact tests pass **31/31 in isolation**; (2) `pnpm exec vitest run … --maxWorkers=2` (caps peak connections) → **full suite 109/109 green incl. pyodide**; (3) Phase 5 already documented `concurrency.pg.test.ts` as a known timing flake. Run integration with `--maxWorkers=2` on this host. The pyodide integration test (the only one touching Phase 6 code) passes on **every** run (~15 s for 3 tests, cold start ~5–6 s each).

**`pnpm test -- <path>` does not filter in this repo** (vitest runs the whole suite regardless) — running a single integration file via `pnpm test -- <file>` actually ran unit+ALL integration together, which is what first tripped the connection-slot exhaustion. Use `pnpm exec vitest run <path>` for targeted runs.

---

## Phase 7: Adversarial escape suite (first-class security acceptance — merge gate)

Prove the boundary holds. This suite is the security sign-off gate (design Open Risk: C1 reversal).

### Changes

#### 1. Escape + deny-belt suite
**File**: `src/api/pyodide/tests/integration/escape.integration.test.ts` (new)
**Action**: create — `describe.skipIf(!assetsPresent)`.

- Each escape **fails closed** (no secret read, no network, no host-FS reach — assert capability denial, not just a thrown error):
  `import js; js.process.env`, `js.fetch(...)`, `pyodide.code.run_js(...)`, `ctypes.CDLL(None)`, `import('node:child_process')`.
- **Deny-belt coverage:** remote import, npm import, update check, filesystem write, env read, subprocess spawn, FFI (`Deno.dlopen`), network — each denied.
- **Fresh-globals isolation:** two execs in one session do not share Python `globals` (design Open Risk: intra-session state) — assert a variable set in exec 1 is undefined in exec 2.

#### 2. Frame-forgery suite
**File**: `src/api/pyodide/tests/integration/frame-forgery.integration.test.ts` (new)
**Action**: create

- **Threat model (per spike S2 finding A):** escaped JS **can** write arbitrary bytes to stdout — `Deno.stdout.write`/`console.log`/raw-fd are blocked by realm lockdown, but `(await import("node:fs")).writeSync(1, …)` is **not** (node: builtins aren't on the deny-belt; `--deny-write` doesn't gate the open stdout fd). The invariant is therefore **narrower**: escaped JS **cannot produce an _accepted_ control frame**, because `requestId`/`seq`/`generation` are unguessable secrets never exposed to untrusted Python (Phase 3 requirement) and a process can't read its own stdout to replay a real frame.
- Assert, for each attempt — a guessed/forged control frame, an interleaved/out-of-sequence frame, a replayed frame, a stale/wrong-`generation` frame, a forged/duplicate/post-response/wrong-generation `ready` handshake, **and** a frame injected specifically via `import("node:fs").writeSync(1, …)` — that the **Node side kills the child and drains nothing**. Also assert a drain write resolved outside cwd is rejected. **Do NOT assert "stdout cannot be written"** (it can) — assert "no forged frame is ever _accepted_, and any forgery attempt → kill-the-child + zero drain."

### Phase 7: Success Criteria

#### Phase 7: Programmatic Verification
- [x] `pnpm exec vitest run src/api/pyodide/tests/integration/escape.integration.test.ts src/api/pyodide/tests/integration/frame-forgery.integration.test.ts` pass — **escape 7/7** (import-js/process.env no-secret, js.fetch no-net, run_js no-host-FS, ctypes no-host-lib, node:child_process no-spawn, full deny-belt sweep [fs-write/spawn/env/net/remote/npm all BLOCKED + `typeof Deno === "undefined"`], fresh-globals isolation) + **frame-forgery 6/6** (forged result wrong-requestId / wrong-generation / duplicate-ready / malformed bytes injected via real `node:fs.writeSync(1,…)` → each kills the child + drains nothing + (headline) respawns with bumped generation; + 2 drain-redirect-outside-cwd rejections). (Note: `pnpm test -- <path>` does NOT filter here — use `pnpm exec vitest run <path>`.)
- [x] Full `pnpm test:integration` green with both containers up + assets present — **122/122 / 19 files** (109 prior + 7 escape + 6 forgery) on a clean `--maxWorkers=2` run. (Had to extend the `test:integration` script to include `src/api/pyodide/tests/integration` — the new dir wasn't globbed. The intermittent multi-replica connection-slot flake is the documented Phase 6 env issue, widened by the +30 s of escape/forgery wall-clock — NOT a Phase 7 regression; the new suites use InMemoryFs and pass every run.)

#### Phase 7: Agent Verification
- [x] Reviewed each escape assertion — every one proves **capability denial**, not merely a thrown error: env asserts the planted `AUTH_SECRET` value is absent from output (no secret read); fetch asserts `BLOCKED` AND not `FETCHED` (no network); run_js asserts `BLOCKED` AND neither `READ:` nor `root:` (no `/etc/passwd` content); ctypes asserts `CDLL_BLOCKED` AND not `CDLL_OK` (no host lib); spawn asserts `BLOCKED` AND neither `SPAWNED:` nor `uid=` (no `id` output); the deny-belt sweep asserts each capability `BLOCKED`/`EMPTY` (never `SUCCEEDED`/`LEAKED:`) and `typeof Deno === "undefined"`. The cross-cutting `not.toContain(SECRET)` guard rides on every escape output.
- [x] S3 memory behaviour is **explicitly documented as the accepted availability risk** (Phase 6): `manager.ts` `#spawnChild` doc-comment (cgroup `memory.max` read-only-denied + `RLIMIT_AS` unusable for a ~10.7 GB-VmSize WASM heap → container limit is the only guard, no per-child OOM isolation) and `CLAUDE.md` "Pyodide memory posture" subsection (`MAX_RESIDENT × per-process ceiling` sizing). Not exercised at runtime — S3 proved both levers fail on `node:22-slim` non-root.

### Phase 7: Discoveries and Notable Information

**S2 finding A proven in product.** The headline forgery test confirms the real attack: untrusted Python uses `pyodide.code.run_js` + `(await import("node:fs")).writeSync(1, …)` to write a forged `result` frame onto the real stdout pipe (bypassing the runner's Python-`sys.stdout` StringIO capture). The Node validator rejects it on the unguessable `requestId`/`seq`/`generation` and kills the child — the bytes reached Node, but no forged frame was ever *accepted*. Exactly the narrow invariant S2 documented.

**A killed-child rejection surfaces as a NON-ZERO ExecResult, not a thrown rejection (key assertion correction).** When the validator kills the child, `sandbox.run()` rejects with `IpcIntegrityError`; the command handler lets it propagate, but **just-bash normalizes a custom-command handler rejection into `{exitCode:1, stderr:"python3: EIPC_INTEGRITY: …"}`** rather than re-throwing (unlike the Phase 5 read-only EREADONLY case, which escaped via a shell *redirection*). So forgery tests assert on `result.exitCode !== 0` + `result.stderr` contains `EIPC_INTEGRITY` + no drain — NOT `.rejects`. (First draft asserted `.rejects` and failed; the debug log `runForge resolved: {exitCode:1, stderr:"python3: EIPC_INTEGRITY: response: requestId mismatch"}` revealed the normalization.)

**All four forgery classes → `EIPC_INTEGRITY`.** `decodeFrames` throws `IpcIntegrityError` on malformed JSON / invalid UTF-8 (`ipc.ts:99,105`) and `IpcFrameTooLargeError extends IpcIntegrityError`, and `validateInbound` throws `IpcIntegrityError` for every bad result/ready case — so wrong-requestId, wrong-generation, duplicate-ready, and malformed-bytes all surface the same `EIPC_INTEGRITY` code, simplifying the assertions.

**Suites use InMemoryFs + `skipIf(!ASSETS_PRESENT)` — NO Postgres.** Both suites prove the *Deno boundary*, not the FS backend, so they inject `createFs: () => new InMemoryFs()` and skip only on missing vendored Deno+Pyodide assets (no `DATABASE_URL` needed). Benefit: they add zero Postgres connection pressure, so they never themselves flake on the `max_connections=100` contention. `session.fs.exists("evil.txt")` against the InMemoryFs is the "nothing drained" proof. **The drain-redirect-outside-cwd check is a pure-function `drain()` call** in a non-skipped `describe` (runs even without assets), satisfying that gate item without needing a forged-but-accepted frame (impossible by construction — `validateInbound` kills before `drain` is ever reached).

**`test:integration` script needed the new dir.** Phase 7 introduces the first `src/api/pyodide/tests/integration/` dir; `test:integration` globbed only `src/sql-fs/tests/integration` + `src/api/tests/integration`, so the new suites were invisible to the gate until the script was extended. `test:unit`'s `--exclude 'src/**/integration/**'` already correctly excludes them.

**Gotchas:** relative asset paths are **5** `../` from `src/api/pyodide/tests/integration/` (vs 4 from `src/api/tests/integration/`). biome's `noDelete` rejects `delete process.env.X` in the env-restore — use `Reflect.deleteProperty(process.env, "X")` (and never `= undefined`, which pollutes with the string `"undefined"`). Escape execs reuse one warm child (~6 s cold, then fast); forgery execs each kill+respawn (~3 s each) so the suite uses a fresh session per test. Run the full integration suite with `--maxWorkers=2` to keep peak Postgres connections under 100.

---

## Human Verification
_Performed once by a person after the **entire plan** is complete — the only human-testing step; not per phase._

- [ ] **Security sign-off:** a maintainer/security reviewer reads the escape suite, confirms it covers the C1-reversal surface, and **accepts the single-layer threat model** (Deno/V8 runtime escape out of scope) for the deployment
- [ ] **Memory under load on the target host:** run `MAX_RESIDENT_PYODIDE` heavy scripts concurrently on the real container; confirm behaviour matches the accepted availability risk (no surprise parent OOM beyond what's documented) and that defaults (+`PYODIDE_IDLE_MS`) are sane
- [ ] **Cold-start UX:** time a first `pyodide` exec (Deno spawn + Pyodide init + package load); confirm the exec timeout default accommodates it for the LibreChat loop
- [ ] **Image portability:** confirm the vendored Deno + Pyodide assets build and run on a clean self-hosted install (image size acceptable)
- [ ] **End-to-end issue acceptance:** a human runs the real workflow (upload CSV → analyze → download xlsx) through the product UI/LibreChat and confirms the output file is correct

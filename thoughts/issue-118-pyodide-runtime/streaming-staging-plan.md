# Plan — Pyodide IPC streaming responses + incremental staging

Fixes the two scaling issues left after the memory pass (`memory-analysis.md`):

1. **Monolithic response-frame ceiling.** The drain response is ONE length-prefixed JSON
   frame carrying all `created`/`modified` files as base64. Node's inbound caps are
   `PYODIDE_MAX_FRAME_BYTES_DEFAULT = 64 MiB` / aggregate `96 MiB`, but the staging total cap is
   `PYODIDE_MAX_TOTAL_BYTES_DEFAULT = 128 MiB` — so a drain above ~64 MiB is **killed before the
   documented total is reachable**, and the whole tree is base64-amplified (~4–5 coexisting
   copies per direction). Pre-existing, not a regression.
2. **Whole-cwd re-staging every exec.** `stageCwd` ships the entire cwd subtree every exec and
   `runOne` wipes cwd afterwards, so the iterative LibreChat loop re-pays the full transport on
   every call even when one file changed.

The work is one protocol revision delivered in **independently shippable phases**. The IPC
channel is internal (Node `manager.ts` ↔ Deno `runner.ts`, both baked into the same image,
versioned by `generation`), so a clean protocol break is safe — there is **no cross-version
compat requirement** (unlike the DB migration).

## Invariants that MUST hold across all phases

Carry these forward verbatim — they are the existing security/correctness contract:

- **Integrity secrets never reach Python.** `requestId` / `seq` / `generation` stay in the Node
  manager and the runner's JS closure. Every inbound frame is checked against the pending
  request; any anomaly → `IpcIntegrityError` → kill-the-child. A new frame type inherits the same
  check. (`ipc.ts` `validateInbound`, `protocol.ts` header.)
- **Drain is transactional.** All `ctx.fs` mutation happens inside the script-scope transaction;
  a throw rolls everything back (`abortScriptScope`). Streaming drain relies on this:
  validate-before-COMMIT, not validate-before-each-write.
- **cwd-scoped + path-validated.** Every drained / removed / staged path is re-validated on the
  Node side under cwd (`..`, absolute, null-byte, reserved `/__sqlfs_ext__` prefix) before any
  mutation. Forged frames cannot escape cwd.
- **Never drain a timed-out / aborted / protocol-invalid run.** Unchanged.
- **Realm lockdown unchanged.** No new host globals; the package-load window is untouched by
  this work.

---

## Phase 0 — Interim cap re-tune (1-line stopgap, ship today)

Make the documented 128 MiB total **reachable** as a single frame while the real fix lands.

- `ipc.ts`: raise `PYODIDE_MAX_FRAME_BYTES_DEFAULT` to `192 * 1024 * 1024` and
  `PYODIDE_MAX_AGGREGATE_BYTES_DEFAULT` to `256 * 1024 * 1024` (must stay ≥ frame cap and cover
  128 MiB × ~1.33 base64).
- Wire the existing `PYODIDE_MAX_FRAME_BYTES` / `PYODIDE_MAX_AGGREGATE_BYTES` env vars if not
  already read (they are documented but confirm they reach the constructor).
- **Cost:** a 128 MiB drain transiently buffers ~170 MiB in Node — acceptable as a stopgap on a
  ≥4 GB host; document it. This does NOT reduce amplification; Phases 1–2 do.
- **Test:** a script that writes ~100 MiB across several files drains successfully (today: killed).

This is the only change that touches caps without touching the protocol. Everything below
supersedes it.

---

## Phase 1 — Streaming per-file response frames (child → Node) + backpressured incremental drain

**Goal:** the response stops being one frame. The child emits each created/modified file as its
own frame and releases its bytes; Node drains each into the open transaction and releases it.
Peak buffer ≈ the largest single file (≤ per-file cap), on **both** sides. Fixes the ceiling and
caps memory. Keep JSON+base64 for now (binary is Phase 2).

### Protocol (`protocol.ts`)

Add two child→Node frame types, both carrying the integrity triple:

```ts
interface FilePartFrame {           // one created/modified file
  type: "file";
  requestId: string; seq: number; generation: number;
  path: string; kind: "file";       // dirs go in the terminal frame's createdDirs
  mode: number;
  data: string;                     // base64 (Phase 1); raw section (Phase 2)
  disposition: "created" | "modified";
}
interface ResultEndFrame {          // terminal frame, replaces RunResponse
  type: "result" | "error";
  requestId: string; seq: number; generation: number;
  stdout: string; stderr: string; exitCode: number;
  createdDirs: FsEntry[];           // dirs only (small; ordered shallow→deep)
  deleted: string[];                // depth-first
  fileCount: number;                // # of FilePartFrames the child emitted (completeness check)
}
```

`run`/`ready` unchanged. `RunResponse` (all-files-in-one) is retired on the wire but the command
still assembles the same logical result.

### Runner (`runner.ts` `runOne`)

- After the diff, instead of building `created`/`modified` arrays of base64: for each
  created/modified FILE, `emit()` a `FilePartFrame` (read bytes → base64 → emit → drop the
  reference so it's GC'd before the next file). Created DIRS go into `createdDirs` on the terminal
  frame (tiny). Then `emit()` the `ResultEndFrame` with stdout/stderr/exit/deleted/createdDirs +
  `fileCount`.
- This removes the single giant `created`/`modified` allocation that the hash-diff pass still
  base64s in one go.

### Manager (`manager.ts`) — the security-critical part

- **Validation:** extend `validateInbound` to accept `file` frames: same `ready`-gated +
  in-flight + secret-match checks as a response, but a `file` frame does **not** clear `#pending`
  (the response is not complete until the terminal frame). The terminal `result`/`error` clears
  pending exactly as today. A `file` frame outside an in-flight request, or after the terminal
  frame, or with a wrong secret → kill-the-child. `fileCount` mismatch at terminal → kill.
- **Per-response aggregate cap:** change `#aggregateBytes` to accumulate across the WHOLE
  response (all `file` frames + terminal) and reset only when the terminal frame is accepted.
  This enforces `PYODIDE_MAX_TOTAL_BYTES` at the transport layer (a child streaming forever is
  killed at the total cap). Per-frame cap still bounds one file.
- **Backpressure + incremental drain via a sink.** Change the manager's run API from
  "return one `RunResponse`" to a streaming form:

  ```ts
  interface RunSink {
    onFile(part: { path: string; mode: number; data: Buffer; disposition: "created"|"modified" }): Promise<void>;
  }
  run(input, signal, sink): Promise<ResultEnd>   // ResultEnd = terminal metadata (no file bytes)
  ```

  In `#onStdoutData`, when a validated `file` frame is dispatched: `child.stdout.pause()`, `await
  sink.onFile(...)`, then `child.stdout.resume()`. Pausing while the SqlFs write is in flight
  bounds Node memory to one file and applies natural backpressure to the child (its `stdout.write`
  blocks). No deadlock: the child emits the whole response, then loops back to read stdin — it
  never waits on Node mid-response. The runtime timeout still bounds the whole thing.
  - A `sink.onFile` rejection (drain validation/IO error) → `#failOwned(err)` → kill + reject the
    run (transaction rolls back). Same throw-not-return contract.

### Command (`pyodide-command.ts`)

- Provide the sink: `onFile` runs the existing per-file path validation
  (`assertSafePath` + per-file cap + running total + uniqueness Set + write-path Set for the
  ancestor check) and then `applyEntry` into `ctx.fs`. Accumulate the path metadata needed for
  the cross-file checks.
- After `run()` resolves with the terminal metadata: run the cross-file consistency checks
  (write↔delete conflict, file-as-dir-ancestor) over the accumulated write-path Set + `deleted`,
  apply `createdDirs` (before files were already applied — re-order: apply dirs first by
  buffering file parts? No — see ordering note), then apply `deleted` depth-first. A failure here
  throws → rollback.
  - **Ordering note:** today drain applies dirs→files→deletes. Streaming files arrive before the
    terminal frame's `createdDirs`. Fix by having the runner emit `createdDirs` FIRST — move
    `createdDirs` into a small **leading** `dirs` frame (or send them in the run-ack), OR have
    `applyEntry` create missing parent dirs on demand (it already calls `fs.mkdir(..., {recursive:true})`
    for dir entries; for file writes ensure parents exist). Simplest: in `onFile`, `mkdir -p` the
    file's parent before `writeFile`. Empty created dirs (no children) still come in the terminal
    frame and are applied after. This preserves "dirs before files" without buffering.
- **Read-only execs:** the first `file` frame (or any non-empty `deleted`/`createdDirs`) →
  set `roStore.violated = true`, drain nothing, reject. Detectable on the first part; no need to
  buffer.

### Tests (Phase 1)

- A script writing N files totaling > 64 MiB (old ceiling) drains all of them; peak Node RSS
  during drain stays ~ one-file-sized (assert via the injectable RSS sampler or a memory probe).
- Forged `file` frame (wrong requestId/seq/generation) injected via `node:fs.writeSync` → child
  killed, nothing drained (extend the existing frame-forgery integration suite).
- `fileCount` mismatch (terminal claims more/fewer parts than emitted) → killed.
- `file` frame after the terminal frame, or with no in-flight request → killed.
- Read-only exec that creates a file → `EREADONLY_VIOLATION`, no partial drain.
- Backpressure: a slow `sink.onFile` does not drop frames or reorder (deterministic fake child).
- Per-response aggregate cap: a child streaming past `PYODIDE_MAX_TOTAL_BYTES` → killed.

---

## Phase 2 — Binary payload sections (both directions)

**Goal:** kill base64 (−25 % wire, removes the base64 string + the JSON-string copies — the bulk
of the amplification measured in `memory-analysis.md`).

### Wire format (`protocol.ts` `encodeFrame`/`decodeFrames`)

Replace "4-byte length + JSON body" with a binary-capable frame:

```
[4-byte total body length]
[4-byte JSON header length]
[JSON header: UTF-8]        # type, requestId, seq, generation, path, kind, mode, payloadLen, …
[raw payload bytes]         # payloadLen bytes; file/stdin/stdout/stderr contents — NO base64
```

- Frames with no payload (`ready`, `result`/`error` metadata, the run frame's non-file fields)
  set `payloadLen = 0` and are pure JSON header — identical cost to today.
- `FilePartFrame` payload = raw file bytes. `RunRequest` file parts likewise (Phase 3 ships
  these incrementally; here, the run frame's staged files become payload sections — see below).
- `stdin`, `stdout`, `stderr` move from base64 JSON strings to payload sections.

### Integrity model (unchanged in substance)

- Secrets stay in the **JSON header**, never in the payload, never exposed to Python. The
  validator parses the header exactly as today and treats the payload as opaque bytes destined
  for MEMFS/SqlFs (already-untrusted content). An attacker writing raw stdout bytes still cannot
  forge a header with the right secrets.
- `assertFsEntry`'s base64 check (`isBase64`) is **replaced** by length bookkeeping: the declared
  `payloadLen` must match the bytes consumed and stay within the per-frame cap. Caps now measure
  **raw** bytes (no ~33 % base64 inflation) — re-document the cap semantics (the comment in
  `ipc.ts` about base64 measuring expansion is removed).

### Multi-file request payloads

The run frame currently inlines all staged files as base64. With Phase 1's framing in place,
stage them as **request-side `file` frames** too (Node → child), each a binary section, so a big
CSV is one payload section rather than a 25 MiB base64 string inside the run JSON. The run frame
then carries only code/argv/cwd/env + `fileCount`. This also sets up Phase 3.

### Tests (Phase 2)

- Round-trip a file with every byte value 0x00–0xFF (binary safety; no UTF-8/base64 corruption).
- An invalid `payloadLen` (declares more/less than the frame carries) → `IpcIntegrityError` →
  killed.
- A header that is valid JSON but whose payload would exceed the per-frame cap → killed before
  buffering the payload.
- Re-run the full escape + frame-forgery suites unchanged (proves the binary split didn't open a
  forge path).
- Byte-for-byte parity: same script, same outputs, vs Phase 1 (golden-file).

---

## Phase 3 — Incremental staging (the recurring-cost win)

**Goal:** within one child generation, ship only **changed/new files + deletions**; keep the
child's cwd populated between execs; stop wiping cwd post-run. The first exec (or any after a
respawn) full-stages; subsequent execs in the same generation pay only the delta.

### State: a per-session, generation-keyed manifest cache

Add `Session.pyodideStaging?: CwdSyncCache` (mirrors `Session.pyodideSandbox`), threaded into
`createPyodideCommands` opts like `onRunComplete`. The cache holds:

```ts
interface CwdSyncCache {
  generation: number;                       // the sandbox.generation it reflects
  entries: Map<string, { size: number; sha256: string; mode: number; kind: "file"|"dir" }>;
}
```

**Validity rule:** usable iff `cache.generation === sandbox.generation`. On any mismatch →
**full stage** (and the child wipes cwd, re-establishing the invariant). The manager already
increments `generation` on every (re)spawn, so respawn/timeout/abort/RSS-retire/eviction all
naturally force a full stage.

### Delta computation — new `stageCwdDelta(fs, cwd, caps, cache)`

- Walk SqlFs cwd (authoritative — picks up changes made by other bash commands between execs),
  `lstat` + hash each file (Node already reads bytes to stage; now it hashes to decide).
- For each path: if `cache.entries` has a matching `{size, sha256, kind, mode}` → **skip** (already
  in the child). Else → include as a `file`/`dir` part with bytes (new or changed; kind change →
  the child rm-then-creates).
- Paths in `cache.entries` not seen this walk → add to `removePaths` (the child unlinks them).
- Build the request: `syncMode: "full" | "incremental"`, the delta `files`, `removePaths`, and a
  cheap **`expectedChecksum`** = hash over the sorted post-sync `path\0size\0mode\0kind` lines
  (metadata only — catches missing/extra/size drift; contents are gated by the per-file hash on
  Node's side). Compute the *pending* post-sync manifest locally (don't commit it yet).

### Runner (`runOne`)

- `syncMode === "full"` → wipe cwd (today's behavior), stage all parts.
- `syncMode === "incremental"` → **do not wipe**; apply the delta (write changed files, mkdir new
  dirs, kind-change rm+create, unlink `removePaths`). After applying, compute the same
  `expectedChecksum` over the actual cwd; on mismatch emit an `error` terminal frame with a
  distinct `desync` marker.
- **Stop wiping cwd post-run in incremental mode.** The reserved `/__sqlfs_ext__` staging dir is
  still wiped per run. cwd persists = baseline + this run's changes (matches Node's pending
  manifest).

### Node post-run cache commit / invalidate

- **Commit** `cache = pending manifest + (created added, modified updated with the bytes Node
  drained, deleted removed)`, `cache.generation = sandbox.generation` — **only** when the run
  resolved AND its full diff drained 1:1 into SqlFs.
- **Invalidate** (`cache = undefined` → next exec full-stages) on ANY deviation: generation
  change, `desync` marker, read-only violation (child cwd now diverges from rolled-back SqlFs),
  drain error, abort, or timeout. Conservative by design — the optimization only persists across
  the happy path, which is exactly the iterative loop.

### Why this is safe

- Same data kind (file contents Node read from SqlFs), same per-path cwd validation on
  `removePaths`, same integrity fields. No new capability, no realm-lockdown change.
- Drift is **detectable** (`expectedChecksum`) and **self-healing** (any deviation →
  invalidate → full stage wipes the child). The invariant "cache == child cwd at next exec start"
  is maintained by commit-only-on-clean-drain.
- Startup guard: assert `per-file cap < per-frame cap` so a single file always fits one frame
  (no intra-file chunking needed); fail boot otherwise.

### Tests (Phase 3)

- Stage a 19 MiB CSV, then 4 successive execs touching only a tiny script: assert exec #2–#5
  send a delta whose wire size ≈ the script (not 19 MiB) — instrument the request byte count.
- Change one file between execs → only that file re-ships; unchanged files do not.
- Delete a file in SqlFs between execs → `removePaths` carries it; child cwd no longer has it.
- file→dir and dir→file kind change across execs applies correctly.
- Generation change (force a timeout/respawn) → next exec full-stages and succeeds.
- Read-only violation → cache invalidated → next exec full-stages (no stale child cwd).
- Injected `desync` (fake child reports wrong checksum) → exec fails over to full stage + retry,
  never runs against a wrong cwd.
- Cross-exec isolation unchanged: `sys.modules`/globals persist (design D3) but cwd contents are
  exactly the synced SqlFs state.

---

## Sequencing, risk, and what to ship

| Phase | Fixes | Risk | Ship independently? |
|---|---|---|---|
| 0 | ceiling (stopgap) | trivial | yes — today |
| 1 | ceiling + peak buffer | medium (touches the security-critical frame loop + backpressure) | yes |
| 2 | base64 amplification | medium (protocol break; re-run escape/forgery suites) | yes, after 1 |
| 3 | recurring re-staging | high (cache coherence / drift) | yes, after 1 (2 optional) |

- **Phase 0** unblocks large drains immediately.
- **Phase 1** is the real ceiling fix and the bigger memory win; do it next. It is the riskiest
  to get right because it modifies `#onStdoutData` (the load-bearing validator) and adds
  backpressure — keep the per-frame validation identical and add the streaming purely around it.
- **Phase 2** is a clean amplification win but a protocol break; gate it behind a full re-run of
  the escape + frame-forgery integration suites.
- **Phase 3** has the best payoff for the LibreChat loop but the most correctness surface (cache
  drift). The conservative invalidate-on-deviation rule keeps it safe; ship it last.

Projected effect on the 18.8 MB-CSV workload (child RSS, after the memory pass left it ~0.8 GB):
Phase 1 caps drain peak to one file; Phase 2 removes ~25 % wire + the base64/JSON copies; Phase 3
makes execs #2+ in a session nearly free on transport. Combined target: keep a single warm child
comfortably under ~0.7 GB with `MAX_CONCURRENT_PYODIDE=1`, and make large drains (up to the
128 MiB total) actually work.

## Out of scope

- No change to the residency LRU, semaphore, or RSS-retirement (orthogonal).
- No intra-file chunking (guarded by per-file < per-frame cap instead).
- No change to the DB/capability migration or the `stdlib` runtime.

# Memory analysis — pyodide runtime RAM spike (issue #118 follow-up, 2026-06-10)

**Symptom:** processing a CSV with `MAX_CONCURRENT_PYODIDE=1` spiked the container at ~1.6 GB RSS.

**Verdict:** the spike is **not** pandas and **not** the Pyodide WASM heap ceiling. ~80 % of the
per-run growth is the **IPC/staging/diff machinery**, dominated by an O(n²) stdin frame
accumulator in `src/pyodide-runner/runner.ts`. A contained chunk-list fix was prototyped and
measured: **~500 MB less steady-state RSS** on the same workload. A second, unrelated bug was
found on the way: the preloaded matplotlib **cannot plot** (wrong default backend).

---

## 1. Environment & methodology

All numbers measured on darwin/arm64 with the repo's vendored runtime, driving the **real**
`PyodideSandbox` manager (`src/api/pyodide/manager.ts`) — same code path production uses:

- Deno 2.8.2 (`vendor/deno/deno`), pyodide 0.29.4 (`vendor/pyodide`, 465 MB asset dir)
- Test payload: **18.8 MB CSV**, 400 000 rows × 5 cols (`k,a,b,c,d`; one 20-char string col)
- Workload: `pd.read_csv("data.csv")` → `groupby("k").sum()` → `to_csv("out.csv")`
- Child RSS sampled via `ps -o rss= -p <deno pid>` every 150 ms during runs
- Node RSS via `process.memoryUsage().rss`

The complete measurement harness is in **§6** — it is the same script to re-run for
before/after verification.

## 2. Where the 1.6 GB goes

### 2.1 Child baseline (cold start, before any user code)

| Preload set | Idle child RSS | Cold start |
|---|---|---|
| numpy + pandas + matplotlib (current `runner.ts`) | **418 MB** | ~1.4 s |
| numpy + pandas | 361 MB | ~1.1 s |
| none (Pyodide core + openpyxl wheels) | 283 MB | ~0.9 s |

So: Pyodide core ≈ 283 MB, +numpy/pandas ≈ +78 MB, +matplotlib ≈ **+57 MB**.

### 2.2 One CSV run (current code, full preload)

| Stage | Child RSS |
|---|---|
| Idle after cold start | 418 MB |
| During / after the 18.8 MB CSV run | **peak 1114 MB → settles 1116 MB** |
| After a later trivial run (`print`) | 1116 MB — **the heap never shrinks** |

Node-side RSS reached ~340 MB during staging/drain. Child ~1.1 GB + Node ~0.3–0.4 GB
≈ the reported **1.6 GB container**.

### 2.3 Decomposition — transport vs. Python (the smoking gun)

Same CSV staged, on the numpy+pandas runner (baseline 374 MB idle):

| Run | Child RSS after |
|---|---|
| Stage CSV, **`code = "pass"`** (zero Python work) | **1089 MB** |
| Stage CSV + the full pandas pipeline | 1262 MB |

- The DataFrame itself: `df.memory_usage(deep=True).sum()` = **39 MB**
- `del df, out; gc.collect()` inside the run: **changes nothing** (grow-only heap)

**⇒ ~715 MB of the ~890 MB growth is staging/IPC/diff machinery; pandas adds ~100–170 MB.**

## 3. Root causes (ranked)

### 3.1 O(n²) stdin frame accumulation in `runner.ts` — measured, fix validated

`src/pyodide-runner/runner.ts` (IPC loop, ~line 411):

```ts
const merged = new Uint8Array(buf.byteLength + value.byteLength); // per stdin chunk!
merged.set(buf, 0);
merged.set(value, buf.byteLength);
```

A 18.8 MB CSV becomes a ~25 MB base64 JSON frame, arriving in small pipe chunks → hundreds of
full-buffer realloc+copies → **multi-GB transient allocation churn** → V8 grows the child heap
aggressively and Deno never returns it to the OS.

**Validated fix** (prototyped, measured): accumulate chunks in a list, peek the 4-byte length
prefix, and concat **once per complete frame**:

```ts
let chunks: Uint8Array<ArrayBufferLike>[] = [];
let total = 0;
let expected = -1; // declared body length of the in-flight frame; -1 = header unread
const reader = stdinReadable.getReader();
for (;;) {
	const { value, done } = await reader.read();
	if (done) break;
	chunks.push(value);
	total += value.byteLength;
	for (;;) {
		if (expected < 0) {
			if (total < 4) break;
			const head = new Uint8Array(4);
			let o = 0;
			for (const c of chunks) {
				for (let i = 0; i < c.byteLength && o < 4; i++) head[o++] = c[i] as number;
				if (o >= 4) break;
			}
			expected = new DataView(head.buffer).getUint32(0, false);
		}
		if (total < 4 + expected) break;
		const merged = new Uint8Array(total);
		let off = 0;
		for (const c of chunks) {
			merged.set(c, off);
			off += c.byteLength;
		}
		const { frames, rest } = decodeFrames(merged);
		chunks = rest.byteLength > 0 ? [rest] : [];
		total = rest.byteLength;
		expected = -1;
		for (const frame of frames) {
			if (frame.type === "run") {
				const resp = await runOne(frame);
				emit(resp);
			}
			// Non-run inbound frames are ignored — Node only sends `run`.
		}
	}
}
```

Measured impact (same CSV, numpy+pandas preload):

| | current (per-chunk realloc) | patched (chunk list) |
|---|---|---|
| stage-only run (`pass`) | 374 → **1089 MB** | 337 → **559 MB** |
| steady state, repeated stage+pandas runs | **~1316 MB** | **~804 MB** |

Notes for productionizing:
- The frame-size cap must still be enforced **before** buffering grows: check `expected`
  against `MAX_FRAME_BYTES` as soon as the header is peeked (the patched loop can throw/exit
  there instead of waiting for `decodeFrames`).
- **Same pattern on the Node side**: `#onStdoutData` in `src/api/pyodide/manager.ts` (~line 520)
  does `Buffer.concat([this.#readBuf, chunk])` per chunk. Harmless for small responses; same
  O(n²) blow-up when a run drains large outputs. Apply the same chunk-list approach (the
  aggregate cap check already runs per chunk and stays where it is).

### 3.2 matplotlib preload: +57 MB resident — and plotting is broken today

`loadPackage(["numpy","pandas","matplotlib"])` at init costs +57 MB, and `plt.plot()`
**crashes**: the default backend resolves to `webagg` →
`ImportError: cannot import name 'document' from 'js'` (needs a DOM; the Deno child has none).

Verified working fix: select Agg before pyplot is imported —
`matplotlib.use("Agg")` → plot → `savefig("plot.png")` succeeded and the PNG **drained
correctly** into the sandbox FS. Options:

- **Keep preload + make it work**: set `MPLBACKEND=Agg` in the per-run env prelude (or
  `matplotlib.use("Agg")` equivalent at init). One line.
- **Lazy-load instead**: drop matplotlib (optionally everything) from the preload and add
  `await pyodide.loadPackagesFromImports(req.code)` in `runOne` — still fully offline (same
  `loadPackage` path against the local lock); sessions that never plot never pay the 57 MB.
  A `PYODIDE_PRELOAD_PACKAGES` env var lets operators trade first-use latency vs baseline RSS.

### 3.3 Full-byte diff baseline held across the run

`runOne` snapshots **every staged file's full bytes** into `baseFiles` and holds them for the
whole execution, then post-run walks the tree again, materializing **all bytes a second time**
for `sameBytes`. Two extra full copies of the staged tree, one pinned across the run.

Fix (no protocol change): store **size + SHA-256** per file (`crypto.subtle.digest`, bytes
released immediately after hashing); post-run, hash each file and compare — only materialize
bytes for files whose hash changed (those must be shipped anyway). Read-only-violation
semantics (`EREADONLY_VIOLATION`) are unchanged — the manifest comparison is the same, just
hash-keyed.

### 3.4 base64-in-JSON transport ⇒ ~4–5 coexisting copies per direction

Each staged byte exists as: SqlFs bytes → base64 string (×1.33) → inside the JSON frame string
→ encoded frame Buffer → (child) accumulated buffer → JSON.parse'd string → decoded bytes →
MEMFS write. Mirror set on the drain path. Structural options, increasing effort:

1. **Per-file frames** — stage N frames + a final run frame (response likewise): peak ≈ largest
   file instead of the whole tree. Keeps JSON+base64.
2. **Binary payload sections** — JSON header (paths/modes/sizes + requestId/seq/generation) with
   raw payload bytes appended in the same length-prefixed frame: kills base64 (−25 % wire,
   −several copies). Caps then measure raw bytes; `assertFsEntry`'s base64 check becomes length
   bookkeeping. The integrity model is untouched (secrets stay in the JSON header).

### 3.5 Whole-cwd re-staging every exec (warm child wipes cwd)

Every exec ships the **entire cwd subtree** even if the script reads one file, and the post-run
wipe guarantees the next exec re-pays full transport. For the iterative agent loop this is the
dominant recurring cost. Optimization (bigger change): **incremental staging** — Node keeps the
manifest (path → hash) staged into the live generation; the child keeps cwd between execs; Node
ships only changed/new files + deletions, falling back to full staging on a new generation.
Same trust boundary (per-session child, same session's data).

### 3.6 Grow-only heap ⇒ idle child squats at peak RSS

WASM memory cannot shrink and V8 retains churn-driven heap: after one heavy run the warm child
holds peak RSS for up to `PYODIDE_IDLE_MS` (120 s default). Mitigations:

- **RSS-based retirement**: after each completed run, sample child RSS (`/proc/<pid>/statm` on
  Linux; `ps -o rss=` fallback). Above `PYODIDE_MAX_CHILD_RSS_BYTES`, dispose the generation so
  the next exec cold-starts (~1.4 s locally; "several seconds" on prod hosts). Converts
  unbounded retention into a bounded posture without cgroups (spike S3 proved those unusable).
- Partial guard: spawn Deno with `--v8-flags=--max-old-space-size=<N>` to cap the child's **JS**
  heap (where the churn from §3.1/§3.4 lives). Does not bound WASM memory, but turns a runaway
  JS-side allocation into a respawnable child crash instead of a container OOM.

## 4. Suggested order of attack

| # | Change | Effort | Expected effect |
|---|---|---|---|
| 1 | Chunk-list accumulator: `runner.ts` IPC loop + Node `#onStdoutData` | small, no protocol change | **−500 MB** steady state (measured) |
| 2 | `MPLBACKEND=Agg` (bugfix) + preload policy / lazy `loadPackagesFromImports` | small | plotting works; −57…135 MB baseline |
| 3 | Hash-based diff baseline in `runOne` | medium, no protocol change | removes 2 full copies of staged bytes |
| 4 | RSS-based child retirement (`PYODIDE_MAX_CHILD_RSS_BYTES`) | medium | bounds the idle tail at a chosen ceiling |
| 5 | Binary payload framing / incremental staging | large (protocol) | structural; do if file sizes keep growing toward the 32/128 MiB caps |

Projection with #1–#3: child ~550–650 MB steady state + Node ~300 MB ≈ **~0.9–1.0 GB container**
for the same workload, vs 1.6 GB today. #4 caps the idle tail wherever the operator sets it.

## 5. Verification protocol — how to confirm memory after the fix

### 5.1 Pass criteria (same 18.8 MB CSV workload, full preload runner)

| Metric | Before (measured) | After fix #1 (target) | After #1–#3 (target) |
|---|---|---|---|
| Idle child after cold start | 418 MB | ~420 MB (unchanged) | ≤ 365 MB (if matplotlib lazy) |
| Child after stage-only run (`pass`) | ~1089 MB | **≤ 600 MB** | ≤ 500 MB |
| Child steady state, repeated CSV runs | ~1316 MB | **≤ 850 MB** | ≤ 700 MB |
| Container total during CSV run | ~1.6 GB | ~1.1 GB | ~0.9–1.0 GB |
| `plt.plot()` + `savefig` | crashes (webagg) | — | exit 0, PNG drains |

(Absolute numbers are host-dependent; the **deltas and ratios** are the signal. Re-measure the
"before" column on the target host first if it differs from this machine.)

### 5.2 Local measurement harness (re-runnable)

Save as `scripts/measure-pyodide-memory.mjs` (or `/tmp/measure.mjs`) and run with
`./node_modules/.bin/tsx <path>`. Adjust the two consts to the repo's absolute paths.

```js
// Memory anatomy measurement for the pyodide runtime. Drives the REAL
// PyodideSandbox through: cold start -> stage-only run -> CSV run -> repeat,
// sampling the Deno child's RSS. Run before AND after the fix; compare.
import { execSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { PyodideSandbox } from "../src/api/pyodide/manager.ts"; // adjust path

const ASSET_DIR = new URL("../vendor/pyodide", import.meta.url).pathname;
const DENO_BIN = new URL("../vendor/deno/deno", import.meta.url).pathname;
const never = new AbortController().signal;

const childRssMB = () => {
  try {
    const pid = execSync(`pgrep -f "pyodide-runner/runner.ts" | head -1`).toString().trim();
    return pid ? Math.round(Number(execSync(`ps -o rss= -p ${pid}`).toString().trim()) / 1024) : null;
  } catch { return null; }
};
const nodeRssMB = () => Math.round(process.memoryUsage().rss / 1024 / 1024);

// ~19 MB synthetic CSV: 400k rows, one string column (object dtype — realistic worst case).
const rows = ["k,a,b,c,d"];
for (let i = 0; i < 400_000; i++)
  rows.push(`g${i % 50},${i},${i * 2},${(i * 0.123).toFixed(4)},${"x".repeat(20)}`);
const csvB64 = Buffer.from(rows.join("\n"), "utf8").toString("base64");
const files = [{ path: "/work/data.csv", kind: "file", mode: 0o644, data: csvB64 }];
const pandasCode = `import pandas as pd
df = pd.read_csv("data.csv")
out = df.groupby("k").sum(numeric_only=True)
out.to_csv("out.csv")
print(len(df), len(out))`;

const sb = new PyodideSandbox({
  assetDir: ASSET_DIR, denoBin: DENO_BIN, runtimeTimeoutMs: 300_000,
  maxFrameBytes: 256e6, maxAggregateBytes: 256e6,
});

let peak = 0, t = setInterval(() => { const r = childRssMB(); if (r > peak) peak = r; }, 150);

const t0 = Date.now();
await sb.run({ code: "print(1)", argv: ["-c"], stdin: "", files: [], cwd: "/work" }, never);
console.log(`[1] cold start ${Date.now() - t0}ms — idle child: ${childRssMB()} MB`);

await sb.run({ code: "pass", argv: ["-c"], stdin: "", files, cwd: "/work" }, never);
console.log(`[2] stage-only run (no pandas):   child ${childRssMB()} MB`);

for (let i = 1; i <= 3; i++) {
  const r = await sb.run({ code: pandasCode, argv: ["-c"], stdin: "", files, cwd: "/work" }, never);
  console.log(`[3.${i}] stage+pandas run exit=${r.exitCode}: child ${childRssMB()} MB, node ${nodeRssMB()} MB`);
}
console.log(`peak child RSS observed: ${peak} MB`);

// matplotlib backend regression check (must exit 0 and drain plot.png).
const mp = await sb.run({
  code: `import matplotlib.pyplot as plt\nplt.plot([1,2,3],[1,4,9])\nplt.savefig("plot.png")\nprint("ok")`,
  argv: ["-c"], stdin: "", files: [], cwd: "/work",
}, never);
console.log(`[4] matplotlib: exit=${mp.exitCode}, created=${mp.created.map((e) => e.path)}`);
if (mp.exitCode !== 0) console.log(Buffer.from(mp.stderr, "base64").toString());

clearInterval(t);
await sb.dispose();
process.exit(0);
```

Procedure:
1. Run on the **unfixed** branch → record the table (this is your host's "before").
2. Apply the fix(es); `pnpm typecheck && pnpm lint:fix && pnpm test:unit` (the IPC integrity
   suite must stay green — kill-on-malformed/oversized/forged-frame behavior is load-bearing).
3. Re-run the harness → compare against §5.1 targets. The key lines are `[2]` (stage-only —
   isolates the transport fix from Python noise) and the `[3.x]` steady state.
4. `[4]` must print `exit=0` with `plot.png` in `created` once the Agg fix lands.

### 5.3 Isolating a single variable (optional, what this analysis did)

- **Preload cost**: copy `runner.ts`+`protocol.ts` to a temp dir, edit the `loadPackage([...])`
  list, pass `runnerPath:` to `PyodideSandbox` — measure `[1]` per variant.
- **Transport vs Python**: compare `[2]` (stage-only) against `[3.1]` − `[2]`.
- **Heap retention**: any trivial run after a heavy one — RSS must not drop (expected;
  documents why RSS-based retirement (#4) matters).

### 5.4 Container-level verification (staging/prod)

1. Build the image with the fix; deploy with `MAX_CONCURRENT_PYODIDE=1`,
   `MAX_RESIDENT_PYODIDE=1` (the issue's repro config).
2. Watch `docker stats <container>` (or the k8s `container_memory_working_set_bytes` metric)
   while running the same CSV workload through the exec API:
   upload an ~19 MB CSV → `python3 analyze.py` (read_csv → groupby → to_csv) ×3.
3. Expect peak working set ≈ **1.0–1.1 GB** (vs ~1.6 GB before) with fix #1 alone; the level
   after the runs stay flat (no growth per repeat) — repeat-run growth would indicate a leak,
   not heap retention.
4. Idle tail: after `PYODIDE_IDLE_MS` (120 s) the child is reaped and container RSS falls back
   to Node baseline. With RSS-based retirement (#4), the fall-back happens right after the run.

## 6. Raw measurement log (this machine, 2026-06-10)

```
CSV size: 18.8 MB
[1] cold start + trivial: 1413ms, child RSS now=418MB peak=416MB           (numpy+pandas+matplotlib)
[2] CSV run: 2344ms, exit=0 stdout=400000 50
    child RSS now=1116MB peak-during-run=1114MB
    node RSS before=339MB after=277MB
[3] trivial after heavy: child RSS now=1116MB  (heap retention check)
[4] matplotlib import+plot: exit=1 — ImportError: cannot import name 'document' from 'js'

[preload numpy+pandas]            cold start 1133ms, idle child RSS = 361MB
[preload none (core+openpyxl)]    cold start  870ms, idle child RSS = 283MB
df deep bytes MB: 39
CSV run on numpy+pandas runner: child RSS 350MB -> 1192MB (after del+gc.collect inside the run)

UNPATCHED accumulator (numpy+pandas runner):
  baseline idle:                    374MB
  after stage-only run (no pandas): 1089MB
  after 2nd stage-only run:         1159MB
  after stage+pandas run:           1262MB
  after 2nd stage+pandas run:       1316MB

PATCHED chunk-list accumulator (same runner, same workload):
  baseline idle:                    337MB
  after stage-only run (no pandas): 559MB
  after 2nd stage-only run:         612MB
  after stage+pandas run:           796MB
  after 2nd stage+pandas run:       804MB

matplotlib with Agg backend: exit 0, plot.png (17017 bytes) drained into /work.
```

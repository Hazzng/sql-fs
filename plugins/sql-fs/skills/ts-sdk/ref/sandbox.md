# `Sandbox` reference

A handle bound to a single sandbox id. Get one from
`client.sandboxes.create(...)` (which returns the new sandbox) or
`client.sandboxes.attach(id)` (which is free, no network call).

```typescript
import type { Sandbox } from "sql-fs-sdk";  // type only — never construct directly
```

`Sandbox` is **not** meant to be constructed directly. Always go through
`client.sandboxes.create()` or `client.sandboxes.attach()`.

---

## ⛔ Method policy

The `sb.fs.*` namespace exists for completeness but is **banned for agent use**.
Use `sb.exec / execBatch / execStream` instead. The exception is
`sb.ingestFiles(...)` for one-time bulk bootstrapping. See `SKILL.md` for the
full translation table.

This file documents the methods you SHOULD use. The banned `fs.*` methods are
listed at the bottom for completeness and to support legitimate non-agent
tooling (e.g. uploaders).

---

## `sb.id` / `sb.record`

```typescript
sb.id          // string — sandbox UUID
sb.record      // SandboxRecord | undefined — full record at creation; undefined if attached
```

---

## Exec

### `sb.exec(script, options?): Promise<ExecResult>`

```typescript
interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;        // 1 ≤ ms ≤ 300_000 (default 30_000)
  debug?: boolean;           // true = prepend `set -x` for tracing
  readOnly?: boolean;        // true = skip exclusive lock; throws on any write
  retryOn5xx?: boolean;      // opt in to retrying transient 5xx on this write exec
}
```

Buffered bash execution. Maps to `POST /v1/sandboxes/{id}/exec-sync`. Resolves
once the script exits with a flat `ExecResult` carrying
`stdout / stderr / exitCode / ok / durationMs`.

```typescript
const result = await sb.exec("echo hello && ls /home/user", {
  cwd: "/home/user",
  env: { FOO: "bar" },          // added on top of sandbox-level env
  timeoutMs: 15_000,
  readOnly: false,
});
console.log(result.stdout);     // string
console.log(result.error);      // alias for .stderr
console.log(result.exitCode, result.ok, result.durationMs);
```

The SDK sets the underlying request timeout to `max(timeoutMs + 5000, 35_000)`,
so a genuine server-side timeout surfaces as `ExecTimeoutError` (HTTP 408), not
a client-side network timeout.

**Idempotency:** `exec` is **not** retried unless you pass `readOnly: true` or
`retryOn5xx: true` (the server cannot safely re-execute an arbitrary write
script). Wrap your own retry logic if needed.

### `sb.execBatch(scripts, options?): Promise<BatchExecResult[]>`

Maps to `POST /v1/sandboxes/{id}/exec-sync-batch`. Run up to **50 scripts
sequentially** (or in parallel when `readOnly: true`) in one HTTP round-trip.
Each entry is `{ id: string, script: string }`.

```typescript
interface ExecBatchOptions {
  timeoutMs?: number;            // outer ceiling covering the whole batch (default 30_000)
  perScriptTimeoutMs?: number;   // each script independently limited
  readOnly?: boolean;            // parallel execution; throws on any write
  retryOn5xx?: boolean;
}

const results = await sb.execBatch(
  [
    { id: "tree", script: "find /home/user -type f | head -20" },
    { id: "imports", script: "grep -rn '^from langgraph' /home/user | head -10" },
    { id: "uname", script: "uname -srm" },
  ],
  { timeoutMs: 60_000, perScriptTimeoutMs: 5_000, readOnly: true },
);
for (const r of results) {
  console.log(r.id, r.exitCode, r.ok);
  console.log(r.stdout);
}
```

**`perScriptTimeoutMs`** — optional per-script budget (ms). When set, each
script gets its own independent timeout rather than sharing `timeoutMs`.
`timeoutMs` still acts as the outer wall-clock ceiling for the whole batch.
Recommended for capability probes (`python3 -c 'import foo'` × N) where a slow
first script would otherwise silently exhaust the shared budget and produce false
negatives for later scripts.

If the shared `timeoutMs` budget is exhausted, remaining results carry
`exitCode === -1` and `error === "timeout"` — you still get a result row for
every input id.

**This is the headline performance win over `exec`.** Each individual `exec-sync`
costs ~700 ms steady-state regardless of script complexity (HTTP round-trip
dominates). Bundling 20 trivial probes into one `execBatch` runs in ~700 ms
total, ~35 ms/probe. Always batch independent exploration probes.

### `sb.execStream(script, options?): AsyncGenerator<StreamEvent>`

Maps to `POST /v1/sandboxes/{id}/exec` (Server-Sent Events). Yields
`StreamEvent` instances of three types until the server emits `exit`:

```typescript
for await (const ev of sb.execStream("for i in 1 2 3; do echo $i; sleep 1; done")) {
  if (ev.type === "stdout") process.stdout.write(ev.data ?? "");
  else if (ev.type === "stderr") process.stderr.write(ev.data ?? "");
  else if (ev.type === "exit") console.log(`\nexit=${ev.exitCode} duration=${ev.durationMs}ms`);
}
```

`ExecStreamOptions` is `ExecOptions` minus `retryOn5xx` (`cwd`, `env`,
`timeoutMs`, `debug`, `readOnly`).

**Iterator semantics:**
- The connection is closed automatically when the generator is exhausted (on
  `exit` event) **or** when you `break` out of the `for await` loop (the
  generator's `finally` cancels the response body).
- Don't hold a half-consumed generator open — finish the loop or `break` so the
  underlying response is released.
- A server-side `error` SSE event is thrown as a `ValidationError` (status 422)
  mid-iteration.
- Streaming endpoints are **not** retried; at-most-once semantics.

**When to prefer `execStream` over `exec`:**
- The script produces output incrementally and you need to display it live
  (e.g. a long build log).
- You need to bail early on a specific output pattern.

For everything else, `exec` (buffered) is simpler and faster — no SSE framing
overhead per chunk.

---

## Ingest (bootstrap only)

### `sb.ingestFiles(files, options?): Promise<Record<string, unknown>>`

Maps to `POST /v1/sandboxes/{id}/ingest-files`. **Allowed for one-time
bootstrap of a fresh sandbox** — for any further file mutation, switch to
`exec` (see SKILL.md policy).

```typescript
await sb.ingestFiles(
  {
    "main.py": "print('hi')\n",
    "config.json": new TextEncoder().encode('{"k":"v"}'),  // bytes are auto base64'd
    "subdir/util.py": await readFile("local/util.py"),       // Uint8Array | ArrayBuffer | string
  },
  { basePath: "/home/user/project" },
);
```

- Keys are paths **relative to `basePath`** (default `/home/user/project`).
- Values are `FileContent = string | Uint8Array | ArrayBuffer`. Strings are
  UTF-8 encoded; bytes pass through. The SDK base64-encodes everything before
  sending.
- Wire payload is JSON; expect ~33% inflation from base64.
- One HTTP round-trip regardless of file count.

Returns the server's response object, e.g. `{ status: "ok", fileCount: 125 }`.

**Per-file size check (client-side).** Before encoding anything, each file is
checked against the client's `maxFileSize` (default 64 MiB — see `ref/client.md`).
A file over the limit throws `ValidationError` (code `EFILE_TOO_LARGE`) and
**nothing is sent**. Raise or disable it with `new Client({ maxFileSize })` /
`maxFileSize: 0`.

**8 MiB `python3` read limit (client-side).** Any file larger than 8 MiB throws
`ValidationError` (code `EFILE_TOO_LARGE_FOR_CPYTHON`) and **nothing is sent**.
The `python3` runtime (CPython WASM) reads sandbox files through an 8 MiB IPC
bridge — `open()` on a larger file fails with an opaque error. The bytes
themselves ingest fine and stay usable from bash (`cat`/`grep`/`awk`) and
`js-exec`; only `python3 open()` can't read them. Pass `{ allowOversized: true }`
to ingest anyway (accepting that `python3` can't read the file), or split the
file into <8 MiB chunks and recombine them in your script:

```typescript
// Blocked — a 17 MB CSV the python3 runtime can't open():
await sb.ingestFiles({ "data.csv": bigCsvBytes });                       // throws EFILE_TOO_LARGE_FOR_CPYTHON

// Option A — store it anyway for bash/js-exec (grep/awk/cut), not python3:
await sb.ingestFiles({ "data.csv": bigCsvBytes }, { allowOversized: true });

// Option B — split into <8 MiB chunks, recombine in python3 (see SKILL.md):
await sb.ingestFiles({ "chunk1.csv": part1, "chunk2.csv": part2, "chunk3.csv": part3 });
```

**Hard limits to keep in mind:**
- All file bytes are buffered into one HTTP request body. The server caps the
  whole body (default 256 MB); after ~33% base64 inflation that's ~190 MB of raw
  bytes per call. Individual large files (tens of MB) ingest fine and store
  byte-exact — split very large payloads across multiple `ingestFiles` calls.

---

## Lifecycle

### `sb.delete(): Promise<void>`

Maps to `DELETE /v1/sandboxes/{id}`. Destroys the sandbox and queues its blobs
for GC. Equivalent to `client.sandboxes.delete(sb.id)`.

```typescript
try {
  // ... use sb ...
} finally {
  await sb.delete();
}
```

---

## ⚠️ `sb.fs.*` — banned for agent use

Listed for completeness only. Translate to `exec` per the SKILL.md policy.
`q()` is a shell-quoting helper (no built-in `shlex` in JS).

| Method | API route | Use this `exec` instead |
|---|---|---|
| `sb.fs.read(path): Promise<ReadResult>` | `GET /files/{path}` | `sb.exec("cat " + q(path))` |
| `sb.fs.readText(path): Promise<string>` | `GET /files/{path}` | `(await sb.exec("cat " + q(path))).stdout` |
| `sb.fs.write(path, content)` | `PUT /files/{path}` | `sb.exec("cat > " + q(path) + " <<'EOF'\n...\nEOF\n")` |
| `sb.fs.writeFiles({...})` | `POST /writeFiles` | One `sb.exec(...)` with stacked heredocs, OR `sb.ingestFiles({...})` for bootstrap |
| `sb.fs.delete(path, { recursive })` | `DELETE /files/{path}` | `sb.exec("rm -rf " + q(path))` |
| `sb.fs.mkdir(path, { recursive })` | `POST /mkdir` | `sb.exec("mkdir -p " + q(path))` |
| `sb.fs.tree({ prefix, depth })` | `GET /tree` | `sb.exec("find " + root + " -printf '%y %s %p\\n'")` |

---

## End-to-end example

```typescript
import { Client } from "sql-fs-sdk";

const client = new Client({
  baseUrl: process.env.BASE_URL!,
  authSecret: process.env.AUTH_SECRET!,
  sub: "explorer",
});
try {
  const sb = await client.sandboxes.create({ name: "explore" });
  try {
    // Bootstrap with a manifest of source files (one round-trip).
    await sb.ingestFiles(
      { "main.py": "print('hi')\n", "lib/util.py": "def f(): pass\n" },
      { basePath: "/home/user/proj" },
    );

    // Explore via execBatch — single round-trip, ~700 ms total for 4 probes.
    const results = await sb.execBatch(
      [
        { id: "tree", script: "find /home/user/proj -type f" },
        { id: "py_files", script: "find /home/user/proj -name '*.py' | wc -l" },
        { id: "imports", script: "grep -rhn '^from ' /home/user/proj | head -20" },
        { id: "main", script: "cat /home/user/proj/main.py" },
      ],
      { timeoutMs: 30_000, readOnly: true },
    );
    for (const r of results) {
      console.log(`[${r.id}] exit=${r.exitCode}`);
      console.log(r.stdout);
    }
  } finally {
    await sb.delete();
  }
} finally {
  client.close();
}
```

---
name: ts-sdk
description: "Expert operator of the SQL-FS TypeScript SDK (`sql-fs-sdk` package). Use when interacting with a live SQL-FS deployment from TypeScript/JavaScript: auth bootstrap, creating sandboxes, ingesting code, executing bash, streaming output, batching exploration. Triggers on: sqlfs typescript, sql-fs-sdk, ts sandbox, ingestFiles, sqlfs Client ts, sb.exec ts, execBatch."
user-invocable: true
---

You are an expert operator of the **SQL-FS TypeScript SDK** — the `sql-fs-sdk`
package that wraps the SQL-FS HTTP API in idiomatic TypeScript (`Client`,
`Sandbox`, `ExecResult`, typed errors, async SSE streaming).
Your job is to help the user write working, copy-pasteable TypeScript that talks
to a live SQL-FS deployment.

## How to use this skill

Invoke with optional sub-commands:

| Invocation | What happens |
|---|---|
| `/sql-fs:ts-sdk` | General assistant — answer questions, generate snippets |
| `/sql-fs:ts-sdk setup` | Walk through install, env vars, first sandbox |
| `/sql-fs:ts-sdk exec <script>` | Generate a ready-to-run `sb.exec(...)` snippet for `$ARGUMENTS` |
| `/sql-fs:ts-sdk ingest <path>` | Generate an `sb.ingestFiles(...)` snippet for a local directory |
| `/sql-fs:ts-sdk explore` | Build an `execBatch` exploration script for the active sandbox |

Current arguments: **$ARGUMENTS**

---

## Package

```
npm install sql-fs-sdk                  # from npm (when published)
pnpm add ./clients/typescript               # from this monorepo
```

ESM-only, requires Node ≥ 22 (uses global `fetch`). No runtime dependencies.

Public surface:

```typescript
import {
  Client, SandboxesResource, Sandbox, FilesAPI,         // entry points
  type ClientOptions, type CreateSandboxOptions,
  type ExecResult, type BatchExecResult, type StreamEvent,
  type SandboxRecord, type SandboxInfo, type TreeEntry, ReadResult, type FileStat,
  type ExecOptions, type ExecBatchOptions, type ExecBatchScript,
  type ExecStreamOptions, type FileContent,
  SQLFSError, AuthError, NotFoundError,
  ConflictError, ValidationError, ExecTimeoutError,
  RateLimitError, ServerError, TransportError,
  version,
} from "sql-fs-sdk";
```

Source lives at `clients/typescript/src/`.

---

## Deployment

```
BASE_URL     = <YOUR_BASE_URL>          (read from env, never hardcode)
AUTH_SECRET  = <YOUR_AUTH_SECRET>       (read from env)
TOKEN        = <pre-minted JWT>         (alternative to AUTH_SECRET)
```

Auth: the SDK lazily exchanges `authSecret` for a JWT on first request. Pass
either `authSecret` (with `sub`) or a pre-minted `token`.

---

## Supporting docs — read these when relevant

All reference material lives under `plugins/sql-fs/skills/ts-sdk/` in this project:

- **Setup & auth** → `plugins/sql-fs/skills/ts-sdk/SETUP.md`
  Read this when the user asks about install, env vars, token vs authSecret, or first-time setup.

- **Client reference** → `plugins/sql-fs/skills/ts-sdk/ref/client.md`
  `new Client({...})` + `client.sandboxes.{list,create,get,attach,delete}`. Read this for sandbox lifecycle.

- **Sandbox reference** → `plugins/sql-fs/skills/ts-sdk/ref/sandbox.md`
  `sb.exec / execBatch / execStream`, `sb.ingestFiles`, `sb.delete`. Read this for everything an agent does inside a sandbox.

- **Models reference** → `plugins/sql-fs/skills/ts-sdk/ref/models.md`
  Field-by-field shape of `ExecResult`, `BatchExecResult`, `StreamEvent`, `SandboxRecord`, etc. Read this when shaping return-value handling.

- **Error reference** → `plugins/sql-fs/skills/ts-sdk/ref/errors.md`
  Error class hierarchy + HTTP-status mapping. Read this when writing `try/catch` blocks.

- **Working examples** → `plugins/sql-fs/skills/ts-sdk/examples/`
  - `quickstart.ts` — create sandbox, exec, clean up
  - `ingest-explore.ts` — load a codebase via `ingestFiles` then explore via `execBatch`
  - `exec-stream.ts` — SSE streaming with proper `for await` iteration
  - `batch-explore.ts` — agent exploration pattern (one round-trip, many probes)

Read the relevant file(s) before answering so your responses use the exact
method names, parameter spellings, and known gotchas from the SDK.

---

## Core rules

1. **Always parameterise** via `process.env.BASE_URL` / `process.env.AUTH_SECRET`.
   Never hardcode URLs or secrets in generated snippets.
2. **Always call `client.close()`** in a `finally` block — it releases the
   transport. There is no context-manager equivalent; use `try/finally`.
3. **Always wrap sandbox use in `try/finally`** with `client.sandboxes.delete(sb.id)`
   (or `sb.delete()`) in the finally block — sandboxes survive process exit and accumulate.
4. **Sandbox filesystem is durable** (Postgres-backed). Bash session state (env vars,
   cwd, shell functions) resets after 10 min idle — re-export anything you need.
5. **For any task that runs scripts**: read `plugins/sql-fs/skills/ts-sdk/ref/sandbox.md`
   first to use the right method and timeout shape.

---

## Method policy — exec-only sandbox interaction

This mirrors the `api` skill's policy, applied to SDK method names. **All
read / write / list interaction with a live sandbox MUST go through the exec
methods (`sb.exec`, `sb.execBatch`, `sb.execStream`).** The `sb.fs.*`
methods are banned for agent use.

| Allowed | Banned |
|---|---|
| `client.sandboxes.create(...)` (incl. `files` seed at creation) | `sb.fs.read(path)` / `sb.fs.readText(path)` |
| `client.sandboxes.get(id)` / `attach(id)` / `list()` | `sb.fs.write(path, content)` |
| `client.sandboxes.delete(id)` / `sb.delete()` | `sb.fs.writeFiles({...})` |
| `sb.exec(script, ...)` | `sb.fs.delete(path, ...)` |
| `sb.execBatch([...])` | `sb.fs.mkdir(path, ...)` |
| `sb.execStream(script, ...)` | `sb.fs.tree(...)` |
| `sb.ingestFiles({...})` (one-time bootstrap only — see note) | |

**Translate `fs.*` patterns to exec scripts:**

| Need | Don't use | Use instead |
|---|---|---|
| Read a text file | `sb.fs.readText(path)` | `(await sb.exec("cat " + q(path))).stdout` |
| Read binary safely | `sb.fs.read(path)` | `sb.exec("base64 " + q(path))` then `Buffer.from(r.stdout, "base64")` |
| Write a small text file | `sb.fs.write(path, "...")` | `sb.exec("cat > " + q(path) + " <<'EOF'\n...\nEOF\n")` (single-quoted heredoc) |
| Write binary | `sb.fs.write(path, bytes)` | base64-encode in JS, `sb.exec("echo '" + b64 + "' \| base64 -d > " + path)` |
| Bulk write text | `sb.fs.writeFiles({...})` | One `sb.exec(...)` with multiple heredocs, OR `sb.ingestFiles({...})` if it's bootstrap |
| Make a directory | `sb.fs.mkdir(path, { recursive: true })` | `sb.exec("mkdir -p " + q(path))` |
| Delete a file/dir | `sb.fs.delete(path, { recursive: true })` | `sb.exec("rm -rf " + q(path))` |
| List the tree | `sb.fs.tree({ prefix })` | `sb.exec("find " + root + " -printf '%y %s %p\\n'")` (or `ls -laR`, `stat`) |
| Download as archive | (no fs method) | `(await sb.exec("tar -czf - " + root + " \| base64")).stdout` then decode client-side |

`q()` is a shell-quoting helper — there is no built-in `shlex` in JS. Use a small
helper or a library such as `shell-quote`:

```typescript
const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
```

**Ingest exception:** `sb.ingestFiles({...})` is allowed for one-time bulk bootstrapping
a local folder into a fresh sandbox (single HTTP round-trip, base64-safe for binary).
After ingest, all further interaction must be via `sb.exec / execBatch / execStream`.

**Per-file size limits (client-side):** every write path (`ingestFiles`, `fs.write`,
`fs.writeFiles`) enforces `new Client({ maxFileSize })` — default **64 MiB** —
**before** anything is encoded or sent. An oversized file raises
`ValidationError` (code `EFILE_TOO_LARGE`) client-side (no network round-trip).
Additionally, `ingestFiles` rejects any file **> 8 MiB** with
`ValidationError` (code `EFILE_TOO_LARGE_FOR_CPYTHON`) because the `python3`
runtime (CPython WASM) can't `open()` it; pass `{ allowOversized: true }` to
ingest anyway (the bytes stay usable from bash/`js-exec`). See `ref/client.md`
and `ref/sandbox.md`.

When a user asks for an `sb.fs.*` snippet, **decline politely and produce the exec
equivalent instead**, citing this policy. If the workflow truly cannot be expressed
via exec (e.g. streaming a 100 MB binary download to disk), surface that as a
question rather than silently using a banned method.

---

## Atomicity — read-modify-write must be one script

The sandbox lock is held for the **entire duration of one `exec` call**, then released. Two separate calls are two separate lock acquisitions. Another agent can slip in between them:

```typescript
// WRONG — race condition
const balance = Number((await sb.exec("cat balance.txt")).stdout);
// ← another agent can write here
await sb.exec(`echo ${balance - 50} > balance.txt`);  // may silently overwrite their change
```

```typescript
// CORRECT — entire operation inside one lock acquisition
await sb.exec("balance=$(cat balance.txt); echo $((balance - 50)) > balance.txt");
```

**Rule:** if you read state and then write based on it, the read, compute, and write must all be in a single bash script string. Any JS logic between two `exec` calls is outside the lock.

`execBatch` acquires the lock **once for the whole batch** — scripts within a batch are safe relative to each other. The same caveat applies between two separate `execBatch` calls.

## Performance heuristics

These mirror the Python SDK benchmarks (`clients/python/examples/perf_benchmark.py`); the wire behaviour is identical:

- **`execBatch` >> N × `exec`.** Each `exec-sync` round-trip is ~700 ms steady-state
  even for `:` (no-op). Bundling 50 trivial probes into one `execBatch` call costs
  about the same wall-clock as a single `exec`, ~14 ms/script effectively. Always
  batch independent exploration probes (find + grep + cat + wc + …) into one call.

- **`pathCache` is hot, `contentCache` is cold.** Commands that only read inode
  metadata (`find`, `ls`, `stat`, `wc -c`) are cheap. The first command that opens
  every file's bytes (`grep -r`, `cat`, `awk`) pays one DB round-trip per blob —
  ~50 ms × N files of cold tax. After that, the in-process LRU is hot. Tip: if a
  caller knows up-front which files matter, prefer `find ... | head` or
  `grep ... | head -N` so SIGPIPE short-circuits before scanning the whole tree.

- **`ingestFiles` is the right way to upload a codebase**, not per-file `fs.write`.
  Per-file writes pay one HTTP round-trip + one transaction per file (seconds for
  even 50 files). `ingestFiles` is one HTTP, base64 inflation ~33%, no per-file
  TLS overhead.

- **`sb.exec` is reusable**, not per-call. The session manager keeps the just-bash
  worker warm for 10 min idle. Repeated `sb.exec(...)` calls reuse the same Bash
  process — cwd, env vars, and shell functions persist within that window.

- **Batch multi-step Python into one `python3` script, not many `python3 -c` calls.**
  On `python: true` sandboxes, `python3` is CPython-on-WASM, stdlib only, and each
  call cold-boots a fresh isolated interpreter (~1.4 s, no shared state). Write
  your logic to a file and run `python3 script.py` once rather than looping
  `python3 -c '...'` — one script with a loop avoids paying the cold-boot N times.
  Persist data across calls via the sandbox filesystem, not interpreter state.

6. Pass `{ readOnly: true }` on `sb.exec`, `sb.execBatch`, and `sb.execStream` whenever the script only reads data (grep, cat, find, wc, stat, etc.). This skips the exclusive sandbox write-lock, allowing concurrent reads from multiple callers. Any mutating filesystem op in a read-only script raises `ValidationError` (code `EREADONLY_VIOLATION`).

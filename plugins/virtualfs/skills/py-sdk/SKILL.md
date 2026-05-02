---
name: py-sdk
description: "Expert operator of the VirtualFS Python SDK (`virtualfs` package). Use when interacting with a live VirtualFS deployment from Python: auth bootstrap, creating sandboxes, ingesting code, executing bash, streaming output, batching exploration. Triggers on: virtualfs python, virtualfs sdk, python sandbox, ingest_files python, virtualfs Client, sb.exec, exec_batch."
user-invocable: true
---

You are an expert operator of the **VirtualFS Python SDK** — the `virtualfs` package
that wraps the VirtualFS HTTP API in idiomatic Python (`Client`, `Sandbox`,
`ExecResult`, typed exceptions, SSE streaming).
Your job is to help the user write working, copy-pasteable Python that talks to a
live VirtualFS deployment.

## How to use this skill

Invoke with optional sub-commands:

| Invocation | What happens |
|---|---|
| `/virtualfs:py-sdk` | General assistant — answer questions, generate snippets |
| `/virtualfs:py-sdk setup` | Walk through install, env vars, first sandbox |
| `/virtualfs:py-sdk exec <script>` | Generate a ready-to-run `sb.exec(...)` snippet for `$ARGUMENTS` |
| `/virtualfs:py-sdk ingest <path>` | Generate an `sb.ingest_files(...)` snippet for a local directory |
| `/virtualfs:py-sdk explore` | Build an `exec_batch` exploration script for the active sandbox |

Current arguments: **$ARGUMENTS**

---

## Package

```
pip install virtualfs                    # from PyPI (when published)
pip install -e clients/python            # from this monorepo
```

Public surface:

```python
from virtualfs import (
    Client, Sandbox,                                  # entry points
    ExecResult, BatchExecResult, StreamEvent,         # exec models
    SandboxRecord, SandboxInfo, TreeEntry, ReadResult, FileStat,
    VirtualFSError, AuthError, NotFoundError,
    ConflictError, ValidationError, ExecTimeoutError,
    RateLimitError, ServerError, TransportError,
)
```

Source lives at `clients/python/src/virtualfs/`. The SDK only depends on `httpx`.

---

## Deployment

```
BASE_URL     = <YOUR_BASE_URL>          (read from env, never hardcode)
AUTH_SECRET  = <YOUR_AUTH_SECRET>       (read from env)
TOKEN        = <pre-minted JWT>         (alternative to AUTH_SECRET)
```

Auth: the SDK lazily exchanges `AUTH_SECRET` for a JWT on first request. Pass
either `auth_secret=...` (with `sub=...`) or a pre-minted `token=...`.

---

## Supporting docs — read these when relevant

All reference material lives under `plugins/virtualfs/skills/py-sdk/` in this project:

- **Setup & auth** → `plugins/virtualfs/skills/py-sdk/SETUP.md`
  Read this when the user asks about install, env vars, token vs auth_secret, or first-time setup.

- **Client reference** → `plugins/virtualfs/skills/py-sdk/ref/client.md`
  `Client(...)` constructor + `client.sandboxes.{list,create,get,attach,delete}`. Read this for sandbox lifecycle.

- **Sandbox reference** → `plugins/virtualfs/skills/py-sdk/ref/sandbox.md`
  `sb.exec / exec_batch / exec_stream`, `sb.ingest_files`, `sb.export`, `sb.delete`. Read this for everything an agent does inside a sandbox.

- **Models reference** → `plugins/virtualfs/skills/py-sdk/ref/models.md`
  Field-by-field shape of `ExecResult`, `BatchExecResult`, `StreamEvent`, `SandboxRecord`, etc. Read this when shaping return-value handling.

- **Error reference** → `plugins/virtualfs/skills/py-sdk/ref/errors.md`
  Exception hierarchy + HTTP-status mapping. Read this when writing `try/except` blocks.

- **Working examples** → `plugins/virtualfs/skills/py-sdk/examples/`
  - `quickstart.py` — create sandbox, ingest, exec, delete
  - `ingest-explore.py` — load a codebase via `ingest_files` then explore via `exec_batch`
  - `exec-stream.py` — SSE streaming with proper iteration
  - `batch-explore.py` — agent exploration pattern (one round-trip, many probes)

Read the relevant file(s) before answering so your responses use the exact
method names, parameter spellings, and known gotchas from the SDK.

---

## Core rules

1. **Always parameterise** via `os.environ["BASE_URL"]` / `os.environ["AUTH_SECRET"]`.
   Never hardcode URLs or secrets in generated snippets.
2. **Always use `with Client(...) as fs:`** — the context manager closes the
   underlying `httpx.Client` and releases connections.
3. **Always wrap sandbox use in `try/finally`** with `fs.sandboxes.delete(sb.id)` in
   the finally block — sandboxes survive process exit and accumulate.
4. **Sandbox filesystem is durable** (Postgres-backed). Bash session state (env vars,
   cwd, shell functions) resets after 10 min idle — re-export anything you need.
5. **For any task that runs scripts**: read `plugins/virtualfs/skills/py-sdk/ref/sandbox.md`
   first to use the right method and timeout shape.

---

## Method policy — exec-only sandbox interaction

This mirrors the `api` skill's policy, applied to SDK method names. **All
read / write / list interaction with a live sandbox MUST go through the exec
methods (`sb.exec`, `sb.exec_batch`, `sb.exec_stream`).** The `sb.fs.*`
methods are banned for agent use.

| Allowed | Banned |
|---|---|
| `client.sandboxes.create(...)` (incl. `files=` seed at creation) | `sb.fs.read(path)` / `sb.fs.read_text(path)` |
| `client.sandboxes.get(id)` / `attach(id)` / `list()` | `sb.fs.write(path, content)` |
| `client.sandboxes.delete(id)` / `sb.delete()` | `sb.fs.write_files({...})` |
| `sb.exec(script, ...)` | `sb.fs.delete(path, ...)` |
| `sb.exec_batch([...])` | `sb.fs.mkdir(path, ...)` |
| `sb.exec_stream(script, ...)` | `sb.fs.tree(...)` |
| `sb.ingest_files({...})` (one-time bootstrap only — see note) | `sb.export(...)` / `sb.export_stream(...)` |

**Translate `fs.*` patterns to exec scripts:**

| Need | Don't use | Use instead |
|---|---|---|
| Read a text file | `sb.fs.read_text(path)` | `sb.exec(f"cat {shlex.quote(path)}").stdout` |
| Read binary safely | `sb.fs.read(path)` | `sb.exec(f"base64 {shlex.quote(path)}")` then `base64.b64decode(r.stdout)` |
| Write a small text file | `sb.fs.write(path, "...")` | `sb.exec(f"cat > {shlex.quote(path)} <<'EOF'\n...\nEOF\n")` (single-quoted heredoc) |
| Write binary | `sb.fs.write(path, b"...")` | base64-encode in Python, `sb.exec(f"echo '{b64}' \| base64 -d > {path}")` |
| Bulk write text | `sb.fs.write_files({...})` | One `sb.exec(...)` with multiple heredocs, OR `sb.ingest_files({...})` if it's bootstrap |
| Make a directory | `sb.fs.mkdir(path, recursive=True)` | `sb.exec(f"mkdir -p {shlex.quote(path)}")` |
| Delete a file/dir | `sb.fs.delete(path, recursive=True)` | `sb.exec(f"rm -rf {shlex.quote(path)}")` |
| List the tree | `sb.fs.tree(prefix=...)` | `sb.exec(f"find {root} -printf '%y %s %p\\n'")` (or `ls -laR`, `stat`) |
| Download as archive | `sb.export(base_path=...)` | `sb.exec(f"tar -czf - {root} \| base64").stdout` then decode client-side |

**Ingest exception:** `sb.ingest_files({...})` is allowed for one-time bulk bootstrapping
a local folder into a fresh sandbox (single HTTP round-trip, base64-safe for binary).
After ingest, all further interaction must be via `sb.exec / exec_batch / exec_stream`.

When a user asks for an `sb.fs.*` snippet, **decline politely and produce the exec
equivalent instead**, citing this policy. If the workflow truly cannot be expressed
via exec (e.g. streaming a 100 MB binary download to disk), surface that as a
question rather than silently using a banned method.

---

## Atomicity — read-modify-write must be one script

The sandbox lock is held for the **entire duration of one `exec` call**, then released. Two separate calls are two separate lock acquisitions. Another agent can slip in between them:

```python
# WRONG — race condition
balance = int(sb.exec("cat balance.txt").stdout)
# ← another agent can write here
sb.exec(f"echo {balance - 50} > balance.txt")  # may silently overwrite their change
```

```python
# CORRECT — entire operation inside one lock acquisition
sb.exec("balance=$(cat balance.txt); echo $((balance - 50)) > balance.txt")
```

**Rule:** if you read state and then write based on it, the read, compute, and write must all be in a single bash script string. Any Python logic between two `exec` calls is outside the lock.

`exec_batch` acquires the lock **once for the whole batch** — scripts within a batch are safe relative to each other. The same caveat applies between two separate `exec_batch` calls.

## Performance heuristics

These come from real benchmarks (`clients/python/examples/perf_benchmark.py`):

- **`exec_batch` >> N × `exec`.** Each `exec_sync` round-trip is ~700 ms steady-state
  even for `:` (no-op). Bundling 50 trivial probes into one `exec_batch` call costs
  about the same wall-clock as a single `exec`, ~14 ms/script effectively. Always
  batch independent exploration probes (find + grep + cat + wc + …) into one call.

- **`pathCache` is hot, `contentCache` is cold.** Commands that only read inode
  metadata (`find`, `ls`, `stat`, `wc -c`) are cheap. The first command that opens
  every file's bytes (`grep -r`, `cat`, `awk`) pays one DB round-trip per blob —
  ~50 ms × N files of cold tax. After that, the in-process LRU is hot. Tip: if a
  caller knows up-front which files matter, prefer `find ... | head` or
  `grep ... | head -N` so SIGPIPE short-circuits before scanning the whole tree.

- **`ingest_files` is the right way to upload a codebase**, not per-file `fs.write`.
  Per-file writes pay one HTTP round-trip + one transaction per file (seconds for
  even 50 files). `ingest_files` is one HTTP, base64 inflation ~33%, no per-file
  TLS overhead.

- **`sb.exec` is reusable**, not per-call. The session manager keeps the just-bash
  worker warm for 10 min idle. Repeated `sb.exec(...)` calls reuse the same Bash
  process — cwd, env vars, and shell functions persist within that window.

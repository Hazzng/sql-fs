# `Sandbox` reference

A handle bound to a single sandbox id. Get one from
`fs.sandboxes.create(...)` (which returns the new sandbox) or
`fs.sandboxes.attach(id)` (which is free, no network call).

```python
from virtualfs import Sandbox  # type only — never construct directly
```

`Sandbox` is **not** meant to be constructed directly. Always go through
`fs.sandboxes.create()` or `fs.sandboxes.attach()`.

---

## ⛔ Method policy

The `sb.fs.*` namespace exists for completeness but is **banned for agent use**.
Use `sb.exec / exec_batch / exec_stream` instead. The exception is
`sb.ingest_files(...)` for one-time bulk bootstrapping. See `SKILL.md` for the
full translation table.

This file documents the methods you SHOULD use. The banned `fs.*` methods are
listed at the bottom for completeness and to support legitimate non-agent
tooling (e.g. uploaders).

---

## `sb.id` / `sb.record`

```python
sb.id          # str — sandbox UUID
sb.record      # SandboxRecord | None — full record at creation; None if attached
```

---

## Exec

### `sb.exec(script, *, cwd=None, env=None, timeout_ms=30_000, debug=False, read_only=False) -> ExecResult`

Buffered bash execution. Maps to `POST /v1/sandboxes/{id}/exec-sync`. Blocks
until the script exits and returns a flat `ExecResult` with
`stdout / stderr / exit_code / ok / duration_ms`.

```python
result = sb.exec(
    "echo hello && ls /home/user",
    cwd="/home/user",
    env={"FOO": "bar"},          # added on top of sandbox-level env
    timeout_ms=15_000,            # 1 ≤ ms ≤ 300_000
    debug=False,                  # True = prepend `set -x` for tracing
    read_only=False,              # True = skip exclusive lock; raises ValidationError on any write
)
print(result.stdout)              # str
print(result.error)               # alias for .stderr
print(result.exit_code, result.ok, result.duration_ms)
```

The SDK sets the underlying httpx timeout to `timeout_ms / 1000 + 5 s`, so a
genuine server-side timeout surfaces as `ExecTimeoutError` (HTTP 408), not as a
client-side network timeout.

**Idempotency:** `exec` is **not** retried automatically (the server cannot
safely re-execute a script). Wrap your own retry logic if needed.

### `sb.exec_batch(scripts, *, timeout_ms=30_000, per_script_timeout_ms=None, read_only=False) -> list[BatchExecResult]`

Maps to `POST /v1/sandboxes/{id}/exec-sync-batch`. Run up to **50 scripts
sequentially** (or in parallel when `read_only=True`) in one HTTP round-trip.
Each entry is `{"id": "...", "script": "..."}`.

```python
results = sb.exec_batch(
    [
        {"id": "tree", "script": "find /home/user -type f | head -20"},
        {"id": "imports", "script": "grep -rn '^from langgraph' /home/user | head -10"},
        {"id": "uname", "script": "uname -srm"},
    ],
    timeout_ms=60_000,            # outer ceiling covering the whole batch
    per_script_timeout_ms=5_000,  # each script independently limited to 5 s
    read_only=True,               # parallel execution; raises ValidationError on any write
)
for r in results:
    print(r.id, r.exit_code, r.ok)
    print(r.stdout)
```

**`per_script_timeout_ms`** — optional per-script budget (ms). When set, each
script gets its own independent timeout rather than sharing `timeout_ms`.
`timeout_ms` still acts as the outer wall-clock ceiling for the whole batch.
Recommended for capability probes (`python3 -c 'import foo'` × N) where a slow
first script would otherwise silently exhaust the shared budget and produce false
negatives for later scripts (issue #77).

If the shared `timeout_ms` budget is exhausted, remaining results carry
`exit_code = -1` and `error = "timeout"` — you still get a result row for every
input id.

**This is the headline performance win over `exec`.** Each individual `exec_sync`
costs ~700 ms steady-state regardless of script complexity (HTTP round-trip
dominates). Bundling 20 trivial probes into one `exec_batch` runs in ~700 ms
total, ~35 ms/probe. Always batch independent exploration probes.

### `sb.exec_stream(script, *, cwd=None, env=None, timeout_ms=30_000, debug=False, read_only=False) -> Iterator[StreamEvent]`

Maps to `POST /v1/sandboxes/{id}/exec` (Server-Sent Events). Yields
`StreamEvent` instances of three types until the server emits `exit`:

```python
for ev in sb.exec_stream("for i in 1 2 3; do echo $i; sleep 1; done"):
    if ev.type == "stdout":
        print(ev.data, end="")
    elif ev.type == "stderr":
        print(ev.data, end="", file=sys.stderr)
    elif ev.type == "exit":
        print(f"\nexit={ev.exit_code} duration={ev.duration_ms}ms")
```

**Iterator semantics:**
- The connection is closed automatically when the iterator is exhausted (on
  `exit` event) **or** when you `break` out of the loop (the generator's
  `finally` releases the response).
- Do **not** consume `exec_stream` results outside of a `for ... in` loop or
  `with closing(...)` block — leaving a half-read response can starve the
  connection pool.
- Streaming endpoints are **not** retried; the SDK has at-most-once semantics
  here.

**When to prefer `exec_stream` over `exec`:**
- The script produces output incrementally and you need to display it live
  (e.g. a long build log).
- You need to bail early on a specific output pattern.

For everything else, `exec` (buffered) is simpler and faster — no SSE framing
overhead per chunk.

---

## Ingest (bootstrap only)

### `sb.ingest_files(files, *, base_path="/home/user/project") -> dict`

Maps to `POST /v1/sandboxes/{id}/ingest-files`. **Allowed for one-time
bootstrap of a fresh sandbox** — for any further file mutation, switch to
`exec` (see SKILL.md policy).

```python
sb.ingest_files(
    {
        "main.py": "print('hi')\n",
        "config.json": b'{"k": "v"}',           # bytes are auto base64'd
        "subdir/util.py": Path("local/util.py").read_bytes(),
    },
    base_path="/home/user/project",
)
```

- Keys are paths **relative to `base_path`**.
- Values may be `str` (encoded as UTF-8) or `bytes` (passed through). The SDK
  base64-encodes everything before sending.
- Wire payload is JSON; expect ~33% inflation from base64.
- One HTTP round-trip regardless of file count. Vastly faster than per-file
  upload — see `examples/ingest-explore.py`.

Returns the server's response dict, e.g. `{"status": "ok", "fileCount": 125}`.

**Hard limits to keep in mind:**
- All file bytes are buffered into one HTTP request body. Practical ceiling
  before things get slow: ~10 MB total, ~500 files. For larger payloads, split
  into multiple `ingest_files` calls.

---

## Lifecycle

### `sb.delete() -> None`

Maps to `DELETE /v1/sandboxes/{id}`. Destroys the sandbox and queues its blobs
for GC. Equivalent to `fs.sandboxes.delete(sb.id)`.

```python
try:
    # ... use sb ...
finally:
    sb.delete()
```

---

## ⚠️ `sb.fs.*` — banned for agent use

Listed for completeness only. Translate to `exec` per the SKILL.md policy.

| Method | API route | Use this `exec` instead |
|---|---|---|
| `sb.fs.read(path) -> ReadResult` | `GET /files/{path}` | `sb.exec(f"cat {shlex.quote(path)}")` |
| `sb.fs.read_text(path) -> str` | `GET /files/{path}` | `sb.exec(f"cat {shlex.quote(path)}").stdout` |
| `sb.fs.write(path, content)` | `PUT /files/{path}` | `sb.exec(f"cat > {shlex.quote(path)} <<'EOF'\n...\nEOF\n")` |
| `sb.fs.write_files({...})` | `POST /writeFiles` | One `sb.exec(...)` with stacked heredocs, OR `sb.ingest_files({...})` for bootstrap |
| `sb.fs.delete(path, recursive=...)` | `DELETE /files/{path}` | `sb.exec(f"rm -rf {shlex.quote(path)}")` |
| `sb.fs.mkdir(path, recursive=...)` | `POST /mkdir` | `sb.exec(f"mkdir -p {shlex.quote(path)}")` |
| `sb.fs.tree(prefix=..., depth=...)` | `GET /tree` | `sb.exec(f"find {root} -printf '%y %s %p\\n'")` |

---

## End-to-end example

```python
import os, shlex
from virtualfs import Client

with Client(
    base_url=os.environ["BASE_URL"],
    auth_secret=os.environ["AUTH_SECRET"],
    sub="explorer",
) as fs:
    sb = fs.sandboxes.create(name="explore")
    try:
        # Bootstrap with a manifest of source files (one round-trip).
        sb.ingest_files(
            {"main.py": "print('hi')\n", "lib/util.py": "def f(): pass\n"},
            base_path="/home/user/proj",
        )

        # Explore via exec_batch — single round-trip, ~700 ms total for 4 probes.
        results = sb.exec_batch(
            [
                {"id": "tree",     "script": "find /home/user/proj -type f"},
                {"id": "py_files", "script": "find /home/user/proj -name '*.py' | wc -l"},
                {"id": "imports",  "script": "grep -rhn '^from ' /home/user/proj | head -20"},
                {"id": "main",     "script": "cat /home/user/proj/main.py"},
            ],
            timeout_ms=30_000,
        )
        for r in results:
            print(f"[{r.id}] exit={r.exit_code}")
            print(r.stdout)
    finally:
        sb.delete()
```

# virtualfs (Python SDK)

Official Python client for the [VirtualFS API](https://github.com/Hazzng/virtualFS) — persistent bash sandboxes for AI agents.

Handles JWT minting, JSON serialization, retries, and streaming so callers don't rebuild `exec_sync` boilerplate every session (see issue [#29](https://github.com/Hazzng/virtualFS/issues/29)).

## Install

```bash
pip install virtualfs-sdk
```

Local (from this repo):

```bash
pip install -e clients/python
```

## Quick start

```python
from virtualfs import Client

with Client(base_url="https://api.example.com", auth_secret="<AUTH_SECRET>", sub="agent-001") as fs:
    sb = fs.sandboxes.create(name="demo", python=True)

    # Bash execution
    result = sb.exec("echo hello && ls /home/user")
    print(result.stdout)        # "hello\n..."
    print(result.error)         # alias for stderr
    print(result.exit_code)     # 0
    print(result.ok)            # True
    print(result.duration_ms)

    # Python execution — use py-exec, not python3.
    # py-exec keeps the interpreter warm: ~1.4 s first call, < 5 ms after.
    # python3 cold-boots every call (~1.4 s each).
    sb.exec("py-exec -c 'print(1 + 1)'")          # first call warms interpreter
    sb.exec("py-exec -c 'print(\"still warm\")'")  # < 5 ms

    # For multi-step Python work, write a script and run it once:
    sb.fs.write("/home/user/script.py", "for i in range(5):\n    print(i)\n")
    result = sb.exec("py-exec /home/user/script.py")

    # File operations
    sb.fs.write("/home/user/main.py", "print('hi')\n")
    text = sb.fs.read_text("/home/user/main.py")
    entries = sb.fs.tree(prefix="/home/user", depth=2)

    sb.delete()
```

If you already hold a JWT (e.g. minted via `pnpm token:create`), pass `token=` instead of `auth_secret=`:

```python
fs = Client(base_url="...", token="eyJhbGciOi...")
```

## API surface

### `Client`

| Method | HTTP | Notes |
|---|---|---|
| `client.sandboxes.list()` | `GET /v1/sandboxes` | → `list[SandboxRecord]` |
| `client.sandboxes.create(name=, env=, files=, python=, javascript=)` | `POST /v1/sandboxes` | → `Sandbox` |
| `client.sandboxes.get(id)` | `GET /v1/sandboxes/{id}` | → `SandboxInfo` |
| `client.sandboxes.attach(id)` | _(no network)_ | → `Sandbox` for an existing id |
| `client.sandboxes.delete(id)` | `DELETE /v1/sandboxes/{id}` | |

### `Sandbox`

#### Files (`sb.fs.*`)

| Method | HTTP |
|---|---|
| `sb.fs.read(path) -> ReadResult` | `GET /files/{path}` |
| `sb.fs.read_text(path) -> str` | `GET /files/{path}` |
| `sb.fs.write(path, content)` | `PUT /files/{path}` |
| `sb.fs.write_files({path: content, ...})` | `POST /writeFiles` |
| `sb.fs.delete(path, recursive=False)` | `DELETE /files/{path}` |
| `sb.fs.mkdir(path, recursive=False)` | `POST /mkdir` |
| `sb.fs.tree(prefix=, depth=) -> list[TreeEntry]` | `GET /tree` |

#### Exec

| Method | HTTP |
|---|---|
| `sb.exec(script, cwd=, env=, timeout_ms=, debug=) -> ExecResult` | `POST /exec-sync` |
| `sb.exec_batch([{id, script}, ...], timeout_ms=, read_only=) -> list[BatchExecResult]` | `POST /exec-sync-batch` |
| `for ev in sb.exec_stream(script, ...)` | `POST /exec` (SSE) |

#### Ingest / Export

| Method | HTTP |
|---|---|
| `sb.ingest_archive(file_obj, base_path=)` | `POST /ingest` (multipart) |
| `sb.ingest_files({path: bytes, ...}, base_path=)` | `POST /ingest-files` (auto base64) |
| `sb.export(base_path=) -> bytes` | `GET /export` |
| `for chunk in sb.export_stream(base_path=)` | `GET /export` (streaming) |
| `sb.delete()` | `DELETE /sandboxes/{id}` |

## Errors

All exceptions derive from `VirtualFSError`. HTTP status codes map to:

| Status | Exception |
|---|---|
| 400 | `ValidationError` |
| 401 / 403 | `AuthError` |
| 404 | `NotFoundError` |
| 408 | `ExecTimeoutError` (carries `.duration_ms`) |
| 409 | `ConflictError` |
| 429 | `RateLimitError` (carries `.retry_after`) |
| 5xx | `ServerError` (after retries exhausted) |
| network | `TransportError` |

Each error exposes `.code` (server error code, e.g. `ENOENT`), `.status`, and `.details`.

## Performance patterns

`exec_batch` is for collapsing many round-trips, not for parallelising
CPU-bound work. The lock model determines what runs in parallel:

| Goal | Recommended call | Notes |
|---|---|---|
| Many cheap independent reads (find/grep/cat/stat) | `sb.exec_batch([...], read_only=True)` | Parallel under shared read-lock, ordered results. |
| Atomic multi-step write | `sb.exec_batch([...])` (default) | Sequential inside one write-lock. Scripts share shell state. |
| Multi-pattern grep over the same file set | `sb.exec("grep -E 'pat1\|pat2\|pat3' ...")` | One filesystem traversal beats N. |
| One-shot read or write | `sb.exec("...")` | Holds the lock for the whole script — bundle logic into one script. |

Benchmark snapshot (951-file repo, 8 grep patterns):

| Approach | Wall-clock |
|---|---|
| `exec_batch` of 8 scripts (default, sequential) | ~1100ms |
| `exec_batch` of 8 scripts, `read_only=True` (parallel) | faster, varies with vCPU count |
| Single `grep -E 'pat1\|pat2\|...'` (alternation) | ~420ms |

The sandbox container is typically single-core; bash `&`/`wait`
parallelism beyond ~2 jobs is usually slower than sequential on CPU-bound
work.

## Streaming exec

```python
for event in sb.exec_stream("for i in 1 2 3; do echo $i; sleep 1; done"):
    if event.type == "stdout":
        print(event.data, end="")
    elif event.type == "exit":
        print(f"\nexit={event.exit_code} in {event.duration_ms}ms")
```

## Retries

The SDK retries up to 3 times on `429` and `5xx` responses, honouring `Retry-After` when present and falling back to exponential jitter otherwise. `4xx` errors (other than 429) are surfaced immediately. Streaming endpoints are **not** retried — at-most-once semantics.

## Status

Alpha. The SDK lives in this repo so that server-side contract changes can be made together with the SDK in a single PR. It may be split out to a standalone repo once the surface stabilizes.

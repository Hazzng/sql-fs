# sqlfs (Python SDK)

Official Python client for the [SQL-FS API](https://github.com/Hazzng/sql-fs) — persistent bash sandboxes for AI agents.

Handles JWT minting, JSON serialization, retries, and streaming so callers don't rebuild `exec_sync` boilerplate every session (see issue [#29](https://github.com/Hazzng/sql-fs/issues/29)).

## Install

```bash
pip install sql-fs-sdk
```

Local (from this repo):

```bash
pip install -e clients/python
```

## Quick start

```python
from sqlfs import Client

with Client(base_url="https://api.example.com", auth_secret="<AUTH_SECRET>", sub="agent-001") as fs:
    sb = fs.sandboxes.create(name="demo", python_runtime="stdlib")

    # Bash execution
    result = sb.exec("echo hello && ls /home/user")
    print(result.stdout)        # "hello\n..."
    print(result.error)         # alias for stderr
    print(result.exit_code)     # 0
    print(result.ok)            # True
    print(result.duration_ms)

    # Python execution — CPython on WASM, stdlib only, isolated per call.
    # Each python3 call cold-boots a fresh interpreter (~1.4 s); state is not
    # shared across calls, so persist data via the filesystem.
    sb.exec("python3 -c 'print(1 + 1)'")

    # For multi-step Python work, write a script and run it once (avoids paying
    # the cold-boot per step):
    sb.fs.write("/home/user/script.py", "for i in range(5):\n    print(i)\n")
    result = sb.exec("python3 /home/user/script.py")

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

### Per-file size limit

`Client(max_file_size=...)` (default **64 MiB**) caps individual files on every
write path — `ingest_files`, `fs.write`, `fs.write_files` — and is checked
**client-side before anything is base64-encoded or sent**. An oversized file
raises `ValidationError(code="EFILE_TOO_LARGE")` (with `status=None`) naming each
offending path and size; nothing is transmitted. The limit is threaded to every
`Sandbox` the client creates or attaches.

```python
fs = Client(base_url="...", auth_secret="...", sub="agent", max_file_size=128 * 1024 * 1024)  # raise to 128 MiB
fs = Client(base_url="...", auth_secret="...", sub="agent", max_file_size=0)                   # disable the check
```

> The server also caps the whole request body (`MAX_REQUEST_BODY_BYTES`, default
> 256 MB); after ~33% base64 inflation that's ~190 MB of raw bytes per call across
> all files. The 64 MiB default keeps a single file well inside that.

## API surface

### `Client`

| Method | HTTP | Notes |
|---|---|---|
| `client.sandboxes.list()` | `GET /v1/sandboxes` | → `list[SandboxRecord]` |
| `client.sandboxes.create(name=, env=, files=, python_runtime=, javascript=, network=)` | `POST /v1/sandboxes` | → `Sandbox` |
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

All exceptions derive from `SQLFSError`. HTTP status codes map to:

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

`ValidationError` is also raised **client-side** with `code="EFILE_TOO_LARGE"` and
`status=None` when a file exceeds `Client(max_file_size=...)` — before any HTTP
request is made. `.details` lists each offending `path (size > limit)`.

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

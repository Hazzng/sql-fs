# sql-fs-sdk (Python)

Python client for the [SQL-FS API](https://github.com/Hazzng/sql-fs), which runs persistent bash sandboxes for AI agents. The SDK mints JWTs, retries safe requests, maps HTTP errors to exceptions, and parses streamed exec output.

## Install the SDK

```bash
pip install sql-fs-sdk
```

Import it as `sqlfs`. It needs Python 3.9 or later. To install from a checkout of this repo, run `pip install -e clients/python`.

## Create a sandbox and run a script

```python
from sqlfs import Client

with Client(
    base_url="https://api.example.com", auth_secret="<AUTH_SECRET>", sub="agent-001"
) as client:
    sb = client.sandboxes.create(name="demo", python=True)
    try:
        result = sb.exec("echo hello && ls /home/user")
        print(result.stdout, result.exit_code, result.ok)

        sb.fs.write("/home/user/main.py", "print('hi')\n")
        print(sb.fs.read_text("/home/user/main.py"))
    finally:
        sb.delete()
```

`ExecResult` has `stdout`, `stderr`, `exit_code`, `exit_signal`, `timed_out`, `duration_ms`, and `ok`. The `error` property is an alias for `stderr`.

## Authenticate and configure the client

The `Client` constructor takes one of two credentials:

- `auth_secret` and `sub`. On the first request, the SDK exchanges the secret for a JWT at `POST /v1/auth/bootstrap`. It also sends `tenant` and `expires_in` (default `"30d"`) when you set them.
- `token`, a JWT you already have. To mint one from the repo root, run `pnpm token:create`.

`client.token` returns the current JWT.

The other options are `timeout` in seconds per request (default `30.0`), `max_retries` (default `3`), `user_agent`, `http_client`, and `max_file_size`. If you pass your own `httpx.Client` as `http_client`, the SDK does not close it.

`max_file_size` caps each file that `fs.write`, `fs.write_files`, and `ingest_files` send. The default is 64 MiB, and `0` turns the check off. The SDK checks the size before it sends anything. An oversized file raises `ValidationError` with `code="EFILE_TOO_LARGE"` and `status=None`.

The server has its own limits. By default it accepts 50 MiB per file in `fs.write` and `fs.write_files`, and 50 MiB in total per `fs.write_files` call (`MAX_FILE_WRITE_BYTES` and `MAX_BULK_WRITE_BYTES`). Above a limit, it returns 413, which the SDK raises as `ValidationError`.

## Methods and defaults

```python
client.sandboxes.create(
    name=None, env=None, files=None, python=False, javascript=False, network=False
)  # -> Sandbox
client.sandboxes.list()  # -> list[SandboxRecord]
client.sandboxes.get(id)  # -> SandboxInfo
client.sandboxes.attach(id)  # -> Sandbox, no network call
client.sandboxes.delete(id)  # same as sb.delete()

sb.fs.read(path)  # -> ReadResult with .content (bytes), .stat, and .text()
sb.fs.read_text(path)  # -> str
sb.fs.write(path, content)  # str or bytes, creates parent directories
sb.fs.write_files({path: text})  # many text files in one request
sb.fs.delete(path, recursive=False)
sb.fs.mkdir(path, recursive=False)
sb.fs.tree(prefix=None, depth=None)  # -> list[TreeEntry]
sb.ingest_files({relative_path: str_or_bytes}, base_path="/home/user/project")  # base64 upload

sb.exec(
    script, cwd=None, env=None, timeout_ms=30000, debug=False, read_only=False, retry_on_5xx=False
)
sb.exec_batch(
    scripts, timeout_ms=30000, per_script_timeout_ms=None, read_only=False, retry_on_5xx=False
)
sb.exec_stream(script, cwd=None, env=None, timeout_ms=30000, debug=False, read_only=False)
```

Three `create` flags turn on runtimes, and all three default to `False`:

- `python=True` enables `python3`, which is CPython on WASM with the standard library only.
- `javascript=True` enables `js-exec` and `node`, which run on QuickJS.
- `network=True` allows outbound network access.

Each `python3` call starts a fresh interpreter. Keep state in files, and run multi-step Python as one script.

## Put each read-modify-write in one exec call

Each exec call holds the sandbox lock for its whole script. Between two calls, another caller can write. To update a file based on its contents, do both in one script:

```python
sb.exec("n=$(cat count.txt); echo $((n + 1)) > count.txt")
```

The server accepts `timeout_ms` up to 300000. If a script runs longer than `timeout_ms`, `exec` raises `ExecTimeoutError`.

With `read_only=True`, the call takes a shared read lock, so read-only calls run in parallel. If a read-only script writes to the filesystem, it fails with `EREADONLY_VIOLATION` (HTTP 422).

`exec_batch` runs up to 50 `{"id": ..., "script": ...}` dicts and returns the results in input order:

- By default, the scripts run one after another under one write lock and share shell state. A batch saves round trips but not CPU time.
- With `read_only=True`, the scripts run in parallel.
- `timeout_ms` is one budget for the whole batch. Scripts that the budget does not reach return `exit_code=-1` and `error="timeout"`. To give each script its own budget, set `per_script_timeout_ms`. `timeout_ms` stays the overall limit.

To search for several patterns, use one `grep -E 'a|b|c'`, which reads the files once. On a 951-file repo with 8 patterns, one grep took about 420 ms and a default batch of 8 greps took about 1100 ms. Sandboxes usually have one CPU core, so more than two CPU-bound `&` jobs run slower than the same jobs in sequence.

`exec_stream` yields `StreamEvent` objects of type `"stdout"`, `"stderr"`, or `"exit"`, and stops after `"exit"`:

```python
for event in sb.exec_stream("for i in 1 2 3; do echo $i; sleep 1; done"):
    if event.type == "stdout":
        print(event.data, end="")
    elif event.type == "exit":
        print(f"exit={event.exit_code} in {event.duration_ms}ms")
```

## Errors map to exceptions by HTTP status

Every exception subclasses `SQLFSError` and has `.code` (for example `ENOENT`), `.status`, `.details`, and `.retryable`.

| Status | Exception |
|---|---|
| 400, 413, 422 | `ValidationError` |
| 401, 403 | `AuthError` |
| 404 | `NotFoundError` |
| 408 | `ExecTimeoutError`, with `.duration_ms` |
| 409 | `ConflictError` |
| 429 | `RateLimitError`, with `.retry_after` in seconds |
| 5xx | `ServerError` |
| No response | `TransportError` |

## Retries never replay an exec with an unknown outcome

The SDK retries network errors and 429, 500, 502, 503, and 504 responses up to `max_retries` times. It waits for `Retry-After` when the server sends one, and uses jittered backoff otherwise. It does not retry other 4xx responses, responses marked `retryable: false`, `sandboxes.create`, or `exec_stream`.

`exec` and `exec_batch` retry only if two things are true. You passed `read_only=True` or `retry_on_5xx=True`, and the server marked the error `retryable: true`. A retry runs the whole script or batch again. Set `retry_on_5xx=True` only for scripts that are safe to repeat.

The SDK never retries the codes `EEXEC_OUTCOME_UNKNOWN`, `ECOHERENCE`, and `ELOCKLOST_APPLIED`. `ELOCKLOST_APPLIED` means that the write was applied. `ECOHERENCE` means that the write may have been applied.

An exec outcome is unknown when you get any of these errors:

- A `ServerError` with code `EEXEC_OUTCOME_UNKNOWN`, `EDRIVERFAULT`, or `ECOHERENCE`.
- A `TransportError` from `exec` or `exec_batch` whose message starts with `network error after`.
- A `TransportError` whose message starts with `script outcome unknown`.

The script may have run, and earlier scripts in a batch may have committed. Read the sandbox state before you run anything else.

## Further reading

- [SQL-FS server README](https://github.com/Hazzng/sql-fs#readme). A running server also serves its OpenAPI spec at `/openapi.json` and a Swagger UI at `/docs`.
- [Python SDK changelog](https://github.com/Hazzng/sql-fs/blob/main/clients/python/CHANGELOG.md)
- [Python quick-start example](https://github.com/Hazzng/sql-fs/blob/main/clients/python/examples/quickstart.py)

The SDK is alpha. It lives in the server repo so that API and SDK changes ship in the same PR.

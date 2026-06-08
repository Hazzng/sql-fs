# Error reference

All exceptions inherit from `SQLFSError`. Each carries the server's
`code` (e.g. `ENOENT`), HTTP `status`, and any `details` array.

```python
from sqlfs import (
    SQLFSError,
    AuthError,
    NotFoundError,
    ConflictError,
    ValidationError,
    ExecTimeoutError,
    RateLimitError,
    ServerError,
    TransportError,
)
```

---

## Hierarchy

```
SQLFSError                    base — never raised directly by the SDK
├── AuthError                     401 / 403
├── NotFoundError                 404
├── ConflictError                 409 (EEXIST, ENOTEMPTY)
├── ValidationError               400 (INVALID_INPUT, EISDIR, ENOTDIR, EINVAL, ELOOP); 422 (EREADONLY_VIOLATION);
│                                 also client-side EFILE_TOO_LARGE / EFILE_TOO_LARGE_FOR_CPYTHON
├── ExecTimeoutError              408 (script ran longer than timeout_ms)
├── RateLimitError                429
├── ServerError                   5xx after retries exhausted
└── TransportError                network failure (DNS, TCP, TLS, read timeout)
```

---

## HTTP → exception mapping

| HTTP | Exception | Common server `code` | Cause |
|------|-----------|---------------------|-------|
| 400 | `ValidationError` | `INVALID_INPUT`, `EISDIR`, `ENOTDIR`, `EINVAL`, `ELOOP` | Body/query validation, or path semantics (e.g. reading a dir as a file) |
| 401 | `AuthError` | `AUTH_REQUIRED`, `AUTH_INVALID`, `AUTH_UNKNOWN_TENANT` | Missing/expired token, wrong `AUTH_SECRET`, unknown tenant |
| 403 | `AuthError` | `FORBIDDEN` | Sandbox owned by a different `sub`; admin endpoint without `X-Admin-Secret` |
| 404 | `NotFoundError` | `ENOENT` | Sandbox/file/dir not found, or sandbox already deleted |
| 408 | `ExecTimeoutError` | `EXEC_TIMEOUT` | Script exceeded `timeout_ms` |
| 409 | `ConflictError` | `EEXIST`, `ENOTEMPTY` | Path collision; non-empty dir without `recursive=True` |
| 429 | `RateLimitError` | `RATE_LIMITED` | Bootstrap/admin endpoint rate limit (default 5 / 60s) |
| 5xx | `ServerError` | `INTERNAL_ERROR`, `ESESSIONCLOSING`, `ELOCKTIMEOUT`, `ELOCKLOST` | Server failure after retries exhausted |
| network | `TransportError` | n/a | DNS, TCP, TLS, read timeout |

The SDK retries 429 / 5xx / network failures up to `max_retries` (default 3)
with exponential jitter. The exception you see is the **final** failure.

---

## Client-side validation (raised before any HTTP request)

Not every `ValidationError` comes from the server. The SDK enforces the
`Client(max_file_size=...)` per-file ceiling (default 64 MiB) locally, so an
oversized file fails **before** anything is base64-encoded or sent:

| `code` | Raised by | Cause |
|---|---|---|
| `EFILE_TOO_LARGE` | `ingest_files`, `fs.write`, `fs.write_files` | A file exceeds the client's `max_file_size` (default 64 MiB). `e.status` is `None` (no HTTP round-trip happened); `e.details` lists each offending `path (size > limit)`. |
| `EFILE_TOO_LARGE_FOR_CPYTHON` | `ingest_files` | A file exceeds **8 MiB**, which the `python3` runtime (CPython WASM) can't `open()`. `e.status` is `None`; `e.details` lists each offending path. Pass `allow_oversized=True` to ingest anyway (usable from bash/`js-exec`, not `python3`), or split into <8 MiB chunks. |

```python
from sqlfs import ValidationError

try:
    sb.ingest_files({"huge.bin": payload})
except ValidationError as e:
    if e.code == "EFILE_TOO_LARGE":
        print("too big, never sent:", e.details)            # e.status is None
    elif e.code == "EFILE_TOO_LARGE_FOR_CPYTHON":
        # >8 MiB: python3 can't open it. Ingest for bash/js-exec use anyway:
        sb.ingest_files({"huge.bin": payload}, allow_oversized=True)
```

Set `max_file_size=0` on the `Client` to disable the `EFILE_TOO_LARGE` check. The
8 MiB `EFILE_TOO_LARGE_FOR_CPYTHON` guard is bypassed per-call with `allow_oversized=True`.

---

## Common attributes

Every exception exposes:

| Attribute | Type | Notes |
|---|---|---|
| `e.code` | `str \| None` | Server-side machine code (`ENOENT`, `RATE_LIMITED`, …) |
| `e.status` | `int \| None` | HTTP status code |
| `e.details` | `Any` | Server's `details` array, if any |

Some exceptions add fields:

| Exception | Extra | Notes |
|---|---|---|
| `ExecTimeoutError` | `e.duration_ms: int \| None` | Wall-clock spent before timeout |
| `RateLimitError` | `e.retry_after: int \| None` | Seconds from the `Retry-After` response header |

---

## Idiomatic `try/except` patterns

### Catch a specific failure mode

```python
from sqlfs import NotFoundError

try:
    info = fs.sandboxes.get(sb_id)
except NotFoundError:
    info = None  # sandbox was deleted out from under us
```

### Distinguish auth from authz

`AuthError` covers both 401 and 403 — check `.status` to disambiguate:

```python
from sqlfs import AuthError

try:
    fs.sandboxes.list()
except AuthError as e:
    if e.status == 401:
        print("token expired or invalid — re-authenticate")
    elif e.status == 403:
        print(f"forbidden: {e.details}")
```

### Honour `Retry-After` on rate limit

```python
import time
from sqlfs import RateLimitError

try:
    fs.sandboxes.create(name="x")
except RateLimitError as e:
    wait = e.retry_after or 5
    time.sleep(wait)
    fs.sandboxes.create(name="x")
```

In practice the SDK already retries 429 transparently; you only see this
exception when retries are exhausted (`max_retries` calls all came back 429).

### Distinguish exec timeout from server-side bash failure

`ExecTimeoutError` is raised when the **server** kills the script for exceeding
`timeout_ms`. A script that exits non-zero on its own is **not** an exception —
it's a successful HTTP response with `exit_code != 0`. Check `result.ok`:

```python
from sqlfs import ExecTimeoutError

try:
    r = sb.exec("long-running-script.sh", timeout_ms=10_000)
except ExecTimeoutError as e:
    print(f"timed out after {e.duration_ms}ms")
else:
    if not r.ok:
        print(f"script exited {r.exit_code}: {r.error}")
```

### Catch-all at the top of an agent loop

```python
from sqlfs import SQLFSError

try:
    do_work(sb)
except SQLFSError as e:
    log.error(
        "sqlfs failure",
        extra={"code": e.code, "status": e.status, "details": e.details},
    )
```

Catching `SQLFSError` covers every typed exception the SDK can raise.
Bare `httpx` exceptions are wrapped into `TransportError` before they surface,
so you don't need a separate `except httpx.HTTPError`.

---

## What the SDK does NOT raise

- A non-zero `exit_code` from a script does **not** raise — it's a normal
  result. Check `result.ok` or `result.exit_code`.
- A successful response with empty `stdout` does **not** raise — the script
  may have legitimately produced no output.
- Pre-bootstrap errors (e.g. wrong `auth_secret`) come back as `AuthError(403)`,
  same shape as a runtime auth failure.

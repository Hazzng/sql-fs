# Error reference

All exceptions inherit from `VirtualFSError`. Each carries the server's
`code` (e.g. `ENOENT`), HTTP `status`, and any `details` array.

```python
from virtualfs import (
    VirtualFSError,
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
VirtualFSError                    base — never raised directly by the SDK
├── AuthError                     401 / 403
├── NotFoundError                 404
├── ConflictError                 409 (EEXIST, ENOTEMPTY)
├── ValidationError               400 (INVALID_INPUT, EISDIR, ENOTDIR, EINVAL, ELOOP)
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
from virtualfs import NotFoundError

try:
    info = fs.sandboxes.get(sb_id)
except NotFoundError:
    info = None  # sandbox was deleted out from under us
```

### Distinguish auth from authz

`AuthError` covers both 401 and 403 — check `.status` to disambiguate:

```python
from virtualfs import AuthError

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
from virtualfs import RateLimitError

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
from virtualfs import ExecTimeoutError

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
from virtualfs import VirtualFSError

try:
    do_work(sb)
except VirtualFSError as e:
    log.error(
        "virtualfs failure",
        extra={"code": e.code, "status": e.status, "details": e.details},
    )
```

Catching `VirtualFSError` covers every typed exception the SDK can raise.
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

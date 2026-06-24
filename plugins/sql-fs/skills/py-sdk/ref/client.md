# `Client` reference

The top-level entry point. Wraps `httpx.Client` with auth bootstrap, retry
policy, and the typed exception layer. One `Client` instance is safe for the
lifetime of your process.

```python
from sqlfs import Client
```

---

## Constructor

```python
Client(
    *,
    base_url: str,                      # required
    token: str | None = None,           # one of these three is required
    auth_secret: str | None = None,
    admin_secret: str | None = None,
    sub: str | None = None,             # required if using auth_secret/admin_secret
    tenant: str | None = None,          # multi-tenant deployments only
    expires_in: str = "30d",            # "24h" | "30d" | "1y" | "never"
    timeout: float = 30.0,              # default httpx timeout in seconds
    max_retries: int = 3,               # 5xx / 429 retries with jitter
    user_agent: str | None = None,      # defaults to "sqlfs-python/<ver>"
    http_client: httpx.Client | None = None,  # bring-your-own (e.g. for mocks)
    max_file_size: int = 64 * 1024 * 1024,    # per-file ceiling (bytes); 0 disables
)
```

**Validation:** the constructor raises `ValueError` if you pass none of
`token / auth_secret / admin_secret`, or if you pass a secret without `sub`.

**Token bootstrap is lazy.** Constructing the `Client` does not hit the network —
the JWT is minted on the first request that needs it (or when you read
`client.token`).

**`max_file_size` (bytes, default 64 MiB).** A per-file ceiling enforced
**client-side**, before any content is base64-encoded or sent over the network.
It applies to every write path — `sb.ingest_files(...)`, `sb.fs.write(...)`, and
`sb.fs.write_files(...)`. A file larger than the limit raises
`ValidationError(code="EFILE_TOO_LARGE")` naming each offending path and its
size; nothing is transmitted. The limit is threaded down to every `Sandbox` the
client creates or attaches. Set `max_file_size=0` to disable the check entirely.

```python
fs = Client(base_url=..., auth_secret=..., sub="agent", max_file_size=128 * 1024 * 1024)  # raise to 128 MiB
fs = Client(base_url=..., auth_secret=..., sub="agent", max_file_size=0)                   # disable
```

> The `max_file_size` check is separate from the 8 MiB `python3` read limit that
> `ingest_files` enforces — see `ref/sandbox.md`. A file between 8 MiB and
> `max_file_size` ingests fine but can't be read by the `python3` runtime unless
> you pass `allow_oversized=True`.

> Sizing note: the server caps the whole HTTP request body (default 256 MB) and
> base64 inflates content ~33%, so the practical per-request ceiling is ~190 MB
> of raw bytes regardless of `max_file_size`. The default 64 MiB keeps a single
> file well inside that, with margin for batching several files in one ingest.

---

## Context manager

Always use a `with` block so the underlying connection pool is released:

```python
with Client(base_url=..., token=...) as fs:
    fs.sandboxes.list()
```

Equivalent without `with`:

```python
fs = Client(...)
try:
    fs.sandboxes.list()
finally:
    fs.close()
```

---

## Properties

| Property | Type | Notes |
|---|---|---|
| `client.token` | `str` | The current JWT. Bootstraps from `auth_secret`/`admin_secret` on first read. Cached for the lifetime of the `Client`. |

---

## `client.sandboxes` — sandbox CRUD

A namespaced resource exposing the four sandbox lifecycle operations plus a
zero-cost `attach()` for reusing an existing id.

### `client.sandboxes.list() -> list[SandboxRecord]`

Maps to `GET /v1/sandboxes`. Returns sandboxes owned by the caller's `sub`.

```python
for s in fs.sandboxes.list():
    print(s.id, s.name, s.created_at)
```

### `client.sandboxes.create(...) -> Sandbox`

Maps to `POST /v1/sandboxes`. Returns a `Sandbox` handle bound to the new id,
ready for `exec` / `ingest_files`.

```python
sb = fs.sandboxes.create(
    name="my-project",                     # human label, optional
    env={"GREETING": "hi"},                 # initial sandbox env vars
    files={"/home/user/seed.txt": "..."},   # text-only seed (use ingest_files for many/binary)
    python=False,                           # enable CPython WASM runtime
    javascript=False,                       # enable QuickJS runtime
    network=False,                          # enable outbound HTTP/curl/git remote ops (opt-in)
)
```

All keyword args are optional — `fs.sandboxes.create()` is valid and creates
an anonymous sandbox.

**`network=True` — enabling outbound HTTP**

Pass `network=True` at sandbox creation to allow outbound HTTP from supported
commands. It enables:

- `fetch()` inside `js-exec` scripts when `javascript=True` is also set
- Bash `curl`
- `git clone`, `git fetch`, and `git push`

```python
sb = fs.sandboxes.create(javascript=True, network=True)
r = sb.exec("""js-exec -c '
    fetch("https://httpbin.org/get")
        .then(r => r.json())
        .then(d => console.log("origin:", d.origin))
'""")
print(r.stdout)   # origin: <your-ip>
```

- **Bash gains HTTP tools.** With `network=True`, `curl` is available and git
  remote operations can reach HTTPS remotes. `wget`, raw sockets, package
  managers, compilers, and SSH remain unsupported.
- **Opt-in, default `False`.** Omitting `network` (or passing `network=False`)
  blocks outbound access; local git operations still work.
- **js-exec timeout extends to 60 s** when network is enabled (documented in
  the `node` alias help text).

### `client.sandboxes.get(sandbox_id) -> SandboxInfo`

Maps to `GET /v1/sandboxes/{id}`. Use this when you have an id and need to
verify ownership / read `last_used_at`. Raises `NotFoundError` (404) or
`AuthError` (403) for a sandbox owned by a different `sub`.

### `client.sandboxes.attach(sandbox_id) -> Sandbox`

**No network call.** Returns a `Sandbox` handle for an existing id. Use this
to resume work on a long-lived sandbox without paying a `GET` round-trip.
Combine with `.get()` if you need to verify the sandbox first.

```python
sb = fs.sandboxes.attach(os.environ["VIRTUALFS_SANDBOX_ID"])
result = sb.exec("ls /home/user")
```

### `client.sandboxes.delete(sandbox_id) -> None`

Maps to `DELETE /v1/sandboxes/{id}`. Destroys the sandbox and orphans its
blobs (which are GC'd by the server's blob-GC job).

```python
fs.sandboxes.delete(sb.id)
# Equivalent: sb.delete()
```

Returns `None`. Raises `NotFoundError` if the id doesn't exist or `AuthError`
if owned by a different `sub`.

---

## Retry & error policy

The `Client` retries up to `max_retries` times on **transient** failures only:

| Status | Retried? |
|---|---|
| 200–299 | n/a (success) |
| 400 / 404 / 408 / 409 | **No** — surfaced immediately as typed exceptions |
| 401 / 403 | **No** — surfaced immediately as `AuthError` |
| 429 | **Yes** — honours `Retry-After` header if present, else exponential jitter |
| 5xx | **Yes** — exponential jitter, capped at 8 s per attempt |
| network (DNS, TCP, TLS, read-timeout) | **Yes** — exponential jitter |

`exec` / `exec_batch` are only retried on transient 5xx when `read_only=True`
(always safe) or when you opt in with `retry_on_5xx=True`; otherwise the server
can't safely re-run an arbitrary write. `exec_stream` is **never** retried —
at-most-once semantics. After `max_retries` exhaustion the SDK raises
`ServerError` (for 5xx) or `TransportError` (for network failures).

See `plugins/sql-fs/skills/py-sdk/ref/errors.md` for the full exception
hierarchy.

---

## Common patterns

### Long-lived agent process — keep one `Client`

```python
class Agent:
    def __init__(self) -> None:
        self.fs = Client(
            base_url=os.environ["BASE_URL"],
            auth_secret=os.environ["AUTH_SECRET"],
            sub="agent",
        )

    def close(self) -> None:
        self.fs.close()
```

The bootstrap hits the wire once. Subsequent calls reuse the cached JWT and
the `httpx.Client` connection pool.

### Short-lived script — context manager

```python
with Client(base_url=..., auth_secret=..., sub="cli") as fs:
    sb = fs.sandboxes.create(name="cli-run")
    try:
        ...
    finally:
        fs.sandboxes.delete(sb.id)
```

### Custom `httpx.Client` (e.g. for tests, proxies, or shared connection pool)

```python
import httpx
my_http = httpx.Client(proxy="http://proxy:8080", timeout=60.0)
fs = Client(base_url=..., token=..., http_client=my_http)
```

When you pass `http_client=`, the SDK does **not** close it — it's yours to
manage.

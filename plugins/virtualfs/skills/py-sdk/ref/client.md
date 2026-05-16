# `Client` reference

The top-level entry point. Wraps `httpx.Client` with auth bootstrap, retry
policy, and the typed exception layer. One `Client` instance is safe for the
lifetime of your process.

```python
from virtualfs import Client
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
    user_agent: str | None = None,      # defaults to "virtualfs-python/<ver>"
    http_client: httpx.Client | None = None,  # bring-your-own (e.g. for mocks)
)
```

**Validation:** the constructor raises `ValueError` if you pass none of
`token / auth_secret / admin_secret`, or if you pass a secret without `sub`.

**Token bootstrap is lazy.** Constructing the `Client` does not hit the network —
the JWT is minted on the first request that needs it (or when you read
`client.token`).

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
    network=False,                          # enable outbound fetch() from js-exec (opt-in)
)
```

All keyword args are optional — `fs.sandboxes.create()` is valid and creates
an anonymous sandbox.

**`network=True` — enabling outbound fetch()**

Pass `network=True` together with `javascript=True` to allow `fetch()` calls
inside `js-exec` scripts to reach external HTTP endpoints:

```python
sb = fs.sandboxes.create(javascript=True, network=True)
r = sb.exec("""js-exec -c '
    fetch("https://httpbin.org/get")
        .then(r => r.json())
        .then(d => console.log("origin:", d.origin))
'""")
print(r.stdout)   # origin: <your-ip>
```

- **Bash remains air-gapped.** Even with `network=True`, the Bash shell has
  no `curl`, `wget`, DNS, or raw socket access. Only `fetch()` inside `js-exec`
  gains outbound HTTP.
- **Opt-in, default `False`.** Omitting `network` (or passing `network=False`)
  produces a fully isolated sandbox.
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

After `max_retries` exhaustion the SDK raises `ServerError` (for 5xx) or
`TransportError` (for network failures). Streaming endpoints
(`exec_stream`) are **not** retried — they have at-most-once
semantics because the server can't safely re-execute a script.

See `plugins/virtualfs/skills/py-sdk/ref/errors.md` for the full exception
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

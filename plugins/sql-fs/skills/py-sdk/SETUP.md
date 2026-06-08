# SQL-FS Python SDK — Setup & Auth

## Install

The SDK lives at `clients/python/` in the sqlfs monorepo and is published as
the `sqlfs` package on PyPI (see `pyproject.toml` for the canonical version).

```bash
# From PyPI (when released)
pip install sqlfs

# From this repo (editable install — picks up local changes)
pip install -e clients/python
```

Runtime dependency: only `httpx`. Python 3.9+.

---

## Two ways to authenticate

The SDK accepts **either** a pre-minted `token` **or** the server's `auth_secret`
(plus a `sub`). The latter is recommended for short-lived agents — the SDK
exchanges the secret for a JWT lazily on the first request.

### Option A — `auth_secret` (recommended for agents)

```python
import os
from sqlfs import Client

with Client(
    base_url=os.environ["BASE_URL"],
    auth_secret=os.environ["AUTH_SECRET"],
    sub="my-agent",            # token subject = sandbox owner identity
    expires_in="30d",          # one of: "24h", "30d", "1y", "never"
) as fs:
    print(fs.token[:20], "...")  # forces bootstrap and prints the JWT prefix
```

The bootstrap call hits `POST /v1/auth/bootstrap` with `X-Auth-Secret`. Subsequent
requests reuse the cached JWT.

### Option B — pre-minted `token`

If you've already minted a token (e.g. via `pnpm token:create` on the server
host, or via `POST /v1/auth/admin`), pass it directly:

```python
with Client(base_url=os.environ["BASE_URL"], token=os.environ["TOKEN"]) as fs:
    sandboxes = fs.sandboxes.list()
```

You don't need `sub=` when passing `token=` — it's already encoded in the JWT.

### Option C — admin secret (for token-minting tools, not agents)

```python
with Client(
    base_url=os.environ["BASE_URL"],
    admin_secret=os.environ["ADMIN_SECRET"],
    sub="agent-001",
) as fs:
    print(fs.token)  # minted via POST /v1/auth/admin
```

This is what you'd use to **build** a tool that mints scoped tokens for other
agents. For day-to-day agent work, prefer Option A.

---

## Required env vars

```bash
export BASE_URL="<YOUR_BASE_URL>"          # e.g. https://your-app.azurecontainerapps.io
export AUTH_SECRET="<YOUR_AUTH_SECRET>"   # never commit; ask the deployer
# OR
export TOKEN="<your-pre-minted-jwt>"
```

The SDK reads these via `os.environ[...]` in user code — it does NOT read them
automatically. Always pass them explicitly to `Client(...)`.

---

## First sandbox — end-to-end smoke test

```python
import os
from sqlfs import Client

with Client(
    base_url=os.environ["BASE_URL"],
    auth_secret=os.environ["AUTH_SECRET"],
    sub="smoke",
) as fs:
    sb = fs.sandboxes.create(name="smoke-test")
    try:
        result = sb.exec("echo hello && pwd")
        assert result.ok, f"unexpected exit {result.exit_code}: {result.error}"
        print(result.stdout)
    finally:
        fs.sandboxes.delete(sb.id)
```

---

## Patterns to bake in

### Always use `with Client(...)` for the client

`Client.close()` releases the underlying `httpx.Client` connection pool. The
context manager makes leakage impossible.

```python
with Client(...) as fs:
    ...
```

### Always use `try/finally` around sandbox lifetime

Sandboxes are durable — they survive process exit and accumulate Postgres rows
(and storage) until explicitly deleted.

```python
sb = fs.sandboxes.create(name="...")
try:
    # ... do work ...
finally:
    fs.sandboxes.delete(sb.id)
```

### Re-using an existing sandbox by id

```python
sb = fs.sandboxes.attach("550e8400-e29b-41d4-a716-446655440000")
# .attach() does NOT hit the network — call .get(id) first if you need to verify.
info = fs.sandboxes.get(sb.id)
print(info.last_used_at)
```

---

## Multi-tenant deployments

Pass `tenant=...` alongside `auth_secret=...` to mint a tenant-scoped JWT:

```python
fs = Client(
    base_url=os.environ["BASE_URL"],
    auth_secret=os.environ["AUTH_SECRET"],
    sub="agent-1",
    tenant="tenant-a",
)
```

For single-tenant deployments (most common), omit `tenant=` entirely — the
server falls back to the default tenant.

---

## Common setup mistakes

| Symptom | Cause | Fix |
|---|---|---|
| `ValueError: Provide one of: token=..., auth_secret=..., or admin_secret=...` | Constructor called with no credentials | Pass exactly one of the three |
| `ValueError: 'sub' is required when bootstrapping a token from a secret` | `auth_secret=...` without `sub=...` | Add `sub="..."` |
| `AuthError(status=401, code='AUTH_INVALID')` | JWT expired, or `AUTH_SECRET` mismatch | Re-mint with correct secret |
| `AuthError(status=403, code='FORBIDDEN')` | Trying to access a sandbox owned by a different `sub` | Use the `sub` that created the sandbox, or attach via that token |
| `RateLimitError(retry_after=N)` on bootstrap | `/v1/auth/bootstrap` rate limit (default 5 / 60s per IP) | Wait `N` seconds; or pass a pre-minted `token=` instead of bootstrapping each run |
| `TransportError: network error after 4 attempts` | Wrong `BASE_URL`, DNS failure, or server down | Check `curl -fsS $BASE_URL/healthz` first |

---

## Verifying the deployment from Python

```python
import os, httpx
r = httpx.get(f"{os.environ['BASE_URL']}/healthz", timeout=5.0)
r.raise_for_status()
print(r.json())  # → {'status': 'ok'}
```

The SDK doesn't expose `/healthz` (it's not under `/v1`). Use `httpx` directly
when you just need to check liveness without auth.

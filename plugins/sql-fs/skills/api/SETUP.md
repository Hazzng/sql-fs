# SQL-FS API — Setup & Auth

## Two secrets, two purposes (don't conflate them)

SQL-FS uses **two separate secrets**. Mixing them up is the #1 source of auth confusion:

| Secret | Purpose | Where it's used |
|---|---|---|
| `AUTH_SECRET` | HMAC key that **signs** every JWT. The server verifies incoming `Authorization: Bearer <jwt>` against this. | Server-side verification on every `/v1/*` request. Also used by `POST /v1/auth/bootstrap` (send as `X-Auth-Secret`) to mint the first token over HTTP. |
| `ADMIN_SECRET` | Out-of-band gate on the `POST /v1/auth/admin` minting endpoint. Sent as `X-Admin-Secret` header. | Only on `/v1/auth/admin` requests. Independent of JWT auth. |

**Three ways to mint your first token** (pick one):

1. **HTTP bootstrap** — `POST /v1/auth/bootstrap` with `X-Auth-Secret: $AUTH_SECRET` ← recommended, no CLI needed
2. **CLI** — `pnpm token:create` on a host that has the project root and `AUTH_SECRET` available
3. **Admin endpoint** — `POST /v1/auth/admin` (requires a Bearer JWT _and_ `ADMIN_SECRET`, so only useful for day-2 token rotation, not first-time setup)

## Prerequisites

- `curl` and `jq`
- `AUTH_SECRET` and the API `BASE_URL` (from your deployment / `.env`)

---

## Step 1 — Mint your first token via HTTP bootstrap

```bash
export AUTH_SECRET="<YOUR_AUTH_SECRET>"
export BASE_URL="<YOUR_VIRTUALFS_API_URL>"

export TOKEN=$(curl -fsS -X POST "$BASE_URL/v1/auth/bootstrap" \
  -H "X-Auth-Secret: $AUTH_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"sub":"admin","expiresIn":"30d"}' | jq -er '.token')
echo "Token: $TOKEN"
```

Available expiry values: `24h`, `30d`, `1y`, `never`.

Store `$TOKEN` in your shell profile or a `.env` file. Tokens last 30 days by default.

> **Alternative — CLI bootstrap** (requires project root and `AUTH_SECRET` on the same host):
> ```bash
> export TOKEN=$(AUTH_SECRET=$AUTH_SECRET pnpm token:create -- --sub admin --expires 30d 2>/dev/null | tail -1)
> ```

---

## Step 2 — Verify the token works

```bash
export BASE_URL="<YOUR_BASE_URL>"   # set to your deployment URL

curl -fsS "$BASE_URL/healthz"
# → {"status":"ok"}

curl -fsS -X POST "$BASE_URL/v1/sandboxes" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}' | jq
# → {"id":"...","owner":"admin","createdAt":"...","python_runtime":null,"javascript":false,"network":false}
```

---

## Step 3 — Mint agent tokens via API (for CI / other services)

Once you have an admin token you can mint scoped tokens via the API instead of bootstrap.

`POST /v1/auth/admin` requires **two** auth signals:
1. `Authorization: Bearer <admin-token>` — same JWT auth as every `/v1/*` route
2. `X-Admin-Secret: <ADMIN_SECRET>` — additional out-of-band secret matched against the
   server's `ADMIN_SECRET` env var (separate from `AUTH_SECRET`)

```bash
export ADMIN_SECRET="<YOUR_ADMIN_SECRET>"   # never commit; ask the deployer

# Mint a 30-day token for an agent (valid expiresIn: "24h", "30d", "1y", "never")
AGENT_TOKEN=$(curl -fsS -X POST "$BASE_URL/v1/auth/admin" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Admin-Secret: $ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"sub": "agent-1", "expiresIn": "30d"}' | jq -er '.token')
echo "Agent token: $AGENT_TOKEN"
```

The `sub` field becomes the `owner` identity — sandboxes created by this token are owned by
`agent-1` and cannot be accessed by tokens with a different `sub`.

---

## Multi-tenant setup

Multi-tenant deployments add a `tenant` claim to the JWT to scope the token to a specific
Postgres database. Single-tenant (current deployment) tokens omit it — they fall back to the
default tenant automatically.

To mint a tenant-scoped token via bootstrap:

```bash
export TOKEN=$(curl -fsS -X POST "$BASE_URL/v1/auth/bootstrap" \
  -H "X-Auth-Secret: $AUTH_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"sub":"admin","tenant":"tenant-a","expiresIn":"30d"}' | jq -er '.token')
```

To check what tenant your token resolves to:

```bash
# Decode the JWT payload (no verification — just inspect)
echo $TOKEN | cut -d. -f2 | base64 -d 2>/dev/null | jq
# → {"sub":"admin","iat":...,"exp":...}   ← no tenant claim = default tenant
```

---

## MCP static-header auth (LibreChat and other fixed-header clients)

The `/mcp` endpoint defaults to the same JWT Bearer auth as `/v1/*`. MCP clients that
can only send **fixed headers** (e.g. [LibreChat](https://github.com/danny-avila/LibreChat))
cannot mint a per-request JWT. Setting **`MCP_API_KEY`** on the server enables an additive
static-header path on `/mcp`:

- `Authorization: Bearer <MCP_API_KEY>` is accepted without JWT verification (constant-time compare).
- The sandbox **owner** (`sub`) is taken from a forwarded identity header — `MCP_IDENTITY_HEADER`,
  default `x-librechat-user-id` — so each end-user gets an isolated sandbox.
- A non-matching token still falls through to JWT verification, so JWT clients keep working on `/mcp`.

```yaml
# librechat.yaml
mcpServers:
  sql-fs:
    type: streamable-http
    url: https://your-sql-fs.example.com/mcp
    headers:
      Authorization: "Bearer ${MCP_API_KEY}"
      x-librechat-user-id: "{{LIBRECHAT_USER_ID}}"
```

Server env vars:

| Variable | Default | Purpose |
|---|---|---|
| `MCP_API_KEY` | — (off) | Pre-shared secret (≥16 chars) enabling static `/mcp` auth. Keep it secret — it guards code execution. |
| `MCP_IDENTITY_HEADER` | `x-librechat-user-id` | Header whose value becomes the sandbox owner. |
| `MCP_DEFAULT_SUB` | — | Shared owner when the identity header is absent. When unset, a missing header is rejected. |
| `MCP_STATIC_TENANT` | `default` | Tenant for static-header requests; must be configured. |

> **Trust note.** The identity header is trusted as the end-user identity, so it must be stamped
> by your proxy/LibreChat and not be settable by untrusted callers. Anyone holding `MCP_API_KEY`
> who can reach `/mcp` directly can pick any `sub` — keep the key secret and `/mcp` behind your ingress.

---

## Environment setup (put in ~/.zshrc or .env)

```bash
export VIRTUALFS_BASE_URL="<YOUR_BASE_URL>"          # e.g. https://your-app.azurecontainerapps.io
export VIRTUALFS_AUTH_SECRET="<YOUR_AUTH_SECRET>"   # never commit the real value
export VIRTUALFS_TOKEN="<your-generated-token>"

# Convenience aliases
alias vfs-sandbox-create='curl -fsS -X POST "$VIRTUALFS_BASE_URL/v1/sandboxes" -H "Authorization: Bearer $VIRTUALFS_TOKEN" -H "Content-Type: application/json"'
alias vfs-health='curl -fsS "$VIRTUALFS_BASE_URL/healthz"'
alias vfs-bootstrap='curl -fsS -X POST "$VIRTUALFS_BASE_URL/v1/auth/bootstrap" -H "X-Auth-Secret: $VIRTUALFS_AUTH_SECRET" -H "Content-Type: application/json"'
```

---

## Troubleshooting auth errors

| Response | Cause | Fix |
|---|---|---|
| `{"error":"unauthorized","code":"AUTH_REQUIRED"}` | Missing or malformed `Authorization` header | Add `Authorization: Bearer $TOKEN` |
| `{"error":"invalid_token","code":"AUTH_INVALID"}` | JWT expired or wrong `AUTH_SECRET` | Re-generate token with correct secret |
| `{"error":"unknown_tenant","code":"AUTH_UNKNOWN_TENANT"}` | `tenant` claim in JWT not configured on server | Omit `tenant` claim or update server config |
| `{"error":"forbidden","code":"FORBIDDEN"}` | Sandbox owned by a different `sub`, OR wrong/missing `X-Auth-Secret` on bootstrap | Use the token that created the sandbox; double-check `AUTH_SECRET` |
| `{"error":"auth_not_configured","code":"AUTH_NOT_CONFIGURED"}` | Server has no `AUTH_SECRET` env var | Ask the deployer to set `AUTH_SECRET` |
| `{"error":"identity_required","code":"AUTH_IDENTITY_REQUIRED"}` | Static `/mcp` API key matched but no identity header and no `MCP_DEFAULT_SUB` | Send the `MCP_IDENTITY_HEADER` (default `x-librechat-user-id`) or set `MCP_DEFAULT_SUB` |
| `{"error":"invalid_identity","code":"AUTH_IDENTITY_INVALID"}` | Identity header present but empty, >256 chars, or contains control characters | Forward a valid user id/email in the identity header |
| `{"error":"admin_not_configured","code":"ADMIN_NOT_CONFIGURED"}` | Server has no `ADMIN_SECRET` env var | Ask the deployer to set `ADMIN_SECRET` |
| `{"error":"rate_limited","code":"RATE_LIMITED"}` | Too many requests to `/v1/auth/bootstrap` or `/v1/auth/admin` (default 5 / 60s). Response includes `Retry-After` header. | Wait `Retry-After` seconds, or raise `*_RATE_LIMIT_*` env vars. |

---

## POST /v1/auth/bootstrap — security notes

`POST /v1/auth/bootstrap` is unauthenticated by design — it is itself the credential-bootstrap
endpoint. Its hardening:

- **Constant-time comparison** of `X-Auth-Secret` against `AUTH_SECRET` using a SHA-256-digest `crypto.timingSafeEqual` — no length oracle and no early-return timing leak
- **Hard-fail when `AUTH_SECRET` is unset** — returns `500 AUTH_NOT_CONFIGURED`, never signs with an empty string
- **Secret check before body parsing** — callers without the correct secret cannot probe the request schema with cheap 400s
- **Tenant validation** — rejects unknown `tenant` values before signing
- **Audit log** — emits `auth_bootstrap_issued` / `auth_bootstrap_denied` (with `reason`: `mismatch`, `missing_header`, `unknown_tenant`) on every call
- **Method-scoped exemption** — only `POST /v1/auth/bootstrap` bypasses Bearer auth; `GET` (or any other method) on the same path is still gated
- **Per-IP rate limit** — defaults to 5 requests / 60s (configurable via `BOOTSTRAP_RATE_LIMIT_WINDOW_MS` / `BOOTSTRAP_RATE_LIMIT_MAX`). 429 responses include a `Retry-After` header.

---

## POST /v1/auth/admin — security notes

`POST /v1/auth/admin` lives behind the standard Bearer middleware *and* requires
`X-Admin-Secret`. Its hardening:

- **SHA-256-digest timing-safe compare** of `X-Admin-Secret` against `ADMIN_SECRET` — same helper as bootstrap, no length leak
- **Secret check before body parsing** — wrong/missing `X-Admin-Secret` returns 403 even for malformed bodies (no schema-probing via 400s)
- **Hard-fail on missing `AUTH_SECRET`** — returns `500 AUTH_NOT_CONFIGURED` instead of signing with an empty key
- **`jti` claim on every issued token** — UUID generated server-side, included in the JWT, and recorded in the `admin_token_issued` audit log so a leaked token can be correlated to its issuance
- **Audit log** — emits `admin_token_issued` (with `caller`, `callerTenant`, `sub`, `tenant`, `expiresIn`, `jti`, `ip`, `ua`), `admin_token_denied` (with `reason`: `mismatch` / `missing_header` / `unknown_tenant`), and `admin_token_misconfigured` (when `ADMIN_SECRET` or `AUTH_SECRET` is unset). Issued tokens are **never** logged.
- **Per-IP and per-Bearer-`sub` rate limit** — defaults to 5 requests / 60s. Either key tripping returns 429. Configure via `ADMIN_RATE_LIMIT_WINDOW_MS` / `ADMIN_RATE_LIMIT_MAX`.

### Rate limit env vars

| Variable | Default | Description |
|---|---|---|
| `ADMIN_RATE_LIMIT_WINDOW_MS` | `60000` | Window length for the admin endpoint, in milliseconds. |
| `ADMIN_RATE_LIMIT_MAX` | `5` | Max requests per `(ip)` and per `(sub)` in one window. |
| `BOOTSTRAP_RATE_LIMIT_WINDOW_MS` | `60000` | Window length for the bootstrap endpoint. |
| `BOOTSTRAP_RATE_LIMIT_MAX` | `5` | Max requests per `(ip)` in one window. |
| `TRUST_PROXY_HEADERS` | `false` | Honour `X-Forwarded-For` / `X-Real-IP` for rate-limit keying. **See trust-proxy note below.** |

> **Trust-proxy note (security-critical for `/v1/auth/bootstrap`).** `/v1/auth/bootstrap`
> is unauthenticated, so its rate limit is the only barrier against `AUTH_SECRET`
> brute-forcing. The IP used for keying must come from a source the caller cannot
> spoof:
>
> - **Default (`TRUST_PROXY_HEADERS=false`)** — the connecting socket's
>   `remoteAddress` is the key. Inbound `X-Forwarded-For` / `X-Real-IP` headers
>   are ignored. Safe behind any deployment, but if the API sits behind a cloud
>   load balancer that terminates TCP, every request appears to come from the
>   load balancer's IP and the bucket is *shared by all callers* — usually too
>   tight for production.
> - **`TRUST_PROXY_HEADERS=true`** — the leftmost `X-Forwarded-For` value is
>   used. **Only safe if the ingress strips inbound forwarding headers** (so
>   the leftmost value is one the proxy itself stamped). If the ingress merely
>   *appends* to the chain (Azure Container Apps, many K8s ingresses), an
>   attacker can prepend an arbitrary value and bypass per-IP rate limiting on
>   `/v1/auth/bootstrap`. Verify by sending a request with a synthetic
>   `X-Forwarded-For: 9.9.9.9` header from outside and inspecting the audit
>   log: if the recorded `ip` is `9.9.9.9`, the proxy is *not* sanitising and
>   you must not enable this flag.

### Audit log events

All audit events are emitted as single JSON lines on stdout for log-aggregator ingestion.

| Event | Emitted by | Notable fields |
|---|---|---|
| `auth_bootstrap_issued` | `POST /v1/auth/bootstrap` (success) | `ip`, `ua`, `sub`, `tenant`, `expiresIn`, `expiresAt` |
| `auth_bootstrap_denied` | `POST /v1/auth/bootstrap` (403/400) | `ip`, `ua`, `reason` |
| `auth_bootstrap_misconfigured` | `POST /v1/auth/bootstrap` (500) | `ip`, `ua` |
| `admin_token_issued` | `POST /v1/auth/admin` (success) | `caller`, `callerTenant`, `sub`, `tenant`, `expiresIn`, `expiresAt`, `jti`, `ip`, `ua` |
| `admin_token_denied` | `POST /v1/auth/admin` (403/400) | `caller`, `ip`, `ua`, `reason` |
| `admin_token_misconfigured` | `POST /v1/auth/admin` (500) | `caller`, `ip`, `ua`, `reason` (e.g. `auth_secret_unset`) |
| `auth_rate_limited` | rate-limit middleware (429) | `scope` (`admin`/`bootstrap`), `keys`, `trippedKey`, `ip`, `sub`, `path` |

# VirtualFS API — Setup & Auth

## Two secrets, two purposes (don't conflate them)

VirtualFS uses **two separate secrets**. Mixing them up is the #1 source of auth confusion:

| Secret | Purpose | Where it's used |
|---|---|---|
| `AUTH_SECRET` | HMAC key that **signs** every JWT. The server verifies incoming `Authorization: Bearer <jwt>` against this. | Server-side verification on every `/v1/*` request. Also used by `POST /v1/auth/bootstrap` (send as `X-Auth-Secret`) to mint the first token over HTTP. |
| `ADMIN_SECRET` | Out-of-band gate on the `POST /v1/admin/tokens` minting endpoint. Sent as `X-Admin-Secret` header. | Only on `/v1/admin/tokens` requests. Independent of JWT auth. |

**Three ways to mint your first token** (pick one):

1. **HTTP bootstrap** — `POST /v1/auth/bootstrap` with `X-Auth-Secret: $AUTH_SECRET` ← recommended, no CLI needed
2. **CLI** — `pnpm token:create` on a host that has the project root and `AUTH_SECRET` available
3. **Admin endpoint** — `POST /v1/admin/tokens` (requires a Bearer JWT _and_ `ADMIN_SECRET`, so only useful for day-2 token rotation, not first-time setup)

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
# → {"id":"...","owner":"admin","createdAt":"...","python":false,"javascript":false}
```

---

## Step 3 — Mint agent tokens via API (for CI / other services)

Once you have an admin token you can mint scoped tokens via the API instead of bootstrap.

`POST /v1/admin/tokens` requires **two** auth signals:
1. `Authorization: Bearer <admin-token>` — same JWT auth as every `/v1/*` route
2. `X-Admin-Secret: <ADMIN_SECRET>` — additional out-of-band secret matched against the
   server's `ADMIN_SECRET` env var (separate from `AUTH_SECRET`)

```bash
export ADMIN_SECRET="<YOUR_ADMIN_SECRET>"   # never commit; ask the deployer

# Mint a 30-day token for an agent (valid expiresIn: "24h", "30d", "1y", "never")
AGENT_TOKEN=$(curl -fsS -X POST "$BASE_URL/v1/admin/tokens" \
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
| `{"error":"admin_not_configured","code":"ADMIN_NOT_CONFIGURED"}` | Server has no `ADMIN_SECRET` env var | Ask the deployer to set `ADMIN_SECRET` |

---

## POST /v1/auth/bootstrap — security notes

`POST /v1/auth/bootstrap` is unauthenticated by design — it is itself the credential-bootstrap
endpoint. Its hardening:

- **Constant-time comparison** of `X-Auth-Secret` against `AUTH_SECRET` (`crypto.timingSafeEqual`) — no timing oracle
- **Hard-fail when `AUTH_SECRET` is unset** — returns `500 AUTH_NOT_CONFIGURED`, never signs with an empty string
- **Secret check before body parsing** — callers without the correct secret cannot probe the request schema with cheap 400s
- **Tenant validation** — rejects unknown `tenant` values before signing
- **Audit log** — emits `auth_bootstrap_issued` / `auth_bootstrap_denied` (with `reason`: `mismatch`, `missing_header`, `unknown_tenant`) on every call
- **Method-scoped exemption** — only `POST /v1/auth/bootstrap` bypasses Bearer auth; `GET` (or any other method) on the same path is still gated

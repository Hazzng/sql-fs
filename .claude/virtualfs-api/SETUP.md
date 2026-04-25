# VirtualFS API — Setup & Auth

## Prerequisites

- Node.js 22+ and pnpm (for local token generation)
- `curl` and `jq`
- Access to the virtualFS project root (for `pnpm token:create`)

---

## Step 1 — Generate an admin token (one-time bootstrap)

Run this from the **project root** (`/Users/nguyendangquang/master/Web-Dev/virtualFS`):

```bash
export AUTH_SECRET="b882d28f4ddeb27d778c1f11e75ad96703ff3830b327dabd5c158e9942237d04"
export BASE_URL="https://virtualfs-api.redocean-7a422dd7.australiaeast.azurecontainerapps.io"

export TOKEN=$(AUTH_SECRET=$AUTH_SECRET pnpm token:create -- --sub admin --expires 30d 2>/dev/null | tail -1)
echo "Token: $TOKEN"
```

Store `$TOKEN` in your shell profile or a `.env` file. Tokens last 30 days by default.

Available expiry values: `24h`, `7d`, `30d`, `1y`, `never`.

---

## Step 2 — Verify the token works

```bash
curl -s "$BASE_URL/healthz"
# → {"status":"ok"}

curl -s -X POST "$BASE_URL/v1/sandboxes" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}' | jq
# → {"id":"...","owner":"admin","createdAt":"...","python":false,"javascript":false}
```

---

## Step 3 — Mint agent tokens via API (for CI / other services)

Once you have an admin token you can mint scoped tokens via the API instead of the CLI:

```bash
# Create a 7-day token for an agent
AGENT_TOKEN=$(curl -s -X POST "$BASE_URL/v1/admin/tokens" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"sub": "agent-1", "expiresIn": "7d"}' | jq -r '.token')
echo "Agent token: $AGENT_TOKEN"
```

The `sub` field becomes the `owner` identity — sandboxes created by this token are owned by
`agent-1` and cannot be accessed by tokens with a different `sub`.

---

## Multi-tenant setup

Multi-tenant deployments add a `tenant` claim to the JWT to scope the token to a specific
Postgres database. Single-tenant (current deployment) tokens omit it — they fall back to the
default tenant automatically.

To check what tenant your token resolves to:

```bash
# Decode the JWT payload (no verification — just inspect)
echo $TOKEN | cut -d. -f2 | base64 -d 2>/dev/null | jq
# → {"sub":"admin","iat":...,"exp":...}   ← no tenant claim = default tenant
```

---

## Environment setup (put in ~/.zshrc or .env)

```bash
export VIRTUALFS_BASE_URL="https://virtualfs-api.redocean-7a422dd7.australiaeast.azurecontainerapps.io"
export VIRTUALFS_AUTH_SECRET="b882d28f4ddeb27d778c1f11e75ad96703ff3830b327dabd5c158e9942237d04"
export VIRTUALFS_TOKEN="<your-generated-token>"

# Convenience aliases
alias vfs-sandbox-create='curl -s -X POST "$VIRTUALFS_BASE_URL/v1/sandboxes" -H "Authorization: Bearer $VIRTUALFS_TOKEN" -H "Content-Type: application/json"'
alias vfs-health='curl -s "$VIRTUALFS_BASE_URL/healthz"'
```

---

## MCP server setup (Claude Code integration)

Add to `~/.claude/settings.json` under `mcpServers`:

```json
{
  "mcpServers": {
    "virtualfs": {
      "type": "http",
      "url": "https://virtualfs-api.redocean-7a422dd7.australiaeast.azurecontainerapps.io/mcp",
      "headers": {
        "Authorization": "Bearer <your-token>"
      }
    }
  }
}
```

Available MCP tools: `sandbox_create`, `sandbox_delete`, `bash_exec`, `fs_ingest`, `fs_export`.

Verify in Claude Code:
```
/mcp  →  should list "virtualfs" with 5 tools
```

---

## Troubleshooting auth errors

| Response | Cause | Fix |
|---|---|---|
| `{"error":"unauthorized","code":"AUTH_REQUIRED"}` | Missing or malformed `Authorization` header | Add `Authorization: Bearer $TOKEN` |
| `{"error":"invalid_token","code":"AUTH_INVALID"}` | JWT expired or wrong `AUTH_SECRET` | Re-generate token with correct secret |
| `{"error":"unknown_tenant","code":"AUTH_UNKNOWN_TENANT"}` | `tenant` claim in JWT not configured on server | Omit `tenant` claim or update server config |
| `{"error":"forbidden","code":"FORBIDDEN"}` | Sandbox owned by a different `sub` | Use the token that created the sandbox |

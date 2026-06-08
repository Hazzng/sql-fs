# SQL-FS TypeScript SDK — Setup & Auth

## Install

The SDK lives at `clients/typescript/` in the sqlfs monorepo and is published as
the `sql-fs-sdk` package on npm (see `package.json` for the canonical version).

```bash
# From npm (when released)
npm install sql-fs-sdk

# From this repo (workspace / file install — picks up local changes)
pnpm add ./clients/typescript
```

ESM-only. Requires **Node ≥ 22** (the SDK uses the global `fetch`). No runtime
dependencies.

---

## Two ways to authenticate

The SDK accepts **either** a pre-minted `token` **or** the server's `authSecret`
(plus a `sub`). The latter is recommended for short-lived agents — the SDK
exchanges the secret for a JWT lazily on the first request.

### Option A — `authSecret` (recommended for agents)

```typescript
import { Client } from "sql-fs-sdk";

const client = new Client({
  baseUrl: process.env.BASE_URL!,
  authSecret: process.env.AUTH_SECRET!,
  sub: "my-agent",            // token subject = sandbox owner identity
  expiresIn: "30d",           // one of: "24h", "30d", "1y", "never"
});

console.log((await client.getToken()).slice(0, 20), "...");  // forces bootstrap
```

The bootstrap call hits `POST /v1/auth/bootstrap` with `X-Auth-Secret`. Subsequent
requests reuse the cached JWT. `client.token` is the sync getter (may be
`undefined` before bootstrap); `await client.getToken()` forces it.

### Option B — pre-minted `token`

If you've already minted a token (e.g. via `pnpm token:create` on the server
host, or via `POST /v1/auth/admin`), pass it directly:

```typescript
const client = new Client({ baseUrl: process.env.BASE_URL!, token: process.env.TOKEN! });
const sandboxes = await client.sandboxes.list();
```

You don't need `sub` when passing `token` — it's already encoded in the JWT.

### Option C — admin secret (for token-minting tools, not agents)

```typescript
const client = new Client({
  baseUrl: process.env.BASE_URL!,
  adminSecret: process.env.ADMIN_SECRET!,
  sub: "agent-001",
});
console.log(await client.getToken());  // minted via POST /v1/auth/admin
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

The SDK reads these via `process.env[...]` in your code — it does NOT read them
automatically. Always pass them explicitly to `new Client({...})`.

---

## First sandbox — end-to-end smoke test

```typescript
import { Client } from "sql-fs-sdk";

const client = new Client({
  baseUrl: process.env.BASE_URL!,
  authSecret: process.env.AUTH_SECRET!,
  sub: "smoke",
});

const sb = await client.sandboxes.create({ name: "smoke-test" });
try {
  const result = await sb.exec("echo hello && uname -srm");
  if (!result.ok) throw new Error(`unexpected exit ${result.exitCode}: ${result.error}`);
  console.log(result.stdout);
} finally {
  await client.sandboxes.delete(sb.id);
  client.close();
}
```

---

## Patterns to bake in

### Always `client.close()` in a `finally`

`Client.close()` releases the transport. There's no context-manager equivalent
in TS — wrap the whole flow in `try/finally`:

```typescript
const client = new Client({ ... });
try {
  // ... work ...
} finally {
  client.close();
}
```

### Always use `try/finally` around sandbox lifetime

Sandboxes are durable — they survive process exit and accumulate Postgres rows
(and storage) until explicitly deleted.

```typescript
const sb = await client.sandboxes.create({ name: "..." });
try {
  // ... do work ...
} finally {
  await client.sandboxes.delete(sb.id);   // or: await sb.delete()
}
```

### Re-using an existing sandbox by id

```typescript
const sb = client.sandboxes.attach("550e8400-e29b-41d4-a716-446655440000");
// .attach() does NOT hit the network — call .get(id) first if you need to verify.
const info = await client.sandboxes.get(sb.id);
console.log(info.lastUsedAt);
```

---

## Multi-tenant deployments

Pass `tenant` alongside `authSecret` to mint a tenant-scoped JWT:

```typescript
const client = new Client({
  baseUrl: process.env.BASE_URL!,
  authSecret: process.env.AUTH_SECRET!,
  sub: "agent-1",
  tenant: "tenant-a",
});
```

For single-tenant deployments (most common), omit `tenant` entirely — the
server falls back to the default tenant.

---

## Common setup mistakes

| Symptom | Cause | Fix |
|---|---|---|
| `Error: Provide one of: token, authSecret, or adminSecret` | Constructor called with no credentials | Pass exactly one of the three |
| `Error: 'sub' is required when bootstrapping a token from a secret` | `authSecret` without `sub` | Add `sub: "..."` |
| `AuthError` with `status === 401`, `code === "AUTH_INVALID"` | JWT expired, or `AUTH_SECRET` mismatch | Re-mint with correct secret |
| `AuthError` with `status === 403`, `code === "FORBIDDEN"` | Accessing a sandbox owned by a different `sub` | Use the `sub` that created the sandbox, or attach via that token |
| `RateLimitError` with `retryAfter` on bootstrap | `/v1/auth/bootstrap` rate limit (default 5 / 60s per IP) | Wait `retryAfter` seconds; or pass a pre-minted `token` instead of bootstrapping each run |
| `TransportError: network error after N attempts` | Wrong `baseUrl`, DNS failure, or server down | Check `curl -fsS $BASE_URL/healthz` first |

---

## Verifying the deployment

```typescript
const r = await fetch(`${process.env.BASE_URL}/healthz`);
if (!r.ok) throw new Error(`health check failed: ${r.status}`);
console.log(await r.json());  // → { status: "ok" }
```

The SDK doesn't expose `/healthz` (it's not under `/v1`). Use global `fetch`
directly when you just need to check liveness without auth.

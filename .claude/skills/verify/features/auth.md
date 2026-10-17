# Auth

Every `/v1/*` and `/mcp` call carries a bearer JWT signed with `AUTH_SECRET`, with two exceptions. `POST /v1/auth/bootstrap` takes no bearer token: a caller proves it holds the secret with `X-Auth-Secret` and gets a token back. When `MCP_API_KEY` is set, `/mcp` also accepts that static key as the bearer value and takes the owner from an identity header. Requests without a valid token are rejected before they touch any sandbox.

## Sub-features

- `auth-required` rejects `/v1` requests without a bearer token with `401 AUTH_REQUIRED`. `POST /v1/auth/bootstrap` is exempt.
- `auth-bootstrap` issues a token for a `sub` when `X-Auth-Secret` matches.
- `auth-bootstrap-denied` rejects a wrong secret with `403 FORBIDDEN` before parsing the body.
- `auth-token-cli` mints tokens offline with `pnpm token:create`.

## How to get to it (user POV)

- Send `Authorization: Bearer <jwt>` on any `/v1` or `/mcp` request.
- `POST /v1/auth/bootstrap` with header `X-Auth-Secret` and body `{"sub":"...","expiresIn":"24h"}`.
- `AUTH_SECRET=... pnpm token:create -- --sub agent-1 [--tenant t] --expires 30d`.

## Driving it with stack.sh

Preconditions:

- Baseline from the [index](./README.md). `$S env` shows `AUTH_SECRET`.

- **No token.** Run `EXPECT=401 AS=none $S api GET /v1/sandboxes`. The body is `{"error":"unauthorized","code":"AUTH_REQUIRED"}`.
- **Wrong secret.** Run `EXPECT=403 AS=none $S api POST /v1/auth/bootstrap -H 'X-Auth-Secret: wrong' --json '{"sub":"boot"}'`. The body has `code` `FORBIDDEN`.
- **Bootstrap.** Run `eval "$($S env | grep AUTH_SECRET)"` and then `TOKEN=$(EXPECT=201 AS=none $S api POST /v1/auth/bootstrap -H "X-Auth-Secret: $AUTH_SECRET" --json '{"sub":"boot","expiresIn":"24h"}' | jq -r .token)`. `TOKEN` is a three-part JWT.
- **Use the issued token.** Run `EXPECT=200 AS=none $S api GET /v1/sandboxes -H "Authorization: Bearer $TOKEN"`. The body is `{"sandboxes":[]}` for the fresh `boot` owner.

## Gotchas

- Every `POST /v1/auth/bootstrap` counts toward a per-IP limit, successful mints included: 5 per 60 seconds by default (`BOOTSTRAP_RATE_LIMIT_MAX`, `BOOTSTRAP_RATE_LIMIT_WINDOW_MS`). The `auth` journey makes two calls, so a third run within a minute gets `429`.
- `POST /v1/auth/admin` needs `ADMIN_SECRET`, which the stack does not set. It returns `500 ADMIN_NOT_CONFIGURED` unless you pass `SERVER_ENV="ADMIN_SECRET=..." $S restart`.
- A token without a `tenant` claim resolves to the `default` tenant.

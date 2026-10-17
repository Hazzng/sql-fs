# Auth

Every `/v1/*` and `/mcp` call carries a bearer JWT signed with `AUTH_SECRET`. A caller with the secret can mint a token through `POST /v1/auth/bootstrap`. Requests without a valid token are rejected before they touch any sandbox.

## Sub-features

- `auth-required` rejects unauthenticated `/v1` requests with `401 AUTH_REQUIRED`.
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

- Bootstrap is rate-limited per IP. A burst of bad attempts returns `429` for a while.
- `POST /v1/auth/admin` needs `ADMIN_SECRET`, which the stack does not set. It returns `500 ADMIN_NOT_CONFIGURED` unless you pass `SERVER_ENV="ADMIN_SECRET=..." $S restart`.
- A token without a `tenant` claim resolves to the `default` tenant.

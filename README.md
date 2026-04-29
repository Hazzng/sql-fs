# virtualFS

A virtual file system implementation.

## Getting a JWT for API calls

All `/v1/*` endpoints require `Authorization: Bearer <JWT>`. Three ways to mint a token:

1. **Bootstrap from `AUTH_SECRET` over HTTP** (recommended for external clients/agents):

   ```bash
   curl -X POST https://<host>/v1/auth/bootstrap \
     -H "X-Auth-Secret: $AUTH_SECRET" \
     -H "Content-Type: application/json" \
     -d '{"sub":"agent-001","expiresIn":"30d"}'
   ```

   Returns `{ token, sub, tenant, expiresAt }`. The endpoint is unauthenticated by design — the `X-Auth-Secret` header is the credential, compared in constant time against the server's `AUTH_SECRET`. Add `"tenant": "<id>"` for multi-tenant deployments.

2. **CLI** (when you have the repo cloned): `AUTH_SECRET=... pnpm token:create -- --sub agent-1 --expires 30d`.

3. **Admin endpoint** (`POST /v1/auth/admin`) — requires both an existing Bearer JWT *and* `X-Admin-Secret`. Use this once you already have a token and want to mint others without exposing `AUTH_SECRET`.

## License

MIT

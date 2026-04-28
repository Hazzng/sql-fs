# IMPLEMENT — Issue #23: Harden `POST /v1/auth/admin`

> **Read this first if you're new to the issue.** The scope is limited to `src/api/`. No DB schema changes, no migration work, no `just-bash` changes. The goal is to bring one auth endpoint up to security parity with its sibling and add a missing rate-limit primitive. Plan-only document — do not start coding until you've read all of §1–§3.

---

## 1. Background — what is this and why

`virtualfs-api` mints HS256 JWTs that callers attach as `Authorization: Bearer <jwt>` to every `/v1/*` request. Tokens are produced by two endpoints:

| Endpoint | Auth required | Purpose |
|---|---|---|
| `POST /v1/auth/bootstrap` | `X-Auth-Secret` header == `AUTH_SECRET` env | First-time setup. Exempt from Bearer middleware (chicken-and-egg: how would you get the first JWT otherwise?). |
| `POST /v1/auth/admin` | Bearer JWT **and** `X-Admin-Secret` header == `ADMIN_SECRET` env | Day-2 token rotation. Mints a JWT for any `sub`/`tenant`. |

Both live in `src/api/routes/auth.ts`. The Bearer middleware that gates `/v1/*` lives in `src/api/auth.ts`; it skips bootstrap via the `UNAUTHENTICATED_PATHS` set (`src/api/auth.ts:45`).

**The asymmetry that motivates this work:** when `bootstrap` was added, it was hardened from day one (timing-safe compare, audit logs, secret-check-before-validateBody, hard-fail on missing `AUTH_SECRET`). The older `admin` handler in the same file was never brought up to parity. Issue #23 enumerates six gaps in `admin` plus one cross-cutting gap (no rate limit anywhere).

**Threat model:** the route is behind Bearer auth, so an anonymous internet attacker cannot reach it. The realistic threats are:
1. A holder of any valid Bearer token escalating to mint other `sub`s by brute-forcing `ADMIN_SECRET` (no rate limit + timing leak).
2. `ADMIN_SECRET` leaks somehow → no audit log to tell who used it or what they minted.
3. An operator misconfigures `AUTH_SECRET` → silently signs unverifiable tokens.

> **Note on issue text vs. code.** Issue #23 references `src/api/routes/admin.ts` and `POST /v1/admin/tokens`. That file/path no longer exists — the route was relocated. The current location is `POST /v1/auth/admin` in `src/api/routes/auth.ts:114-139`. All findings still apply, just at the new path. `README.md:22` is stale and must be updated.

---

## 2. Current state — exact lines

You will edit / read these files:

| File | What's there now |
|---|---|
| `src/api/routes/auth.ts:34-39` | `constantTimeEqual()` helper — has a length-leak bug (early return on length mismatch). Used by bootstrap; will be used by admin too. |
| `src/api/routes/auth.ts:41-43` | `logAudit()` helper — JSON-line stdout. Reuse as-is. |
| `src/api/routes/auth.ts:57-110` | `POST /bootstrap` — already hardened. Use it as the structural template for `/admin`. |
| `src/api/routes/auth.ts:114-139` | `POST /admin` — the handler this PR rewrites. |
| `src/api/auth.ts:45` | `UNAUTHENTICATED_PATHS = new Set(["POST /v1/auth/bootstrap"])`. Do **not** add `/admin` here — admin must stay behind Bearer. |
| `src/api/auth.ts:54-58` | Bearer middleware rejects any non-`Bearer` `Authorization` header with 401. This is why we **cannot** add an `Authorization: AdminSecret …` scheme — it would 401 before reaching the handler. |
| `src/api/lib/jwt.ts:8-14` | `SignTokenOptions`. Add optional `jti?: string`. |
| `src/api/server.ts:155-160` | Where Bearer middleware mounts and `authRoutes()` mounts. Rate-limit middleware mounts here too. |
| `src/api/__tests__/admin.test.ts` | Existing tests. Will gain ~10 new cases. |
| `plugins/virtualfs/skills/api/SETUP.md` | Operator-facing docs. Must mention new env vars. **Note:** there is no top-level `SETUP.md`; this is the only one. |
| `plugins/virtualfs/skills/api/ref/endpoints.md` | Endpoint reference. Add audit log shapes + 429. |
| `README.md:22` | Stale `POST /v1/admin/tokens` reference — fix it. |
| `CHANGELOG.md`, `package.json`, `pnpm-lock.yaml`, `src/api/openapi-spec.ts` | Per CLAUDE.md, all four version fields must be bumped together. |

---

## 3. Architectural decisions made up-front (with rationale)

A reviewer flagged six issues with the first draft of this plan. The decisions below are the resolutions; if you disagree, raise it before coding.

### 3.1. Keep `X-Admin-Secret`. **Drop** the `Authorization: AdminSecret` proposal.

The original issue text suggested moving the admin secret onto the `Authorization` header for redirect-stripping safety. This is incompatible with the current architecture: `/v1/auth/admin` lives under `/v1/*`, which the Bearer middleware (`src/api/auth.ts:54-58`) already requires for. A second auth scheme on the same header would either be 401'd by the middleware, or require us to skip Bearer for admin — which would *remove* the defense-in-depth that issue #23 explicitly calls a strength.

→ Keep `X-Admin-Secret`. File a separate ticket for redirect-safe admin auth (would need its own design — likely a dedicated `Admin-Authorization` header or moving admin off `/v1/*`).

### 3.2. Replace `constantTimeEqual()` with a SHA-256-digest compare.

The current helper (`src/api/routes/auth.ts:34-39`) returns early on length mismatch, which is itself a length oracle. Issue #23 explicitly asks for `timingSafeEqual` over equal-length SHA-256 digests. We update the shared helper, which fixes bootstrap and admin in one change.

### 3.3. Rate-limit policy is per-route, not blanket `/v1/auth/*`.

Bootstrap is unauthenticated (no `c.get("owner")`), so a per-`sub` key would crash there. Admin is authenticated, so per-`sub` is meaningful and necessary (otherwise a rotating-IP attacker bypasses per-IP). Therefore:

- `POST /v1/auth/admin` — limited by `(ip, sub)`. Either trip → 429.
- `POST /v1/auth/bootstrap` — limited by `(ip)` only.

### 3.4. Rate-limit store is in-memory and **injectable**.

Multi-replica leakage is acknowledged (a follow-up ticket will swap to Redis using the existing `getRedisClient()`). For tests, the store and clock are injectable, and a module-level default store exposes `.reset()` so `beforeEach` can wipe state between tests. Without this, the existing `admin.test.ts` will start failing as soon as the limiter is mounted.

### 3.5. `jti` is generated **before** signing, included in claims, and logged.

The audit log records the `jti`; the token also carries it. This lets an operator correlate a leaked-token incident back to the exact `admin_token_issued` log line. Add `jti?: string` to `SignTokenOptions` and `.setJti(jti)` in `signToken`.

### 3.6. Audit event names follow issue #23: `admin_token_issued` / `admin_token_denied` / `admin_token_misconfigured`.

Bootstrap's existing names (`auth_bootstrap_*`) stay as-is — they've shipped. The naming inconsistency between the two routes is an intentional, documented deviation in this PR; normalize in a follow-up ticket. Error codes (`ADMIN_NOT_CONFIGURED`, `AUTH_NOT_CONFIGURED`) stay as the more-specific values already in the code rather than the issue's `INTERNAL_ERROR`.

### 3.7. Out of scope for this PR

- Redirect-safe admin auth (see §3.1).
- Redis-backed rate limit (in-memory v1 only).
- Audit-name normalization across both routes (see §3.6).
- JWT → opaque DB tokens, mTLS — deferred per issue.

---

## 4. Phased implementation

Each phase has a single, testable outcome. Run the verification at the end of each phase before moving on. **Do not batch phases.** Type-check and lint after every phase: `pnpm typecheck && pnpm lint:fix`.

### Phase 1 — Fix the shared `constantTimeEqual` helper

**Touch:** `src/api/routes/auth.ts:34-39`.

```ts
import { createHash, timingSafeEqual } from "node:crypto";

function constantTimeEqual(a: string, b: string): boolean {
  const aDigest = createHash("sha256").update(a, "utf8").digest();
  const bDigest = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(aDigest, bDigest);
}
```

**Why first:** smallest, lowest-risk change. Bootstrap continues working (its callers always have correct length today), and we'll have the safe helper ready when admin starts using it in Phase 3.

**Verification:**
- [ ] `pnpm typecheck` passes.
- [ ] Existing bootstrap tests still pass: `pnpm test -- src/api/__tests__/bootstrap` (or wherever they live).
- [ ] New unit test: `constantTimeEqual` returns `false` for two strings of different lengths and does **not** early-return (assert by checking it took the digest path — easiest proxy is to spy on `createHash`).

### Phase 2 — Plumb `jti` through `signToken`

**Touch:** `src/api/lib/jwt.ts`.

```ts
export interface SignTokenOptions {
  sub: string;
  tenant?: string;
  expiresIn?: string;
  secret: string;
  jti?: string;          // NEW
}

// in signToken(...)
if (jti !== undefined) {
  jwt.setJti(jti);
}
```

**Verification:**
- [ ] Unit test: `signToken({ ..., jti: "abc-123" })` produces a token whose decoded payload has `jti === "abc-123"`.
- [ ] Unit test: omitting `jti` produces a token with no `jti` claim (regression — bootstrap still works).
- [ ] `pnpm typecheck && pnpm test:unit` green.

### Phase 3 — Harden `POST /v1/auth/admin`

**Touch:** `src/api/routes/auth.ts:114-139`. Replace the single-handler `router.post("/admin", validateBody(...), async (c) => { ... })` form with the same three-arg pattern bootstrap uses. Structure:

```ts
import { randomUUID } from "node:crypto";

router.post(
  "/admin",
  // 1) Pre-middleware: secret check BEFORE body parsing.
  async (c, next) => {
    const adminSecret = process.env.ADMIN_SECRET;
    const ip = c.req.header("x-forwarded-for")?.split(",")[0].trim()
      ?? c.req.header("x-real-ip") ?? "unknown";
    const ua = c.req.header("user-agent") ?? "";
    const caller = c.get("owner");

    if (!adminSecret) {
      logAudit("admin_token_misconfigured", { ts: new Date().toISOString(), ip, ua, caller });
      return c.json(
        { error: "admin_not_configured", code: "ADMIN_NOT_CONFIGURED" },
        500 as ContentfulStatusCode,
      );
    }

    const provided = c.req.header("X-Admin-Secret");
    if (!provided || !constantTimeEqual(provided, adminSecret)) {
      logAudit("admin_token_denied", {
        ts: new Date().toISOString(),
        ip, ua, caller,
        reason: provided ? "mismatch" : "missing_header",
      });
      return c.json({ error: "forbidden", code: "FORBIDDEN" }, 403 as ContentfulStatusCode);
    }
    await next();
  },
  // 2) Body validation — only runs once secret is verified.
  validateBody(tokenBodySchema),
  // 3) Handler.
  async (c) => {
    const ip = c.req.header("x-forwarded-for")?.split(",")[0].trim()
      ?? c.req.header("x-real-ip") ?? "unknown";
    const ua = c.req.header("user-agent") ?? "";
    const caller = c.get("owner");
    const callerTenant = c.get("tenant");

    const authSecret = process.env.AUTH_SECRET;
    if (!authSecret) {
      logAudit("admin_token_misconfigured", {
        ts: new Date().toISOString(), ip, ua, caller, reason: "auth_secret_unset",
      });
      return c.json(
        { error: "auth_not_configured", code: "AUTH_NOT_CONFIGURED" },
        500 as ContentfulStatusCode,
      );
    }

    const { sub, tenant, expiresIn = "30d" } = c.get("body");
    if (tenant !== undefined && !loadTenantConfig().hasTenant(tenant)) {
      logAudit("admin_token_denied", {
        ts: new Date().toISOString(), ip, ua, caller, reason: "unknown_tenant", tenant,
      });
      return c.json({ error: "unknown_tenant", code: "INVALID_INPUT" }, 400 as ContentfulStatusCode);
    }

    const jti = randomUUID();
    const token = await signToken({ sub, tenant, expiresIn, secret: authSecret, jti });
    const at = expiresAt(expiresIn);

    logAudit("admin_token_issued", {
      ts: new Date().toISOString(),
      caller, callerTenant,
      sub, tenant, expiresIn, jti, ip, ua,
      // NB: never log `token`.
    });

    return c.json({ token, sub, tenant, expiresAt: at }, 201 as ContentfulStatusCode);
  },
);
```

**Verification:**
- [ ] All existing `admin.test.ts` cases pass (you may need a `beforeEach(() => vi.spyOn(console, "log"))` cleanup, but no assertions should change).
- [ ] New unit tests (each one `it()`):
  - `returns 403 with timing-safe compare on wrong X-Admin-Secret`
  - `returns 403 when X-Admin-Secret header is missing`
  - `returns 500 ADMIN_NOT_CONFIGURED when ADMIN_SECRET is unset`
  - `returns 500 AUTH_NOT_CONFIGURED when AUTH_SECRET is unset`
  - `does not run validateBody when secret is wrong` — POST a body that would fail Zod (e.g. `{ sub: "" }`) with a wrong secret; expect 403, not 400
  - `emits admin_token_issued audit log` — capture `console.log`, parse JSON, assert shape, assert `jti` matches the decoded token's `jti`, assert the token string is **not** in the log
  - `emits admin_token_denied audit log on 403`
- [ ] `pnpm typecheck && pnpm lint:fix && pnpm test:unit` green.

### Phase 4 — Rate-limit primitive

**New file:** `src/api/rate-limit.ts`.

Sketch:
```ts
import type { Context, MiddlewareHandler } from "hono";

export interface RateLimitDecision {
  allowed: boolean;
  resetAt: number;     // ms epoch
  remaining: number;
}
export interface RateLimitStore {
  hit(key: string, windowMs: number, max: number, now: number): RateLimitDecision;
  reset(): void;
}

export class InMemoryRateLimitStore implements RateLimitStore {
  // Map<key, { count: number; resetAt: number }>
  // hit(): on first hit OR after window expiry, reset counter to 1
  //        otherwise increment; allowed = count <= max
  // reset(): clear the map (test hook)
  // Lazy GC: every 1024 hits, drop entries with resetAt < now
}

export const defaultRateLimitStore = new InMemoryRateLimitStore();

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  scope: "admin" | "bootstrap";
  keys: (c: Context) => string[];   // 1+ keys; trip on any
  store?: RateLimitStore;
  now?: () => number;
}
export function rateLimit(opts: RateLimitOptions): MiddlewareHandler {
  // For each key, call store.hit(); if any returns allowed=false:
  //   logAudit("auth_rate_limited", { ts, scope, keys, ip, sub, path })
  //   c.header("Retry-After", String(Math.ceil((resetAt - now)/1000)))
  //   return 429 { error: "rate_limited", code: "RATE_LIMITED" }
  // Otherwise next().
}

// Tiny env helpers (or reuse src/redis/config.ts:parseNonNegativeInt if shape fits).
export function parseEnvInt(name: string, fallback: number): number;
export function parseEnvMs(name: string, fallback: number): number;
```

**Wire-up in `src/api/server.ts`** — mount per-route, after Bearer middleware so `c.get("owner")` is set for admin:

```ts
// In src/api/routes/auth.ts (or server.ts — pick one and stay consistent):
const adminLimiter = rateLimit({
  windowMs: parseEnvMs("ADMIN_RATE_LIMIT_WINDOW_MS", 60_000),
  max: parseEnvInt("ADMIN_RATE_LIMIT_MAX", 5),
  scope: "admin",
  keys: (c) => {
    const ip = clientIp(c);                  // shared helper or inline
    const sub = c.get("owner") ?? "anon";
    return [`admin:ip:${ip}`, `admin:sub:${sub}`];
  },
});

const bootstrapLimiter = rateLimit({
  windowMs: parseEnvMs("BOOTSTRAP_RATE_LIMIT_WINDOW_MS", 60_000),
  max: parseEnvInt("BOOTSTRAP_RATE_LIMIT_MAX", 5),
  scope: "bootstrap",
  keys: (c) => [`bootstrap:ip:${clientIp(c)}`],
});

router.use("/admin", adminLimiter);
router.use("/bootstrap", bootstrapLimiter);
```

**Verification:**
- [ ] Unit tests with injected store + fake clock:
  - `enforces 5/min per IP on /admin` — 6 requests in window, 6th = 429 with `Retry-After`
  - `enforces 5/min per Bearer sub on /admin` — same caller, rotating IPs, still throttles
  - `bootstrap is rate-limited per IP only` — 6 requests, 6th = 429
  - `bootstrap is NOT subject to per-sub limit` — calling `c.get("owner")` would crash; assert no crash and only one key checked
  - `429 emits auth_rate_limited audit log with {ts, scope, ip, sub, path}`
  - `window rolls over` — advance fake clock past `windowMs`, request succeeds again
- [ ] Existing test suites pass with `beforeEach(() => defaultRateLimitStore.reset())` added wherever the tests issue >5 requests.
- [ ] `pnpm test:unit` green.

### Phase 5 — Docs + version bump

**Touch (in this exact set, per CLAUDE.md):**

1. `plugins/virtualfs/skills/api/SETUP.md`:
   - Document new env vars: `ADMIN_RATE_LIMIT_WINDOW_MS` (default 60000), `ADMIN_RATE_LIMIT_MAX` (default 5), `BOOTSTRAP_RATE_LIMIT_WINDOW_MS`, `BOOTSTRAP_RATE_LIMIT_MAX`.
   - Document audit log events: `admin_token_issued`, `admin_token_denied`, `admin_token_misconfigured`, `auth_rate_limited`.
   - Document `429 RATE_LIMITED` with `Retry-After`.
2. `plugins/virtualfs/skills/api/ref/endpoints.md`:
   - Add 429 row to `POST /v1/auth/admin` and `POST /v1/auth/bootstrap`.
   - Add audit-log shape examples.
3. `README.md:22`: replace `POST /v1/admin/tokens` → `POST /v1/auth/admin`.
4. `CHANGELOG.md`: prepend `## [0.2.8] - 2026-04-28` with bullets under `Changed` (timing-safe compare uses sha256 digest; admin handler order; rate limit on auth routes) and `Added` (`jti` claim on admin tokens; `admin_token_*` audit events; `auth_rate_limited` audit event).
5. `package.json`: `"version": "0.2.8"`.
6. `pnpm-lock.yaml`: regenerate via `pnpm install --lockfile-only`.
7. `src/api/openapi-spec.ts`: `info.version = "0.2.8"`; add `429 RATE_LIMITED` response to both auth ops.
8. `.env.example`: add commented `ADMIN_SECRET=` line if missing (verify — currently absent).

**Verification:**
- [ ] All four version locations match `0.2.8` (CHANGELOG, package.json, pnpm-lock.yaml, openapi-spec.ts).
- [ ] `pnpm typecheck && pnpm lint:fix && pnpm test` all green.
- [ ] `grep -rn "v1/admin/tokens" .` returns no hits except in `tasks/` (historical) and `CHANGELOG.md`.

---

## 5. Manual end-to-end testing (docker postgres + redis + local API)

Automated tests prove the units work. This section proves the assembled service behaves correctly for an operator.

### 5.1. Prerequisites

```bash
# from the repo root
cp .env.example .env   # if not already present
```

Edit `.env` to set:
```bash
FS_BACKEND=postgres
DATABASE_URL=postgres://postgres:test@localhost:5432/virtualfs
DATABASE_DIRECT_URL=postgres://postgres:test@localhost:5432/virtualfs
PORT=8080
AUTH_SECRET=local-auth-secret-please-change
ADMIN_SECRET=local-admin-secret-please-change
REDIS_URL=redis://localhost:6379
SESSION_IDLE_MS=600000

# new in this PR — defaults are 60000ms / 5 req
ADMIN_RATE_LIMIT_WINDOW_MS=60000
ADMIN_RATE_LIMIT_MAX=5
BOOTSTRAP_RATE_LIMIT_WINDOW_MS=60000
BOOTSTRAP_RATE_LIMIT_MAX=5
```

### 5.2. Bring up dependencies

```bash
docker compose -f docker-compose.local.yml up -d pg redis
docker compose -f docker-compose.local.yml ps     # both healthy
```

Confirm:
```bash
psql "postgres://postgres:test@localhost:5432/virtualfs" -c '\dt'   # tables list (post-migration)
redis-cli -u redis://localhost:6379 PING                            # PONG
```

### 5.3. Start the API locally

```bash
pnpm install
pnpm dev    # runs migrations, then tsx watch on PORT=8080
```

Tail logs in a second terminal — the audit lines we add are JSON to stdout. A small jq filter helps:
```bash
# in the dev-server terminal, pipe through:
pnpm dev 2>&1 | tee /tmp/api.log
# in a third terminal:
tail -f /tmp/api.log | jq -c 'select(.event | test("admin_token|auth_rate|auth_bootstrap"))'
```

### 5.4. E2E test script

Run each block in order. Each block names the case, the command, and what to look for. **All curl commands assume `bash`.**

#### 5.4.1. Bootstrap a Bearer token (sanity: nothing in this PR breaks the bootstrap path)

```bash
export AUTH_SECRET="local-auth-secret-please-change"
export ADMIN_SECRET="local-admin-secret-please-change"

BEARER=$(curl -sf -X POST http://localhost:8080/v1/auth/bootstrap \
  -H "X-Auth-Secret: $AUTH_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"sub":"e2e-tester","expiresIn":"24h"}' | jq -r .token)

echo "$BEARER" | cut -c1-30   # eyJ...
```

**Expect:** 201, valid JWT, audit log line `{"event":"auth_bootstrap_issued",...}`.

#### 5.4.2. Happy path — admin mints a token

```bash
curl -sf -X POST http://localhost:8080/v1/auth/admin \
  -H "Authorization: Bearer $BEARER" \
  -H "X-Admin-Secret: $ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"sub":"freshly-minted","expiresIn":"30d"}' | jq
```

**Expect:**
- HTTP 201, body `{token, sub:"freshly-minted", tenant:null, expiresAt}`.
- Audit log: `{"event":"admin_token_issued","caller":"e2e-tester","sub":"freshly-minted","jti":"<uuid>",...}`.
- Decode the returned token (`echo "<token>" | cut -d. -f2 | base64 -d`) — `jti` field must match the one in the audit log.
- The token string itself must **not** appear in any log line.

#### 5.4.3. Wrong `X-Admin-Secret` — 403, no schema leak, audit denial

```bash
# Body is intentionally invalid (sub is empty). Pre-PR behavior would 400 with Zod errors.
curl -i -X POST http://localhost:8080/v1/auth/admin \
  -H "Authorization: Bearer $BEARER" \
  -H "X-Admin-Secret: wrong-secret" \
  -H "Content-Type: application/json" \
  -d '{"sub":""}'
```

**Expect:**
- HTTP 403 with `{"error":"forbidden","code":"FORBIDDEN"}` (NOT 400 — proves secret check runs before validateBody).
- Audit log: `{"event":"admin_token_denied","reason":"mismatch",...}`.

#### 5.4.4. Missing `X-Admin-Secret` — 403 with `reason: "missing_header"`

```bash
curl -i -X POST http://localhost:8080/v1/auth/admin \
  -H "Authorization: Bearer $BEARER" \
  -H "Content-Type: application/json" \
  -d '{"sub":"foo"}'
```

**Expect:** HTTP 403, audit log `reason:"missing_header"`.

#### 5.4.5. `ADMIN_SECRET` unset — 500 `ADMIN_NOT_CONFIGURED`

In a separate shell, restart the dev server with the var unset:
```bash
ADMIN_SECRET= pnpm dev   # or unset and restart your shell session
```

```bash
curl -i -X POST http://localhost:8080/v1/auth/admin \
  -H "Authorization: Bearer $BEARER" \
  -H "X-Admin-Secret: anything" \
  -H "Content-Type: application/json" \
  -d '{"sub":"foo"}'
```

**Expect:** HTTP 500, `{"error":"admin_not_configured","code":"ADMIN_NOT_CONFIGURED"}`. Audit log: `admin_token_misconfigured`. Restore `ADMIN_SECRET` afterward.

#### 5.4.6. `AUTH_SECRET` unset — 500 `AUTH_NOT_CONFIGURED`

This is harder to test because Bearer middleware also requires `AUTH_SECRET` (the request would 401 first). Test by *temporarily* clearing `AUTH_SECRET` mid-process is not possible; instead this case is fully covered by the unit test in Phase 3. Skip in the E2E run and note it in the PR description.

#### 5.4.7. Rate limit — per-IP

Restore `ADMIN_SECRET` and Bearer. Hit the endpoint 6 times back-to-back with **wrong** secret (cheaper, same limiter):

```bash
for i in $(seq 1 6); do
  echo "--- attempt $i ---"
  curl -s -o /dev/null -w "status=%{http_code} retry-after=%{header_retry_after}\n" \
    -X POST http://localhost:8080/v1/auth/admin \
    -H "Authorization: Bearer $BEARER" \
    -H "X-Admin-Secret: wrong" \
    -H "Content-Type: application/json" \
    -d '{"sub":"foo"}'
done
```

**Expect:** attempts 1–5 return 403; attempt 6 returns 429 with `Retry-After` header. Audit log shows `auth_rate_limited` with `scope:"admin"`. Wait `ADMIN_RATE_LIMIT_WINDOW_MS` (60s default) and confirm requests succeed again.

#### 5.4.8. Rate limit — per-`sub`

Lower the per-IP cap by setting `ADMIN_RATE_LIMIT_MAX=100` and restart. Then hit from rotating IPs (use `X-Forwarded-For`) but the same Bearer:

```bash
for i in $(seq 1 6); do
  curl -s -o /dev/null -w "ip=%{header_x_forwarded_for_sent} status=%{http_code}\n" \
    -X POST http://localhost:8080/v1/auth/admin \
    -H "Authorization: Bearer $BEARER" \
    -H "X-Forwarded-For: 10.0.0.$i" \
    -H "X-Admin-Secret: wrong" \
    -H "Content-Type: application/json" \
    -d '{"sub":"foo"}'
done
```

**Expect:** attempts 1–5 return 403; attempt 6 returns 429 (per-`sub` key tripped even though IP keys would still allow). Restore `ADMIN_RATE_LIMIT_MAX=5`.

#### 5.4.9. Bootstrap rate limit — per-IP only, no crash on missing `sub`

```bash
for i in $(seq 1 6); do
  curl -s -o /dev/null -w "status=%{http_code}\n" \
    -X POST http://localhost:8080/v1/auth/bootstrap \
    -H "X-Auth-Secret: wrong" \
    -H "Content-Type: application/json" \
    -d '{"sub":"x"}'
done
```

**Expect:** attempts 1–5 return 403; attempt 6 returns 429. **No 500s** (proves bootstrap limiter doesn't try to read `c.get("owner")`).

#### 5.4.10. Sanity — token returned in 5.4.2 actually authenticates

```bash
NEW_TOKEN=<copy from 5.4.2 response>
curl -i http://localhost:8080/v1/sandboxes -H "Authorization: Bearer $NEW_TOKEN"
```

**Expect:** HTTP 200, JSON list (possibly empty). Proves the `jti` plumbing didn't break verification.

### 5.5. Tear-down

```bash
docker compose -f docker-compose.local.yml down -v
```

---

## 6. Pre-merge checklist

Copy this into the PR description and tick off:

- [ ] Phase 1: SHA-256 digest compare in `constantTimeEqual`. Bootstrap regression tests pass.
- [ ] Phase 2: `jti` plumbed through `signToken`. Unit tests green.
- [ ] Phase 3: `/v1/auth/admin` rewritten — pre-middleware order, audit logs, hard-fail on missing `AUTH_SECRET`, `jti` in claims+log. New unit tests added.
- [ ] Phase 4: `src/api/rate-limit.ts` added. Per-route limiters mounted. Default store + injectable for tests. Existing tests reset the store in `beforeEach`.
- [ ] Phase 5: Docs (SETUP.md, endpoints.md, README.md). All four version fields bumped to `0.2.8`. CHANGELOG written.
- [ ] All E2E steps in §5.4.1–5.4.10 pass on a fresh `docker compose up`.
- [ ] `pnpm typecheck && pnpm lint:fix && pnpm test` all green.
- [ ] PR description names the deferred items (§3.1, §3.4 Redis, §3.6 audit-name normalization) and links follow-up tickets.
- [ ] No `Co-Authored-By` trailer on commits (per repo convention).

---

## 7. File-by-file change summary

| File | Change |
|---|---|
| `src/api/routes/auth.ts` | `constantTimeEqual` → sha256 digest. `/admin` handler split into pre-middleware + validateBody + handler. `admin_token_*` audit logs. `jti` from `randomUUID()`. Mount admin/bootstrap rate limiters. |
| `src/api/lib/jwt.ts` | `jti?: string` in `SignTokenOptions`; `jwt.setJti(jti)` when present. |
| `src/api/rate-limit.ts` | **NEW.** `RateLimitStore` interface, `InMemoryRateLimitStore`, `defaultRateLimitStore`, `rateLimit()` middleware factory, env helpers. |
| `src/api/server.ts` | Import + mount limiters. (Or in `routes/auth.ts` — pick one.) |
| `src/api/openapi-spec.ts` | 429 response on both auth ops. `info.version = "0.2.8"`. |
| `src/api/__tests__/admin.test.ts` | ~7 new cases (Phase 3). `beforeEach` resets store + log spy. |
| `src/api/__tests__/bootstrap.test.ts` (new or existing) | Rate-limit cases. |
| `src/api/__tests__/rate-limit.test.ts` (new) | Store + middleware unit tests with fake clock. |
| `plugins/virtualfs/skills/api/SETUP.md` | Env vars, audit events, 429. |
| `plugins/virtualfs/skills/api/ref/endpoints.md` | 429 row, audit shapes. |
| `README.md` | `POST /v1/admin/tokens` → `POST /v1/auth/admin` (line 22). |
| `.env.example` | Add `ADMIN_SECRET=` and rate-limit env stubs. |
| `CHANGELOG.md` | New `## [0.2.8] - 2026-04-28` section. |
| `package.json` | `"version": "0.2.8"`. |
| `pnpm-lock.yaml` | Regenerated via `pnpm install --lockfile-only`. |

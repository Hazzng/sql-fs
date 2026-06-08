/**
 * JWT/HMAC auth middleware for Hono.
 * US-057: Verifies HS256 JWT tokens signed with AUTH_SECRET env var.
 *
 * Usage (preferred, tenant-aware):
 *   const tenantConfig = loadTenantConfig();
 *   app.use("/v1/*", createAuthMiddleware(tenantConfig));
 *   // downstream: c.get("owner") → sub claim, c.get("tenant") → tenant id
 *
 * Usage (legacy lazy):
 *   app.use("/v1/*", authMiddleware);
 *   // lazily resolves TenantConfig from env on first request
 *
 * Static MCP auth (issue #117 — external clients that send fixed headers, e.g.
 * LibreChat, that cannot mint a per-request JWT):
 *   const staticAuth = loadStaticMcpAuthConfig(tenantConfig);
 *   app.use("/mcp", createAuthMiddleware(tenantConfig, { staticAuth }));
 *   // A Bearer token equal to MCP_API_KEY is accepted without JWT verification;
 *   // the sandbox owner/sub is derived from a forwarded identity header.
 */

import type { Context, Next } from "hono";
import { createMiddleware } from "hono/factory";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { jwtVerify } from "jose";
import { constantTimeEqual } from "./lib/constant-time.js";
import { DEFAULT_TENANT_ID, type TenantConfig, loadTenantConfig } from "./tenants.js";

export type AuthVariables = {
	owner: string;
	tenant: string;
};

const UNAUTHORIZED = 401 as ContentfulStatusCode;

/**
 * Static-header auth configuration for the MCP endpoint.
 *
 * When present, a Bearer token byte-equal to `apiKey` is accepted without JWT
 * verification, and the principal (`owner`/`sub`) is derived from the request's
 * `identityHeader`. This lets MCP clients that can only send fixed headers
 * (e.g. LibreChat) connect while still giving each forwarded end-user an
 * isolated sandbox owner.
 */
export interface StaticMcpAuthConfig {
	/** Pre-shared secret expected verbatim in `Authorization: Bearer <apiKey>`. */
	readonly apiKey: string;
	/** Lowercased name of the header carrying the end-user identity → becomes `owner`. */
	readonly identityHeader: string;
	/** Owner used when the identity header is absent. When unset, a missing header is rejected. */
	readonly defaultSub?: string;
	/** Tenant id assigned to every static-auth request. Validated against the tenant config. */
	readonly tenant: string;
}

export interface AuthMiddlewareOptions {
	/** When set, enables static-header (API-key) auth in addition to JWT auth. */
	readonly staticAuth?: StaticMcpAuthConfig;
}

/** Upper bound on a forwarded identity value, mirroring a sane username/email length. */
const MAX_IDENTITY_LENGTH = 256;
/** RFC 7230 token chars — the valid charset for an HTTP header field name. */
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** Minimum length for MCP_API_KEY — it guards remote code execution, so weak keys are refused. */
const MIN_API_KEY_LENGTH = 16;

/**
 * Normalize and validate a forwarded identity value.
 *
 * Rejects empty/overlong values and any ASCII control character (< 0x20 or
 * 0x7F) — those have no place in a username/email and could corrupt logs or
 * downstream keys.
 *
 * @param raw - Raw header value (or env value).
 * @returns The trimmed identity, or `undefined` when absent/empty/too long/control-char-laden.
 */
export function sanitizeIdentity(raw: string | undefined): string | undefined {
	if (raw === undefined) return undefined;
	const trimmed = raw.trim();
	if (trimmed.length === 0 || trimmed.length > MAX_IDENTITY_LENGTH) return undefined;
	for (let i = 0; i < trimmed.length; i++) {
		const code = trimmed.charCodeAt(i);
		if (code < 0x20 || code === 0x7f) return undefined;
	}
	return trimmed;
}

/**
 * Build the static MCP auth config from the environment.
 *
 * Static auth is OFF unless `MCP_API_KEY` is set, so existing deployments keep
 * JWT-only behaviour on `/mcp` with no change. Misconfiguration throws at load
 * time (fail-fast at startup) rather than per-request.
 *
 * @param tenantConfig - Active tenant config, used to validate `MCP_STATIC_TENANT`.
 * @param env - Environment to read from. Defaults to `process.env`.
 * @returns The config, or `undefined` when `MCP_API_KEY` is unset.
 * @throws If `MCP_API_KEY` is too short, the identity header name is invalid,
 *   `MCP_DEFAULT_SUB` is malformed, or `MCP_STATIC_TENANT` is not configured.
 */
export function loadStaticMcpAuthConfig(
	tenantConfig: TenantConfig,
	env: NodeJS.ProcessEnv = process.env,
): StaticMcpAuthConfig | undefined {
	const apiKey = env.MCP_API_KEY;
	if (apiKey === undefined || apiKey.length === 0) return undefined;
	if (apiKey.length < MIN_API_KEY_LENGTH) {
		throw new Error(`MCP_API_KEY must be at least ${MIN_API_KEY_LENGTH} characters (use a long random value).`);
	}

	const identityHeader = (env.MCP_IDENTITY_HEADER ?? "x-librechat-user-id").trim().toLowerCase();
	if (!HEADER_NAME_PATTERN.test(identityHeader)) {
		throw new Error(`MCP_IDENTITY_HEADER "${identityHeader}" is not a valid HTTP header name.`);
	}

	let defaultSub: string | undefined;
	const rawDefaultSub = env.MCP_DEFAULT_SUB;
	if (rawDefaultSub !== undefined && rawDefaultSub.length > 0) {
		defaultSub = sanitizeIdentity(rawDefaultSub);
		if (defaultSub === undefined) {
			throw new Error("MCP_DEFAULT_SUB is invalid (must be ≤256 chars and contain no control characters).");
		}
	}

	const tenant = env.MCP_STATIC_TENANT ?? DEFAULT_TENANT_ID;
	if (!tenantConfig.hasTenant(tenant)) {
		throw new Error(`MCP_STATIC_TENANT "${tenant}" is not a configured tenant.`);
	}

	return { apiKey, identityHeader, defaultSub, tenant };
}

/**
 * Resolve the principal for a static-auth request and stash it on the context.
 * Returns a 401 response when the identity cannot be resolved or the configured
 * static tenant is (no longer) known.
 */
async function handleStaticAuth(
	c: Context<{ Variables: AuthVariables }>,
	next: Next,
	tenantConfig: TenantConfig,
	staticAuth: StaticMcpAuthConfig,
): Promise<Response | undefined> {
	const rawIdentity = c.req.header(staticAuth.identityHeader);

	let owner: string;
	if (rawIdentity !== undefined) {
		const sanitized = sanitizeIdentity(rawIdentity);
		if (sanitized === undefined) {
			return c.json({ error: "invalid_identity", code: "AUTH_IDENTITY_INVALID" }, UNAUTHORIZED);
		}
		owner = sanitized;
	} else if (staticAuth.defaultSub !== undefined) {
		owner = staticAuth.defaultSub;
	} else {
		return c.json({ error: "identity_required", code: "AUTH_IDENTITY_REQUIRED" }, UNAUTHORIZED);
	}

	if (!tenantConfig.hasTenant(staticAuth.tenant)) {
		return c.json({ error: "unknown_tenant", code: "AUTH_UNKNOWN_TENANT" }, UNAUTHORIZED);
	}

	c.set("owner", owner);
	c.set("tenant", staticAuth.tenant);
	await next();
}

/**
 * Build a tenant-aware auth middleware.
 *
 * - Verifies the HS256 JWT using `process.env.AUTH_SECRET` (read per-request).
 * - Resolves the tenant from the `tenant` claim, falling back to `DEFAULT_TENANT_ID`
 *   so legacy tokens work unchanged in single-tenant deployments.
 * - Rejects the request with 401 `AUTH_UNKNOWN_TENANT` when the claimed tenant
 *   is not configured.
 * - When `options.staticAuth` is set, a Bearer token equal to the configured
 *   API key takes a separate path (identity-header → owner). Any other Bearer
 *   token falls through to JWT verification, so JWT clients keep working.
 *
 * @param tenantConfig - The active tenant configuration.
 * @param options - Optional features (e.g. static MCP auth).
 */
/**
 * Paths under /v1/* that are intentionally exempt from Bearer auth because they
 * are themselves credential-bootstrap endpoints (chicken-and-egg). Keep this
 * list tiny — every entry is an explicit decision to expose the route to
 * unauthenticated callers (the route handler is responsible for its own
 * authorization, e.g. AUTH_SECRET via timing-safe compare).
 */
const UNAUTHENTICATED_PATHS = new Set<string>(["POST /v1/auth/bootstrap"]);

export function createAuthMiddleware(tenantConfig: TenantConfig, options: AuthMiddlewareOptions = {}) {
	const staticAuth = options.staticAuth;
	return createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
		const requestKey = `${c.req.method.toUpperCase()} ${c.req.path}`;
		if (UNAUTHENTICATED_PATHS.has(requestKey)) {
			return next();
		}

		const authHeader = c.req.header("Authorization");

		if (!authHeader?.startsWith("Bearer ")) {
			return c.json({ error: "unauthorized", code: "AUTH_REQUIRED" }, UNAUTHORIZED);
		}

		const token = authHeader.slice(7);

		// Static MCP API-key path. Checked before JWT verification so a fixed-header
		// client can authenticate; any non-matching token falls through to JWT.
		if (staticAuth !== undefined && constantTimeEqual(token, staticAuth.apiKey)) {
			return handleStaticAuth(c, next, tenantConfig, staticAuth);
		}

		const secret = process.env.AUTH_SECRET;

		if (!secret) {
			return c.json({ error: "unauthorized", code: "AUTH_REQUIRED" }, UNAUTHORIZED);
		}

		let payload: Awaited<ReturnType<typeof jwtVerify>>["payload"];
		try {
			const result = await jwtVerify(token, new TextEncoder().encode(secret), {
				algorithms: ["HS256"],
			});
			payload = result.payload;
		} catch {
			return c.json({ error: "invalid_token", code: "AUTH_INVALID" }, UNAUTHORIZED);
		}

		const sub = payload.sub;
		if (!sub) {
			return c.json({ error: "invalid_token", code: "AUTH_INVALID" }, UNAUTHORIZED);
		}

		const rawTenant = (payload as { tenant?: unknown }).tenant;
		const tenant = typeof rawTenant === "string" && rawTenant.length > 0 ? rawTenant : DEFAULT_TENANT_ID;

		if (!tenantConfig.hasTenant(tenant)) {
			return c.json({ error: "unknown_tenant", code: "AUTH_UNKNOWN_TENANT" }, UNAUTHORIZED);
		}

		c.set("owner", sub);
		c.set("tenant", tenant);
		await next();
	});
}

/**
 * Legacy lazy auth middleware. Resolves the tenant config from env on first
 * request and caches it for the process lifetime. Prefer
 * `createAuthMiddleware(tenantConfig)` in new call sites.
 */
let cachedLegacyMiddleware: ReturnType<typeof createAuthMiddleware> | undefined;

export const authMiddleware = createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
	if (cachedLegacyMiddleware === undefined) {
		cachedLegacyMiddleware = createAuthMiddleware(loadTenantConfig());
	}
	return cachedLegacyMiddleware(c, next);
});

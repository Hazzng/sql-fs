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
 */

import { createMiddleware } from "hono/factory";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { jwtVerify } from "jose";
import { DEFAULT_TENANT_ID, type TenantConfig, loadTenantConfig } from "./tenants.js";

export type AuthVariables = {
	owner: string;
	tenant: string;
};

const UNAUTHORIZED = 401 as ContentfulStatusCode;

/**
 * Build a tenant-aware auth middleware.
 *
 * - Verifies the HS256 JWT using `process.env.AUTH_SECRET` (read per-request).
 * - Resolves the tenant from the `tenant` claim, falling back to `DEFAULT_TENANT_ID`
 *   so legacy tokens work unchanged in single-tenant deployments.
 * - Rejects the request with 401 `AUTH_UNKNOWN_TENANT` when the claimed tenant
 *   is not configured.
 *
 * @param tenantConfig - The active tenant configuration.
 */
export function createAuthMiddleware(tenantConfig: TenantConfig) {
	return createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
		const authHeader = c.req.header("Authorization");

		if (!authHeader?.startsWith("Bearer ")) {
			return c.json({ error: "unauthorized", code: "AUTH_REQUIRED" }, UNAUTHORIZED);
		}

		const token = authHeader.slice(7);
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

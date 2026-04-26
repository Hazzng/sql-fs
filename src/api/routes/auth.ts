/**
 * Bootstrap auth route.
 * Issue #27: Lets external clients exchange AUTH_SECRET for a JWT without a
 * pre-existing token, breaking the circular dependency on POST /v1/admin/tokens.
 *
 * POST /v1/auth/bootstrap
 *   X-Auth-Secret: <AUTH_SECRET>
 *   Content-Type: application/json
 *   { "sub": "...", "tenant?": "...", "expiresIn?": "30d" | "1y" | "24h" | "never" }
 *
 * This route is intentionally exempt from the /v1/* Bearer middleware (see
 * createAuthMiddleware). Authorization is the AUTH_SECRET header; comparison
 * is constant-time. See issue #23 for the matching hardening on /v1/admin/tokens.
 */

import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { signToken } from "../lib/jwt.js";
import { loadTenantConfig } from "../tenants.js";
import { validateBody } from "../validation.js";

const bootstrapBodySchema = z.object({
	sub: z.string().min(1, "sub is required"),
	tenant: z
		.string()
		.regex(/^[A-Za-z0-9_.-]+$/, "tenant must match [A-Za-z0-9_.-]+")
		.optional(),
	expiresIn: z.enum(["30d", "1y", "24h", "never"]).optional(),
});

const EXPIRES_IN_SECONDS: Record<string, number> = {
	"24h": 86400,
	"30d": 2592000,
	"1y": 31536000,
};

function constantTimeEqual(a: string, b: string): boolean {
	const aBuf = Buffer.from(a, "utf8");
	const bBuf = Buffer.from(b, "utf8");
	if (aBuf.length !== bBuf.length) return false;
	return timingSafeEqual(aBuf, bBuf);
}

function logAudit(event: string, fields: Record<string, unknown>): void {
	console.log(JSON.stringify({ event, ...fields }));
}

export function authRoutes(): Hono {
	const router = new Hono();

	router.post(
		"/bootstrap",
		async (c, next) => {
			// Authenticate with AUTH_SECRET *before* parsing the body, so callers
			// without the secret cannot probe the body schema with cheap 400s
			// (mirrors the fix proposed for #23 on /v1/admin/tokens).
			const authSecret = process.env.AUTH_SECRET;
			const ip = c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? "unknown";
			const ua = c.req.header("user-agent") ?? "";

			if (!authSecret) {
				logAudit("auth_bootstrap_misconfigured", { ip, ua });
				return c.json({ error: "auth_not_configured", code: "AUTH_NOT_CONFIGURED" }, 500 as ContentfulStatusCode);
			}

			const provided = c.req.header("X-Auth-Secret");
			if (!provided || !constantTimeEqual(provided, authSecret)) {
				logAudit("auth_bootstrap_denied", { ip, ua, reason: provided ? "mismatch" : "missing_header" });
				return c.json({ error: "forbidden", code: "FORBIDDEN" }, 403 as ContentfulStatusCode);
			}

			await next();
		},
		validateBody(bootstrapBodySchema),
		async (c) => {
			const ip = c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? "unknown";
			const ua = c.req.header("user-agent") ?? "";
			const authSecret = process.env.AUTH_SECRET;
			if (!authSecret) {
				logAudit("auth_bootstrap_misconfigured", { ip, ua });
				return c.json({ error: "auth_not_configured", code: "AUTH_NOT_CONFIGURED" }, 500 as ContentfulStatusCode);
			}

			const {
				sub,
				tenant,
				expiresIn = "30d",
			} = c.get("body") as {
				sub: string;
				tenant?: string;
				expiresIn?: "30d" | "1y" | "24h" | "never";
			};

			// Resolve tenants lazily per request so tests that mutate
			// TENANT_DATABASES at runtime — and any future hot-reload of tenant
			// config — are honored. Mirrors the admin token route.
			const config = loadTenantConfig();
			if (tenant !== undefined && !config.hasTenant(tenant)) {
				logAudit("auth_bootstrap_denied", { ip, ua, reason: "unknown_tenant", tenant });
				return c.json({ error: "unknown_tenant", code: "INVALID_INPUT" }, 400 as ContentfulStatusCode);
			}

			const token = await signToken({ sub, tenant, expiresIn, secret: authSecret });

			let expiresAt: string | null = null;
			if (expiresIn !== "never") {
				const seconds = EXPIRES_IN_SECONDS[expiresIn] ?? EXPIRES_IN_SECONDS["30d"];
				expiresAt = new Date(Date.now() + (seconds as number) * 1000).toISOString();
			}

			logAudit("auth_bootstrap_issued", { ip, ua, sub, tenant, expiresIn, expiresAt });
			return c.json({ token, sub, tenant, expiresAt }, 201 as ContentfulStatusCode);
		},
	);

	return router;
}

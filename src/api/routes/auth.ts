/**
 * Auth routes — all token-minting endpoints.
 *
 * POST /v1/auth/bootstrap  (unauthenticated) — exchange AUTH_SECRET for a JWT.
 * POST /v1/auth/admin      (Bearer + X-Admin-Secret) — mint tokens for arbitrary subs.
 */

import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import type { AuthVariables } from "../auth.js";
import { signToken } from "../lib/jwt.js";
import { loadTenantConfig } from "../tenants.js";
import { validateBody } from "../validation.js";

const tokenBodySchema = z.object({
	sub: z.string().min(1, "sub is required"),
	tenant: z
		.string()
		.regex(/^[A-Za-z0-9_.-]+$/, "tenant must match [A-Za-z0-9_.-]+")
		.optional(),
	expiresIn: z.enum(["30d", "1y", "24h", "never"]).optional(),
});

const bootstrapBodySchema = tokenBodySchema;

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

function expiresAt(expiresIn: string): string | null {
	if (expiresIn === "never") return null;
	const seconds = EXPIRES_IN_SECONDS[expiresIn] ?? EXPIRES_IN_SECONDS["30d"];
	return new Date(Date.now() + (seconds as number) * 1000).toISOString();
}

export function authRoutes(): Hono<{ Variables: AuthVariables }> {
	const router = new Hono<{ Variables: AuthVariables }>();

	// ── POST /v1/auth/bootstrap ────────────────────────────────────────────────
	// Unauthenticated. Exempt from Bearer middleware via UNAUTHENTICATED_PATHS.
	// Authorization is AUTH_SECRET sent as X-Auth-Secret (constant-time compare).
	router.post(
		"/bootstrap",
		async (c, next) => {
			// Secret check runs before body parsing — callers without the correct
			// secret cannot probe the schema with cheap 400s.
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

			const config = loadTenantConfig();
			if (tenant !== undefined && !config.hasTenant(tenant)) {
				logAudit("auth_bootstrap_denied", { ip, ua, reason: "unknown_tenant", tenant });
				return c.json({ error: "unknown_tenant", code: "INVALID_INPUT" }, 400 as ContentfulStatusCode);
			}

			const token = await signToken({ sub, tenant, expiresIn, secret: authSecret });
			const at = expiresAt(expiresIn);
			logAudit("auth_bootstrap_issued", { ip, ua, sub, tenant, expiresIn, expiresAt: at });
			return c.json({ token, sub, tenant, expiresAt: at }, 201 as ContentfulStatusCode);
		},
	);

	// ── POST /v1/auth/admin ────────────────────────────────────────────────────
	// Requires Bearer JWT (enforced by /v1/* middleware) + X-Admin-Secret header.
	router.post("/admin", validateBody(tokenBodySchema), async (c) => {
		const adminSecret = process.env.ADMIN_SECRET;
		if (!adminSecret) {
			return c.json({ error: "admin_not_configured", code: "ADMIN_NOT_CONFIGURED" }, 500 as ContentfulStatusCode);
		}

		const providedSecret = c.req.header("X-Admin-Secret");
		if (providedSecret !== adminSecret) {
			return c.json({ error: "forbidden", code: "FORBIDDEN" }, 403 as ContentfulStatusCode);
		}

		const { sub, tenant, expiresIn = "30d" } = c.get("body");

		if (tenant !== undefined && !loadTenantConfig().hasTenant(tenant)) {
			return c.json({ error: "unknown_tenant", code: "INVALID_INPUT" }, 400 as ContentfulStatusCode);
		}

		const authSecret = process.env.AUTH_SECRET;
		if (!authSecret) {
			return c.json({ error: "auth_not_configured", code: "AUTH_NOT_CONFIGURED" }, 500 as ContentfulStatusCode);
		}

		const token = await signToken({ sub, tenant, expiresIn, secret: authSecret });
		const at = expiresAt(expiresIn);
		return c.json({ token, sub, tenant, expiresAt: at }, 201 as ContentfulStatusCode);
	});

	return router;
}

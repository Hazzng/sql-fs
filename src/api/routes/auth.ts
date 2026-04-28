/**
 * Auth routes — all token-minting endpoints.
 *
 * POST /v1/auth/bootstrap  (unauthenticated) — exchange AUTH_SECRET for a JWT.
 * POST /v1/auth/admin      (Bearer + X-Admin-Secret) — mint tokens for arbitrary subs.
 */

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { parseNonNegativeInt } from "../../redis/config.js";
import type { AuthVariables } from "../auth.js";
import { logAudit } from "../lib/audit.js";
import { signToken } from "../lib/jwt.js";
import { clientIp, rateLimit } from "../rate-limit.js";
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
	// Hash both inputs to fixed-length 32-byte digests so timingSafeEqual cannot
	// throw on length mismatch and there is no length oracle from an early return.
	const aDigest = createHash("sha256").update(a, "utf8").digest();
	const bDigest = createHash("sha256").update(b, "utf8").digest();
	return timingSafeEqual(aDigest, bDigest);
}

function expiresAt(expiresIn: string): string | null {
	if (expiresIn === "never") return null;
	const seconds = EXPIRES_IN_SECONDS[expiresIn] ?? EXPIRES_IN_SECONDS["30d"];
	return new Date(Date.now() + (seconds as number) * 1000).toISOString();
}

export function authRoutes(): Hono<{ Variables: AuthVariables }> {
	const router = new Hono<{ Variables: AuthVariables }>();

	// ── Rate limiters ──────────────────────────────────────────────────────────
	// Per-route limits so brute-forcing X-Admin-Secret / X-Auth-Secret is bounded.
	// Bootstrap is unauthenticated (no `c.get("owner")`) so it is keyed by IP only;
	// admin is keyed by both IP and Bearer sub, tripping on either to defeat
	// rotating-IP attackers reusing the same Bearer token.
	const adminLimiter = rateLimit({
		windowMs: parseNonNegativeInt("ADMIN_RATE_LIMIT_WINDOW_MS", 60_000),
		max: parseNonNegativeInt("ADMIN_RATE_LIMIT_MAX", 5),
		scope: "admin",
		keys: (c) => {
			const ip = clientIp(c);
			const sub = (c.get("owner") as string | undefined) ?? "anon";
			return [`admin:ip:${ip}`, `admin:sub:${sub}`];
		},
	});

	const bootstrapLimiter = rateLimit({
		windowMs: parseNonNegativeInt("BOOTSTRAP_RATE_LIMIT_WINDOW_MS", 60_000),
		max: parseNonNegativeInt("BOOTSTRAP_RATE_LIMIT_MAX", 5),
		scope: "bootstrap",
		keys: (c) => [`bootstrap:ip:${clientIp(c)}`],
	});

	router.use("/admin", adminLimiter);
	router.use("/bootstrap", bootstrapLimiter);

	// ── POST /v1/auth/bootstrap ────────────────────────────────────────────────
	// Unauthenticated. Exempt from Bearer middleware via UNAUTHENTICATED_PATHS.
	// Authorization is AUTH_SECRET sent as X-Auth-Secret (constant-time compare).
	router.post(
		"/bootstrap",
		async (c, next) => {
			// Secret check runs before body parsing — callers without the correct
			// secret cannot probe the schema with cheap 400s.
			const authSecret = process.env.AUTH_SECRET;
			const ip = clientIp(c);
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
			const ip = clientIp(c);
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
	// Pre-middleware verifies the admin secret with timing-safe compare BEFORE
	// body validation, so callers without the correct secret cannot probe the
	// schema with cheap 400s.
	router.post(
		"/admin",
		async (c, next) => {
			const adminSecret = process.env.ADMIN_SECRET;
			const ip = clientIp(c);
			const ua = c.req.header("user-agent") ?? "";
			const caller = c.get("owner");

			if (!adminSecret) {
				logAudit("admin_token_misconfigured", { ts: new Date().toISOString(), ip, ua, caller });
				return c.json({ error: "admin_not_configured", code: "ADMIN_NOT_CONFIGURED" }, 500 as ContentfulStatusCode);
			}

			const provided = c.req.header("X-Admin-Secret");
			if (!provided || !constantTimeEqual(provided, adminSecret)) {
				logAudit("admin_token_denied", {
					ts: new Date().toISOString(),
					ip,
					ua,
					caller,
					reason: provided ? "mismatch" : "missing_header",
				});
				return c.json({ error: "forbidden", code: "FORBIDDEN" }, 403 as ContentfulStatusCode);
			}

			await next();
		},
		validateBody(tokenBodySchema),
		async (c) => {
			const ip = clientIp(c);
			const ua = c.req.header("user-agent") ?? "";
			const caller = c.get("owner");
			const callerTenant = c.get("tenant");

			const authSecret = process.env.AUTH_SECRET;
			if (!authSecret) {
				logAudit("admin_token_misconfigured", {
					ts: new Date().toISOString(),
					ip,
					ua,
					caller,
					reason: "auth_secret_unset",
				});
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

			if (tenant !== undefined && !loadTenantConfig().hasTenant(tenant)) {
				logAudit("admin_token_denied", {
					ts: new Date().toISOString(),
					ip,
					ua,
					caller,
					reason: "unknown_tenant",
					tenant,
				});
				return c.json({ error: "unknown_tenant", code: "INVALID_INPUT" }, 400 as ContentfulStatusCode);
			}

			const jti = randomUUID();
			const token = await signToken({ sub, tenant, expiresIn, secret: authSecret, jti });
			const at = expiresAt(expiresIn);

			logAudit("admin_token_issued", {
				ts: new Date().toISOString(),
				caller,
				callerTenant,
				sub,
				tenant,
				expiresIn,
				expiresAt: at,
				jti,
				ip,
				ua,
			});

			return c.json({ token, sub, tenant, expiresAt: at }, 201 as ContentfulStatusCode);
		},
	);

	return router;
}

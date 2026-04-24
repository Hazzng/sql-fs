/**
 * Admin routes.
 * US-057c: Token generation admin endpoint.
 *
 * POST /v1/admin/tokens — generate a JWT for a given sub (and optional tenant).
 * Requires auth (applied at /v1/* level in server.ts).
 * Additionally requires ADMIN_SECRET header for authorization.
 */

import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import type { AuthVariables } from "../auth.js";
import { signToken } from "../lib/jwt.js";
import { validateBody } from "../validation.js";

const tokenBodySchema = z.object({
	sub: z.string().min(1, "sub is required"),
	tenant: z
		.string()
		.regex(/^[A-Za-z0-9_.-]+$/, "tenant must match [A-Za-z0-9_.-]+")
		.optional(),
	expiresIn: z.enum(["30d", "1y", "24h", "never"]).optional(),
});

export const adminRoutes = new Hono<{ Variables: AuthVariables }>();

adminRoutes.post("/tokens", validateBody(tokenBodySchema), async (c) => {
	// Require ADMIN_SECRET header for token minting authorization
	const adminSecret = process.env.ADMIN_SECRET;
	if (!adminSecret) {
		return c.json({ error: "admin_not_configured", code: "ADMIN_NOT_CONFIGURED" }, 500 as ContentfulStatusCode);
	}

	const providedSecret = c.req.header("X-Admin-Secret");
	if (providedSecret !== adminSecret) {
		return c.json({ error: "forbidden", code: "FORBIDDEN" }, 403 as ContentfulStatusCode);
	}

	const { sub, tenant, expiresIn = "30d" } = c.get("body");
	const secret = process.env.AUTH_SECRET ?? "";

	const token = await signToken({ sub, tenant, expiresIn, secret });

	// Calculate expiresAt from expiresIn instead of re-verifying the just-signed token
	let expiresAt: string | null = null;
	if (expiresIn !== "never") {
		const durations: Record<string, number> = { "24h": 86400, "30d": 2592000, "1y": 31536000 };
		const seconds = durations[expiresIn] ?? 2592000;
		expiresAt = new Date(Date.now() + seconds * 1000).toISOString();
	}

	return c.json({ token, sub, tenant, expiresAt }, 201 as ContentfulStatusCode);
});

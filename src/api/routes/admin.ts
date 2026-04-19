/**
 * Admin routes.
 * US-057c: Token generation admin endpoint.
 *
 * POST /v1/admin/tokens — generate a JWT for a given sub.
 * Requires auth (applied at /v1/* level in server.ts).
 */

import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { signToken, verifyToken } from "../lib/jwt.js";
import { validateBody } from "../validation.js";

const tokenBodySchema = z.object({
	sub: z.string().min(1, "sub is required"),
	expiresIn: z.enum(["30d", "1y", "24h", "never"]).optional(),
});

export const adminRoutes = new Hono();

adminRoutes.post("/tokens", validateBody(tokenBodySchema), async (c) => {
	const { sub, expiresIn = "30d" } = c.get("body");
	const secret = process.env.AUTH_SECRET ?? "";

	const token = await signToken({ sub, expiresIn, secret });

	// Decode the signed token to extract the exp claim for the response.
	const payload = await verifyToken({ token, secret });
	const expiresAt = payload.exp != null ? new Date(payload.exp * 1000).toISOString() : null;

	return c.json({ token, sub, expiresAt }, 201 as ContentfulStatusCode);
});

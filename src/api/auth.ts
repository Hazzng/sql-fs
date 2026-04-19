/**
 * JWT/HMAC auth middleware for Hono.
 * US-057: Verifies HS256 JWT tokens signed with AUTH_SECRET env var.
 *
 * Usage:
 *   app.use("/v1/*", authMiddleware);
 *   // downstream: c.get("owner") → sub claim string
 */

import { createMiddleware } from "hono/factory";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { jwtVerify } from "jose";

export type AuthVariables = {
	owner: string;
};

const UNAUTHORIZED = 401 as ContentfulStatusCode;

export const authMiddleware = createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
	const authHeader = c.req.header("Authorization");

	if (!authHeader?.startsWith("Bearer ")) {
		return c.json({ error: "unauthorized", code: "AUTH_REQUIRED" }, UNAUTHORIZED);
	}

	const token = authHeader.slice(7);
	const secret = process.env.AUTH_SECRET;

	if (!secret) {
		return c.json({ error: "unauthorized", code: "AUTH_REQUIRED" }, UNAUTHORIZED);
	}

	try {
		const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
			algorithms: ["HS256"],
		});

		const sub = payload.sub;
		if (!sub) {
			return c.json({ error: "invalid_token", code: "AUTH_INVALID" }, UNAUTHORIZED);
		}

		c.set("owner", sub);
		await next();
	} catch {
		return c.json({ error: "invalid_token", code: "AUTH_INVALID" }, UNAUTHORIZED);
	}
});

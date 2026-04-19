/**
 * Zod request validation middleware factories for Hono.
 * US-058: Zod request validation middleware
 *
 * Usage:
 *   app.post("/route", validateBody(schema), (c) => {
 *     const body = c.get("body"); // typed as z.infer<typeof schema>
 *   });
 *
 *   app.get("/route", validateQuery(schema), (c) => {
 *     const query = c.get("query"); // typed as z.infer<typeof schema>
 *   });
 */

import { createMiddleware } from "hono/factory";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";

const BAD_REQUEST = 400 as ContentfulStatusCode;

/**
 * Middleware factory that validates the JSON request body against a Zod schema.
 * On success, sets c.set("body", parsed) for downstream handlers.
 * On failure, returns 400 { error, code, details }.
 */
export function validateBody<T extends z.ZodTypeAny>(schema: T) {
	return createMiddleware<{ Variables: { body: z.infer<T> } }>(async (c, next) => {
		let raw: unknown;
		try {
			raw = await c.req.json();
		} catch {
			return c.json(
				{
					error: "validation_error",
					code: "INVALID_INPUT",
					details: ["Invalid JSON body"],
				},
				BAD_REQUEST,
			);
		}

		const result = schema.safeParse(raw);
		if (!result.success) {
			const details = result.error.issues.map((issue) => issue.message);
			return c.json({ error: "validation_error", code: "INVALID_INPUT", details }, BAD_REQUEST);
		}

		c.set("body", result.data);
		await next();
	});
}

/**
 * Middleware factory that validates query parameters against a Zod schema.
 * On success, sets c.set("query", parsed) for downstream handlers.
 * On failure, returns 400 { error, code, details }.
 */
export function validateQuery<T extends z.ZodTypeAny>(schema: T) {
	return createMiddleware<{ Variables: { query: z.infer<T> } }>(async (c, next) => {
		const raw = c.req.query();

		const result = schema.safeParse(raw);
		if (!result.success) {
			const details = result.error.issues.map((issue) => issue.message);
			return c.json({ error: "validation_error", code: "INVALID_INPUT", details }, BAD_REQUEST);
		}

		c.set("query", result.data);
		await next();
	});
}

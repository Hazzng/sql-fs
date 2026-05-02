/**
 * Unit tests for Zod request validation middleware.
 * US-058: Zod request validation middleware
 */

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { validateBody, validateQuery } from "../../validation.js";

// ── Test schemas ───────────────────────────────────────────────────────────────

const bodySchema = z.object({
	name: z.string().min(1, "name is required"),
	count: z.number().int().positive("count must be a positive integer"),
});

const querySchema = z.object({
	prefix: z.string().optional(),
	depth: z.coerce.number().int().positive().optional(),
});

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeBodyApp() {
	const app = new Hono<{ Variables: { body: z.infer<typeof bodySchema> } }>();
	app.post("/test", validateBody(bodySchema), (c) => {
		const body = c.get("body");
		return c.json({ received: body });
	});
	return app;
}

function makeQueryApp() {
	const app = new Hono<{ Variables: { query: z.infer<typeof querySchema> } }>();
	app.get("/test", validateQuery(querySchema), (c) => {
		const query = c.get("query");
		return c.json({ received: query });
	});
	return app;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("validateBody", () => {
	it("valid body passes with parsed data available", async () => {
		const app = makeBodyApp();
		const res = await app.request("/test", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "hello", count: 3 }),
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as { received: { name: string; count: number } };
		expect(body.received).toEqual({ name: "hello", count: 3 });
	});

	it("invalid body returns 400 with field-level details", async () => {
		const app = makeBodyApp();
		const res = await app.request("/test", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			// missing count, empty name
			body: JSON.stringify({ name: "", count: -1 }),
		});

		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string; code: string; details: string[] };
		expect(body.error).toBe("validation_error");
		expect(body.code).toBe("INVALID_INPUT");
		expect(Array.isArray(body.details)).toBe(true);
		expect(body.details.length).toBeGreaterThan(0);
	});

	it("malformed JSON body returns 400", async () => {
		const app = makeBodyApp();
		const res = await app.request("/test", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "not-json",
		});

		expect(res.status).toBe(400);
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("INVALID_INPUT");
	});
});

describe("validateQuery", () => {
	it("validateQuery works for query parameters", async () => {
		const app = makeQueryApp();
		const res = await app.request("/test?prefix=/src&depth=2");

		expect(res.status).toBe(200);
		const body = (await res.json()) as { received: { prefix?: string; depth?: number } };
		expect(body.received.prefix).toBe("/src");
		expect(body.received.depth).toBe(2);
	});

	it("invalid query params returns 400 with details", async () => {
		const app = makeQueryApp();
		// depth must be a positive integer — "0" coerces to 0, fails positive check
		const res = await app.request("/test?depth=0");

		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string; code: string; details: string[] };
		expect(body.error).toBe("validation_error");
		expect(body.code).toBe("INVALID_INPUT");
		expect(Array.isArray(body.details)).toBe(true);
	});

	it("no query params returns 200 when all params are optional", async () => {
		const app = makeQueryApp();
		const res = await app.request("/test");

		expect(res.status).toBe(200);
		const body = (await res.json()) as { received: { prefix?: string; depth?: number } };
		expect(body.received.prefix).toBeUndefined();
		expect(body.received.depth).toBeUndefined();
	});
});

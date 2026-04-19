/**
 * Unit tests for the Hono server bootstrap.
 * US-056: Hono server bootstrap
 */

import { describe, expect, it } from "vitest";
import { app } from "../server.js";

describe("GET /healthz", () => {
	it("returns 200 { status: 'ok' }", async () => {
		const res = await app.request("/healthz");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual({ status: "ok" });
	});
});

describe("GET /readyz", () => {
	it("returns 200 { status: 'ok' }", async () => {
		const res = await app.request("/readyz");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual({ status: "ok" });
	});
});

describe("unknown route", () => {
	it("returns 404", async () => {
		const res = await app.request("/no-such-route");
		expect(res.status).toBe(404);
	});
});

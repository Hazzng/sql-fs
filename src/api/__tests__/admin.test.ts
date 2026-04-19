/**
 * Unit tests for POST /v1/admin/tokens (US-057c)
 */

import { SignJWT, jwtVerify } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { app } from "../server.js";

const AUTH_SECRET = "test-secret-for-admin-endpoint-exactly-32b";

async function makeCallerToken(sub: string): Promise<string> {
	const key = new TextEncoder().encode(AUTH_SECRET);
	return new SignJWT({ sub }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().sign(key);
}

describe("POST /v1/admin/tokens", () => {
	const originalSecret = process.env.AUTH_SECRET;

	beforeEach(() => {
		process.env.AUTH_SECRET = AUTH_SECRET;
	});

	afterEach(() => {
		process.env.AUTH_SECRET = originalSecret ?? "";
	});

	it("creates token via endpoint, decode verifies sub matches", async () => {
		const callerToken = await makeCallerToken("admin");
		const res = await app.request("/v1/admin/tokens", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${callerToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ sub: "agent-001", expiresIn: "24h" }),
		});

		expect(res.status).toBe(201);
		const body = (await res.json()) as { token: string; sub: string; expiresAt: string | null };
		expect(body.sub).toBe("agent-001");
		expect(typeof body.token).toBe("string");
		expect(body.expiresAt).toBeTruthy(); // 24h → non-null ISO string

		// Decode the returned token and verify sub matches
		const key = new TextEncoder().encode(AUTH_SECRET);
		const { payload } = await jwtVerify(body.token, key, { algorithms: ["HS256"] });
		expect(payload.sub).toBe("agent-001");
	});

	it("never expiresIn returns expiresAt null", async () => {
		const callerToken = await makeCallerToken("admin");
		const res = await app.request("/v1/admin/tokens", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${callerToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ sub: "agent-002", expiresIn: "never" }),
		});

		expect(res.status).toBe(201);
		const body = (await res.json()) as { token: string; sub: string; expiresAt: string | null };
		expect(body.expiresAt).toBeNull();
	});

	it("missing sub returns 400 INVALID_INPUT", async () => {
		const callerToken = await makeCallerToken("admin");
		const res = await app.request("/v1/admin/tokens", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${callerToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ expiresIn: "30d" }),
		});

		expect(res.status).toBe(400);
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("INVALID_INPUT");
	});

	it("unauthenticated request returns 401 AUTH_REQUIRED", async () => {
		const res = await app.request("/v1/admin/tokens", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ sub: "agent-001" }),
		});

		expect(res.status).toBe(401);
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("AUTH_REQUIRED");
	});
});

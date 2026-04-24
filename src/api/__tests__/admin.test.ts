/**
 * Unit tests for POST /v1/admin/tokens (US-057c)
 */

import { SignJWT, jwtVerify } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { app } from "../server.js";

const AUTH_SECRET = "test-secret-for-admin-endpoint-exactly-32b";
const ADMIN_SECRET = "test-admin-secret-for-token-minting";

async function makeCallerToken(sub: string): Promise<string> {
	const key = new TextEncoder().encode(AUTH_SECRET);
	return new SignJWT({ sub }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().sign(key);
}

describe("POST /v1/admin/tokens", () => {
	const originalAuthSecret = process.env.AUTH_SECRET;
	const originalAdminSecret = process.env.ADMIN_SECRET;
	const originalDatabaseUrl = process.env.DATABASE_URL;

	beforeEach(() => {
		process.env.AUTH_SECRET = AUTH_SECRET;
		process.env.ADMIN_SECRET = ADMIN_SECRET;
		// The server wires the legacy lazy authMiddleware, which resolves a
		// TenantConfig from env on first request. DATABASE_URL makes that
		// resolve to the single-tenant "default" fallback.
		process.env.DATABASE_URL ??= "postgres://test@localhost:5432/test";
	});

	afterEach(() => {
		process.env.AUTH_SECRET = originalAuthSecret ?? "";
		process.env.ADMIN_SECRET = originalAdminSecret ?? "";
		process.env.DATABASE_URL = originalDatabaseUrl ?? "";
	});

	it("creates token via endpoint, decode verifies sub matches", async () => {
		const callerToken = await makeCallerToken("admin");
		const res = await app.request("/v1/admin/tokens", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${callerToken}`,
				"Content-Type": "application/json",
				"X-Admin-Secret": ADMIN_SECRET,
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

	it("forwards tenant claim into issued token and echoes it in the response", async () => {
		const callerToken = await makeCallerToken("admin");
		const res = await app.request("/v1/admin/tokens", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${callerToken}`,
				"Content-Type": "application/json",
				"X-Admin-Secret": ADMIN_SECRET,
			},
			body: JSON.stringify({ sub: "agent-003", tenant: "tenant-a", expiresIn: "24h" }),
		});

		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			token: string;
			sub: string;
			tenant?: string;
			expiresAt: string | null;
		};
		expect(body.tenant).toBe("tenant-a");

		const key = new TextEncoder().encode(AUTH_SECRET);
		const { payload } = await jwtVerify(body.token, key, { algorithms: ["HS256"] });
		expect(payload.sub).toBe("agent-003");
		expect((payload as { tenant?: string }).tenant).toBe("tenant-a");
	});

	it("rejects tenant with invalid characters with 400 INVALID_INPUT", async () => {
		const callerToken = await makeCallerToken("admin");
		const res = await app.request("/v1/admin/tokens", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${callerToken}`,
				"Content-Type": "application/json",
				"X-Admin-Secret": ADMIN_SECRET,
			},
			body: JSON.stringify({ sub: "agent-004", tenant: "bad tenant" }),
		});

		expect(res.status).toBe(400);
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("INVALID_INPUT");
	});

	it("never expiresIn returns expiresAt null", async () => {
		const callerToken = await makeCallerToken("admin");
		const res = await app.request("/v1/admin/tokens", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${callerToken}`,
				"Content-Type": "application/json",
				"X-Admin-Secret": ADMIN_SECRET,
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
				"X-Admin-Secret": ADMIN_SECRET,
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
				"X-Admin-Secret": ADMIN_SECRET,
			},
			body: JSON.stringify({ sub: "agent-001" }),
		});

		expect(res.status).toBe(401);
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("AUTH_REQUIRED");
	});

	it("missing X-Admin-Secret returns 403 FORBIDDEN", async () => {
		const callerToken = await makeCallerToken("admin");
		const res = await app.request("/v1/admin/tokens", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${callerToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ sub: "agent-001" }),
		});

		expect(res.status).toBe(403);
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("FORBIDDEN");
	});

	it("invalid X-Admin-Secret returns 403 FORBIDDEN", async () => {
		const callerToken = await makeCallerToken("admin");
		const res = await app.request("/v1/admin/tokens", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${callerToken}`,
				"Content-Type": "application/json",
				"X-Admin-Secret": "wrong-secret",
			},
			body: JSON.stringify({ sub: "agent-001" }),
		});

		expect(res.status).toBe(403);
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("FORBIDDEN");
	});
});

/**
 * Unit tests for POST /v1/auth/bootstrap (issue #27).
 */

import { jwtVerify } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { app } from "../server.js";

const AUTH_SECRET = "test-bootstrap-secret-exactly-32-bytes";

describe("POST /v1/auth/bootstrap", () => {
	const originalAuthSecret = process.env.AUTH_SECRET;
	const originalDatabaseUrl = process.env.DATABASE_URL;
	const originalTenantDatabases = process.env.TENANT_DATABASES;

	beforeEach(() => {
		process.env.AUTH_SECRET = AUTH_SECRET;
		process.env.TENANT_DATABASES = JSON.stringify({
			default: "postgres://test@localhost:5432/test_default",
			"tenant-a": "postgres://test@localhost:5432/test_tenant_a",
		});
		process.env.DATABASE_URL ??= "postgres://test@localhost:5432/test";
	});

	afterEach(() => {
		if (originalAuthSecret === undefined) {
			Reflect.deleteProperty(process.env, "AUTH_SECRET");
		} else {
			process.env.AUTH_SECRET = originalAuthSecret;
		}
		if (originalDatabaseUrl === undefined) {
			Reflect.deleteProperty(process.env, "DATABASE_URL");
		} else {
			process.env.DATABASE_URL = originalDatabaseUrl;
		}
		if (originalTenantDatabases === undefined) {
			Reflect.deleteProperty(process.env, "TENANT_DATABASES");
		} else {
			process.env.TENANT_DATABASES = originalTenantDatabases;
		}
	});

	it("issues a verifiable JWT when X-Auth-Secret matches", async () => {
		const res = await app.request("/v1/auth/bootstrap", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Auth-Secret": AUTH_SECRET,
			},
			body: JSON.stringify({ sub: "agent-001", expiresIn: "24h" }),
		});

		expect(res.status).toBe(201);
		const body = (await res.json()) as { token: string; sub: string; expiresAt: string | null };
		expect(body.sub).toBe("agent-001");
		expect(body.expiresAt).toBeTruthy();

		const key = new TextEncoder().encode(AUTH_SECRET);
		const { payload } = await jwtVerify(body.token, key, { algorithms: ["HS256"] });
		expect(payload.sub).toBe("agent-001");
	});

	it("forwards tenant claim into the issued token", async () => {
		const res = await app.request("/v1/auth/bootstrap", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Auth-Secret": AUTH_SECRET,
			},
			body: JSON.stringify({ sub: "agent-002", tenant: "tenant-a", expiresIn: "30d" }),
		});

		expect(res.status).toBe(201);
		const body = (await res.json()) as { token: string; tenant?: string };
		expect(body.tenant).toBe("tenant-a");

		const key = new TextEncoder().encode(AUTH_SECRET);
		const { payload } = await jwtVerify(body.token, key, { algorithms: ["HS256"] });
		expect((payload as { tenant?: string }).tenant).toBe("tenant-a");
	});

	it("returns null expiresAt when expiresIn is 'never'", async () => {
		const res = await app.request("/v1/auth/bootstrap", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Auth-Secret": AUTH_SECRET,
			},
			body: JSON.stringify({ sub: "agent-003", expiresIn: "never" }),
		});

		expect(res.status).toBe(201);
		const body = (await res.json()) as { expiresAt: string | null };
		expect(body.expiresAt).toBeNull();
	});

	it("rejects missing X-Auth-Secret with 403 FORBIDDEN", async () => {
		const res = await app.request("/v1/auth/bootstrap", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ sub: "agent-001" }),
		});

		expect(res.status).toBe(403);
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("FORBIDDEN");
	});

	it("rejects wrong X-Auth-Secret with 403 FORBIDDEN", async () => {
		const res = await app.request("/v1/auth/bootstrap", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Auth-Secret": "definitely-not-the-secret",
			},
			body: JSON.stringify({ sub: "agent-001" }),
		});

		expect(res.status).toBe(403);
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("FORBIDDEN");
	});

	it("does NOT require a Bearer token (route is exempt from /v1/* auth)", async () => {
		// No Authorization header at all — the /v1/* middleware would normally
		// 401 with AUTH_REQUIRED. The bootstrap route is the explicit exception.
		const res = await app.request("/v1/auth/bootstrap", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Auth-Secret": AUTH_SECRET,
			},
			body: JSON.stringify({ sub: "agent-001" }),
		});
		expect(res.status).toBe(201);
	});

	it("returns 400 INVALID_INPUT for missing sub (after secret check passes)", async () => {
		const res = await app.request("/v1/auth/bootstrap", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Auth-Secret": AUTH_SECRET,
			},
			body: JSON.stringify({ expiresIn: "30d" }),
		});

		expect(res.status).toBe(400);
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("INVALID_INPUT");
	});

	it("returns 403 (not 400) when secret is wrong even if body is invalid — secret check runs first", async () => {
		// Defense-in-depth: callers without the secret cannot probe the body
		// schema with cheap 400s.
		const res = await app.request("/v1/auth/bootstrap", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Auth-Secret": "wrong",
			},
			body: JSON.stringify({}), // missing sub
		});

		expect(res.status).toBe(403);
	});

	it("rejects unknown tenant with 400 INVALID_INPUT", async () => {
		const res = await app.request("/v1/auth/bootstrap", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Auth-Secret": AUTH_SECRET,
			},
			body: JSON.stringify({ sub: "agent-004", tenant: "nope-not-configured" }),
		});

		expect(res.status).toBe(400);
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("INVALID_INPUT");
	});

	it("returns 500 AUTH_NOT_CONFIGURED when AUTH_SECRET is unset", async () => {
		Reflect.deleteProperty(process.env, "AUTH_SECRET");

		const res = await app.request("/v1/auth/bootstrap", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Auth-Secret": "anything",
			},
			body: JSON.stringify({ sub: "agent-001" }),
		});

		expect(res.status).toBe(500);
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("AUTH_NOT_CONFIGURED");
	});
});

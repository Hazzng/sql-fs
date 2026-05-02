/**
 * Unit tests for the JWT/HMAC auth middleware.
 * US-057: JWT/HMAC auth middleware
 * Multi-tenant: tenant claim resolution and unknown-tenant rejection.
 */

import { Hono } from "hono";
import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AuthVariables, createAuthMiddleware } from "../../auth.js";
import type { TenantConfig } from "../../tenants.js";

const SECRET = "test-secret-at-least-32-bytes-long!!";
const secretBytes = new TextEncoder().encode(SECRET);

function makeTenantConfig(ids: readonly string[]): TenantConfig {
	const set = new Set(ids);
	return {
		tenantIds: [...ids],
		hasTenant: (id) => set.has(id),
		getConnectionString: (id) => {
			if (!set.has(id)) throw new Error(`Unknown tenant: ${id}`);
			return `postgres://stub/${id}`;
		},
	};
}

function makeApp(config: TenantConfig = makeTenantConfig(["default"])) {
	const app = new Hono<{ Variables: AuthVariables }>();
	app.use("/v1/*", createAuthMiddleware(config));
	app.get("/v1/ping", (c) => c.json({ owner: c.get("owner"), tenant: c.get("tenant") }));
	return app;
}

async function makeToken(claims: Record<string, unknown>): Promise<string> {
	return new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).sign(secretBytes);
}

async function makeExpiredToken(): Promise<string> {
	return new SignJWT({ sub: "agent-1" })
		.setProtectedHeader({ alg: "HS256" })
		.setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
		.sign(secretBytes);
}

describe("authMiddleware", () => {
	let savedSecret: string | undefined;

	beforeEach(() => {
		savedSecret = process.env.AUTH_SECRET;
		process.env.AUTH_SECRET = SECRET;
	});

	afterEach(() => {
		process.env.AUTH_SECRET = savedSecret ?? "";
	});

	it("valid token passes with correct sub extracted", async () => {
		const app = makeApp();
		const token = await makeToken({ sub: "my-agent" });
		const res = await app.request("/v1/ping", {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { owner: string; tenant: string };
		expect(body.owner).toBe("my-agent");
	});

	it("expired token returns 401", async () => {
		const app = makeApp();
		const token = await makeExpiredToken();
		const res = await app.request("/v1/ping", {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(res.status).toBe(401);
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("AUTH_INVALID");
	});

	it("tampered token returns 401", async () => {
		const app = makeApp();
		const token = await makeToken({ sub: "agent-1" });
		// Corrupt the signature portion (last segment of the JWT)
		const parts = token.split(".");
		parts[2] = `${parts[2]?.slice(0, -4)}XXXX`;
		const tampered = parts.join(".");
		const res = await app.request("/v1/ping", {
			headers: { Authorization: `Bearer ${tampered}` },
		});
		expect(res.status).toBe(401);
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("AUTH_INVALID");
	});

	it("missing Authorization header returns 401", async () => {
		const app = makeApp();
		const res = await app.request("/v1/ping");
		expect(res.status).toBe(401);
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("AUTH_REQUIRED");
	});

	it("token without tenant claim resolves to 'default' when configured", async () => {
		const app = makeApp(makeTenantConfig(["default"]));
		const token = await makeToken({ sub: "agent-1" });
		const res = await app.request("/v1/ping", {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { owner: string; tenant: string };
		expect(body.tenant).toBe("default");
	});

	it("token with known tenant claim passes and stashes tenant on context", async () => {
		const app = makeApp(makeTenantConfig(["tenant-a", "tenant-b"]));
		const token = await makeToken({ sub: "alice", tenant: "tenant-a" });
		const res = await app.request("/v1/ping", {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { owner: string; tenant: string };
		expect(body).toEqual({ owner: "alice", tenant: "tenant-a" });
	});

	it("token with unknown tenant claim returns 401 AUTH_UNKNOWN_TENANT", async () => {
		const app = makeApp(makeTenantConfig(["tenant-a"]));
		const token = await makeToken({ sub: "alice", tenant: "tenant-ghost" });
		const res = await app.request("/v1/ping", {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(res.status).toBe(401);
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("AUTH_UNKNOWN_TENANT");
	});

	it("token without tenant claim in a multi-tenant config (no 'default') returns 401", async () => {
		const app = makeApp(makeTenantConfig(["tenant-a", "tenant-b"]));
		const token = await makeToken({ sub: "alice" });
		const res = await app.request("/v1/ping", {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(res.status).toBe(401);
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("AUTH_UNKNOWN_TENANT");
	});
});

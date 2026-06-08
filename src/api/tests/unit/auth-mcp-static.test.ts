/**
 * Unit tests for static-header (API-key) MCP auth.
 * Issue #117: external MCP clients (e.g. LibreChat) that send fixed headers and
 * cannot mint a per-request JWT must still authenticate, with each forwarded
 * end-user mapped to an isolated sandbox owner.
 */

import { Hono } from "hono";
import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AuthVariables, type StaticMcpAuthConfig, createAuthMiddleware } from "../../auth.js";
import type { TenantConfig } from "../../tenants.js";

const SECRET = "test-secret-at-least-32-bytes-long!!";
const API_KEY = "static-mcp-api-key-1234567890";
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

function makeApp(staticAuth: StaticMcpAuthConfig | undefined, tenants: readonly string[] = ["default"]) {
	const app = new Hono<{ Variables: AuthVariables }>();
	app.use("/mcp", createAuthMiddleware(makeTenantConfig(tenants), { staticAuth }));
	app.all("/mcp", (c) => c.json({ owner: c.get("owner"), tenant: c.get("tenant") }));
	return app;
}

const baseConfig: StaticMcpAuthConfig = {
	apiKey: API_KEY,
	identityHeader: "x-librechat-user-id",
	tenant: "default",
};

async function makeJwt(claims: Record<string, unknown>): Promise<string> {
	return new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).sign(secretBytes);
}

async function body(res: Response): Promise<{ owner?: string; tenant?: string; code?: string; error?: string }> {
	return (await res.json()) as { owner?: string; tenant?: string; code?: string; error?: string };
}

describe("static MCP auth", () => {
	let savedSecret: string | undefined;

	beforeEach(() => {
		savedSecret = process.env.AUTH_SECRET;
		process.env.AUTH_SECRET = SECRET;
	});

	afterEach(() => {
		process.env.AUTH_SECRET = savedSecret ?? "";
	});

	it("accepts the static API key and derives owner from the identity header", async () => {
		const app = makeApp(baseConfig);
		const res = await app.request("/mcp", {
			headers: { Authorization: `Bearer ${API_KEY}`, "x-librechat-user-id": "alice@example.com" },
		});
		expect(res.status).toBe(200);
		expect(await body(res)).toEqual({ owner: "alice@example.com", tenant: "default" });
	});

	it("trims surrounding whitespace from the identity header value", async () => {
		const app = makeApp(baseConfig);
		const res = await app.request("/mcp", {
			headers: { Authorization: `Bearer ${API_KEY}`, "x-librechat-user-id": "  bob  " },
		});
		expect(res.status).toBe(200);
		expect(await body(res)).toEqual({ owner: "bob", tenant: "default" });
	});

	it("isolates two end-users behind the same static credential", async () => {
		const app = makeApp(baseConfig);
		const a = await app.request("/mcp", {
			headers: { Authorization: `Bearer ${API_KEY}`, "x-librechat-user-id": "user-a" },
		});
		const b = await app.request("/mcp", {
			headers: { Authorization: `Bearer ${API_KEY}`, "x-librechat-user-id": "user-b" },
		});
		expect((await body(a)).owner).toBe("user-a");
		expect((await body(b)).owner).toBe("user-b");
	});

	it("falls back to defaultSub when the identity header is absent", async () => {
		const app = makeApp({ ...baseConfig, defaultSub: "shared-owner" });
		const res = await app.request("/mcp", { headers: { Authorization: `Bearer ${API_KEY}` } });
		expect(res.status).toBe(200);
		expect(await body(res)).toEqual({ owner: "shared-owner", tenant: "default" });
	});

	it("returns 401 AUTH_IDENTITY_REQUIRED when no header and no defaultSub", async () => {
		const app = makeApp(baseConfig);
		const res = await app.request("/mcp", { headers: { Authorization: `Bearer ${API_KEY}` } });
		expect(res.status).toBe(401);
		expect((await body(res)).code).toBe("AUTH_IDENTITY_REQUIRED");
	});

	it("returns 401 AUTH_IDENTITY_INVALID for an empty identity header", async () => {
		const app = makeApp(baseConfig);
		const res = await app.request("/mcp", {
			headers: { Authorization: `Bearer ${API_KEY}`, "x-librechat-user-id": "   " },
		});
		expect(res.status).toBe(401);
		expect((await body(res)).code).toBe("AUTH_IDENTITY_INVALID");
	});

	it("uses the configured custom identity header", async () => {
		const app = makeApp({ ...baseConfig, identityHeader: "x-user-email" });
		const res = await app.request("/mcp", {
			headers: { Authorization: `Bearer ${API_KEY}`, "x-user-email": "carol@example.com" },
		});
		expect(res.status).toBe(200);
		expect((await body(res)).owner).toBe("carol@example.com");
	});

	it("assigns the configured static tenant", async () => {
		const app = makeApp({ ...baseConfig, tenant: "tenant-a" }, ["default", "tenant-a"]);
		const res = await app.request("/mcp", {
			headers: { Authorization: `Bearer ${API_KEY}`, "x-librechat-user-id": "dave" },
		});
		expect(res.status).toBe(200);
		expect(await body(res)).toEqual({ owner: "dave", tenant: "tenant-a" });
	});

	it("still accepts a valid JWT when static auth is enabled (falls through)", async () => {
		const app = makeApp(baseConfig);
		const token = await makeJwt({ sub: "jwt-agent" });
		const res = await app.request("/mcp", { headers: { Authorization: `Bearer ${token}` } });
		expect(res.status).toBe(200);
		expect(await body(res)).toEqual({ owner: "jwt-agent", tenant: "default" });
	});

	it("does not derive owner from the identity header on the JWT path", async () => {
		// A JWT caller's sub must win — the identity header is only consulted on
		// the static-key path, so it cannot override a verified JWT principal.
		const app = makeApp(baseConfig);
		const token = await makeJwt({ sub: "jwt-agent" });
		const res = await app.request("/mcp", {
			headers: { Authorization: `Bearer ${token}`, "x-librechat-user-id": "attacker" },
		});
		expect((await body(res)).owner).toBe("jwt-agent");
	});

	it("rejects a wrong key that is not a valid JWT with AUTH_INVALID", async () => {
		const app = makeApp(baseConfig);
		const res = await app.request("/mcp", {
			headers: { Authorization: "Bearer not-the-key-and-not-a-jwt", "x-librechat-user-id": "mallory" },
		});
		expect(res.status).toBe(401);
		expect((await body(res)).code).toBe("AUTH_INVALID");
	});

	it("returns 401 AUTH_REQUIRED when the Authorization header is missing", async () => {
		const app = makeApp(baseConfig);
		const res = await app.request("/mcp", { headers: { "x-librechat-user-id": "alice" } });
		expect(res.status).toBe(401);
		expect((await body(res)).code).toBe("AUTH_REQUIRED");
	});

	it("with static auth disabled, the API key value is rejected (JWT-only)", async () => {
		const app = makeApp(undefined);
		const res = await app.request("/mcp", {
			headers: { Authorization: `Bearer ${API_KEY}`, "x-librechat-user-id": "alice" },
		});
		expect(res.status).toBe(401);
		expect((await body(res)).code).toBe("AUTH_INVALID");
	});

	it("returns 401 AUTH_UNKNOWN_TENANT when the static tenant is not configured", async () => {
		// tenant config does not include "ghost", simulating a tenant removed after startup.
		const app = makeApp({ ...baseConfig, tenant: "ghost" }, ["default"]);
		const res = await app.request("/mcp", {
			headers: { Authorization: `Bearer ${API_KEY}`, "x-librechat-user-id": "alice" },
		});
		expect(res.status).toBe(401);
		expect((await body(res)).code).toBe("AUTH_UNKNOWN_TENANT");
	});
});

/**
 * Unit tests for POST /v1/auth/admin (US-057c)
 */

import { Hono } from "hono";
import { SignJWT, jwtVerify } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultRateLimitStore } from "../../rate-limit.js";
import { authRoutes } from "../../routes/auth.js";
import { app } from "../../server.js";

const AUTH_SECRET = "test-secret-for-admin-endpoint-exactly-32b";
const ADMIN_SECRET = "test-admin-secret-for-token-minting";

async function makeCallerToken(sub: string): Promise<string> {
	const key = new TextEncoder().encode(AUTH_SECRET);
	return new SignJWT({ sub }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().sign(key);
}

describe("POST /v1/auth/admin", () => {
	const originalAuthSecret = process.env.AUTH_SECRET;
	const originalAdminSecret = process.env.ADMIN_SECRET;
	const originalDatabaseUrl = process.env.DATABASE_URL;
	const originalTenantDatabases = process.env.TENANT_DATABASES;

	beforeEach(() => {
		defaultRateLimitStore.reset();
		process.env.AUTH_SECRET = AUTH_SECRET;
		process.env.ADMIN_SECRET = ADMIN_SECRET;
		// The admin route now validates tenant against the configured tenants;
		// register both `default` and `tenant-a` so the existing test covering
		// tenant claim forwarding can mint a token.
		process.env.TENANT_DATABASES = JSON.stringify({
			default: "postgres://test@localhost:5432/test_default",
			"tenant-a": "postgres://test@localhost:5432/test_tenant_a",
		});
		// The server wires the legacy lazy authMiddleware, which resolves a
		// TenantConfig from env on first request. DATABASE_URL makes that
		// resolve to the single-tenant "default" fallback.
		process.env.DATABASE_URL ??= "postgres://test@localhost:5432/test";
	});

	afterEach(() => {
		process.env.AUTH_SECRET = originalAuthSecret ?? "";
		process.env.ADMIN_SECRET = originalAdminSecret ?? "";
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

	it("creates token via endpoint, decode verifies sub matches", async () => {
		const callerToken = await makeCallerToken("admin");
		const res = await app.request("/v1/auth/admin", {
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
		const res = await app.request("/v1/auth/admin", {
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
		const res = await app.request("/v1/auth/admin", {
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
		const res = await app.request("/v1/auth/admin", {
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
		const res = await app.request("/v1/auth/admin", {
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
		const res = await app.request("/v1/auth/admin", {
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
		const res = await app.request("/v1/auth/admin", {
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
		const res = await app.request("/v1/auth/admin", {
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

	it("returns 403 when X-Admin-Secret length differs from configured secret", async () => {
		// Regression: pre-PR helper short-circuited on length mismatch (length oracle).
		// The new sha256-digest compare must still return false without throwing.
		const callerToken = await makeCallerToken("admin");
		const res = await app.request("/v1/auth/admin", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${callerToken}`,
				"Content-Type": "application/json",
				"X-Admin-Secret": "x",
			},
			body: JSON.stringify({ sub: "agent-001" }),
		});
		expect(res.status).toBe(403);
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("FORBIDDEN");
	});

	it("returns 500 ADMIN_NOT_CONFIGURED when ADMIN_SECRET is unset", async () => {
		Reflect.deleteProperty(process.env, "ADMIN_SECRET");
		const callerToken = await makeCallerToken("admin");
		const res = await app.request("/v1/auth/admin", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${callerToken}`,
				"Content-Type": "application/json",
				"X-Admin-Secret": "anything",
			},
			body: JSON.stringify({ sub: "agent-001" }),
		});
		expect(res.status).toBe(500);
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("ADMIN_NOT_CONFIGURED");
	});

	it("does not run validateBody when X-Admin-Secret is wrong (403 not 400)", async () => {
		// Body is invalid (sub empty). Secret check must run first → 403, not 400.
		const callerToken = await makeCallerToken("admin");
		const res = await app.request("/v1/auth/admin", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${callerToken}`,
				"Content-Type": "application/json",
				"X-Admin-Secret": "wrong-secret",
			},
			body: JSON.stringify({ sub: "" }),
		});
		expect(res.status).toBe(403);
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("FORBIDDEN");
	});

	it("emits admin_token_issued audit log with jti matching token claim, no token in log", async () => {
		const logs: string[] = [];
		const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			for (const a of args) {
				if (typeof a === "string") logs.push(a);
			}
		});

		try {
			const callerToken = await makeCallerToken("admin");
			const res = await app.request("/v1/auth/admin", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${callerToken}`,
					"Content-Type": "application/json",
					"X-Admin-Secret": ADMIN_SECRET,
				},
				body: JSON.stringify({ sub: "agent-jti", expiresIn: "24h" }),
			});
			expect(res.status).toBe(201);
			const body = (await res.json()) as { token: string };

			const issued = logs
				.map((l) => {
					try {
						return JSON.parse(l) as Record<string, unknown>;
					} catch {
						return null;
					}
				})
				.find((o): o is Record<string, unknown> => o !== null && o.event === "admin_token_issued");

			expect(issued).toBeDefined();
			expect(typeof issued?.jti).toBe("string");
			expect(issued?.sub).toBe("agent-jti");
			expect(issued?.caller).toBe("admin");

			// Token string must NEVER appear in any log line.
			for (const line of logs) {
				expect(line.includes(body.token)).toBe(false);
			}

			const key = new TextEncoder().encode(AUTH_SECRET);
			const { payload } = await jwtVerify(body.token, key, { algorithms: ["HS256"] });
			expect(payload.jti).toBe(issued?.jti);
		} finally {
			spy.mockRestore();
		}
	});

	it("returns 500 AUTH_NOT_CONFIGURED when AUTH_SECRET is unset (route-level branch)", async () => {
		// The full app's Bearer middleware would 401 first when AUTH_SECRET is
		// unset, masking the route-level branch. Mount `authRoutes()` behind a
		// stub middleware that injects `owner`/`tenant` so the route branch is
		// reachable and the 500 path is exercised end-to-end.
		Reflect.deleteProperty(process.env, "AUTH_SECRET");
		const isolated = new Hono<{ Variables: { owner: string; tenant: string } }>();
		isolated.use("*", async (c, next) => {
			c.set("owner", "stub-caller");
			c.set("tenant", "default");
			await next();
		});
		isolated.route("/v1/auth", authRoutes());

		const res = await isolated.request("/v1/auth/admin", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Admin-Secret": ADMIN_SECRET,
			},
			body: JSON.stringify({ sub: "agent-001" }),
		});
		expect(res.status).toBe(500);
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("AUTH_NOT_CONFIGURED");
	});

	it("emits admin_token_denied audit log on 403", async () => {
		const logs: string[] = [];
		const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			for (const a of args) {
				if (typeof a === "string") logs.push(a);
			}
		});

		try {
			const callerToken = await makeCallerToken("admin");
			const res = await app.request("/v1/auth/admin", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${callerToken}`,
					"Content-Type": "application/json",
					"X-Admin-Secret": "wrong-secret",
				},
				body: JSON.stringify({ sub: "agent-001" }),
			});
			expect(res.status).toBe(403);

			const denied = logs
				.map((l) => {
					try {
						return JSON.parse(l) as Record<string, unknown>;
					} catch {
						return null;
					}
				})
				.find((o): o is Record<string, unknown> => o !== null && o.event === "admin_token_denied");
			expect(denied).toBeDefined();
			expect(denied?.reason).toBe("mismatch");
			expect(denied?.caller).toBe("admin");
		} finally {
			spy.mockRestore();
		}
	});
});

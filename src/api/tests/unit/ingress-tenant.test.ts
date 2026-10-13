import { Hono } from "hono";
import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AuthVariables, createAuthMiddleware } from "../../auth.js";
import { IngressAdmission, loadIngressOptions, retainIngressWork } from "../../ingress-admission.js";
import { defaultRateLimitStore } from "../../rate-limit.js";
import { authRoutes } from "../../routes/auth.js";
import type { TenantConfig } from "../../tenants.js";

const secret = "tenant-ingress-test-secret-32-bytes";
const config: TenantConfig = {
	tenantIds: ["a", "b"],
	hasTenant: (id) => id === "a" || id === "b",
	getConnectionString: () => "postgres://unused/test",
};
const token = (tenant: string, sub = "owner") =>
	new SignJWT({ tenant, sub }).setProtectedHeader({ alg: "HS256" }).sign(new TextEncoder().encode(secret));
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}
function setup(staticAuth = false) {
	vi.stubEnv("AUTH_SECRET", secret);
	const ingress = new IngressAdmission(loadIngressOptions({}));
	const app = new Hono<{ Variables: AuthVariables }>();
	app.onError((_error, c) => c.text("failed", 400));
	app.use(
		"*",
		createAuthMiddleware(
			config,
			staticAuth
				? { staticAuth: { apiKey: "static-key", tenant: "a", identityHeader: "X-Owner", defaultSub: "static-owner" } }
				: {},
		),
	);
	app.use("*", ingress.middleware);
	return { app, ingress };
}
async function consume(response: Response | Promise<Response>) {
	const result = await response;
	if (!result.bodyUsed) await result.arrayBuffer();
	return result;
}

beforeEach(() => defaultRateLimitStore.reset());
afterEach(() => vi.unstubAllEnvs());

describe("tenant ingress", () => {
	it("validates a positive quota that leaves another tenant a slot", () => {
		expect(loadIngressOptions({ SQL_FS_MAX_INGRESS_REQUESTS: "1" }).maxTenantRequests).toBe(1);
		for (const value of ["0", "-1", "1.5", "NaN", "Infinity", "9007199254740992", "8", "9"]) {
			expect(() => loadIngressOptions({ SQL_FS_MAX_INGRESS_TENANT_REQUESTS: value })).toThrow(
				"SQL_FS_MAX_INGRESS_TENANT_REQUESTS",
			);
		}
		expect(() =>
			loadIngressOptions({ SQL_FS_MAX_INGRESS_REQUESTS: "1", SQL_FS_MAX_INGRESS_TENANT_REQUESTS: "2" }),
		).toThrow();
		expect(loadIngressOptions({ SQL_FS_MAX_INGRESS_MCP_LISTENERS: "1" }).maxTenantMcpListeners).toBe(1);
		for (const value of ["8", "9"]) {
			expect(() => loadIngressOptions({ SQL_FS_MAX_INGRESS_TENANT_MCP_LISTENERS: value })).toThrow(
				"SQL_FS_MAX_INGRESS_TENANT_MCP_LISTENERS",
			);
		}
		expect(() =>
			loadIngressOptions({
				SQL_FS_MAX_INGRESS_MCP_LISTENERS: "1",
				SQL_FS_MAX_INGRESS_TENANT_MCP_LISTENERS: "2",
			}),
		).toThrow();
	});

	it("aggregates owners after body EOF while another tenant parses and completes", async () => {
		const { app, ingress } = setup();
		const hold = deferred();
		app.post("/work", async (c) => {
			await c.req.text();
			if (c.get("tenant") === "a") await hold.promise;
			return c.text("ok");
		});
		const pending: (Response | Promise<Response>)[] = [];
		try {
			for (let i = 0; i < 4; i++)
				pending.push(
					app.request("/work", {
						method: "POST",
						headers: { Authorization: `Bearer ${await token("a", `owner-${i}`)}` },
						body: "held",
					}),
				);
			await expect.poll(() => ingress.metrics.retainedRawBytes).toBe(16);
			const denied = await app.request("/work", {
				method: "POST",
				headers: { Authorization: `Bearer ${await token("a")}` },
				body: "denied",
			});
			expect(denied.status).toBe(503);
			expect(denied.headers.get("Retry-After")).toBe("1");
			expect(
				(
					await consume(
						app.request("/work", {
							method: "POST",
							headers: { Authorization: `Bearer ${await token("b")}` },
							body: "other",
						}),
					)
				).status,
			).toBe(200);
		} finally {
			hold.resolve();
			await Promise.all(pending.map(consume));
		}
		expect(ingress.metrics).toMatchObject({ activeRequests: 0, retainedRawBytes: 0 });
		expect(
			(
				await consume(
					app.request("/work", {
						method: "POST",
						headers: { Authorization: `Bearer ${await token("a")}` },
						body: "again",
					}),
				)
			).status,
		).toBe(200);
	});

	it("counts SSE responses through cancellation and reuses released capacity", async () => {
		const { app, ingress } = setup();
		app.post("/events", () => new Response(new ReadableStream(), { headers: { "Content-Type": "text/event-stream" } }));
		const headers = { Authorization: `Bearer ${await token("a")}` };
		const responses: Response[] = [];
		try {
			for (let i = 0; i < 4; i++)
				responses.push(await app.request("/events", { method: "POST", headers, body: "held" }));
			expect((await consume(app.request("/events", { method: "POST", headers, body: "held" }))).status).toBe(503);
			await responses.pop()!.body!.cancel();
			responses.push(await app.request("/events", { method: "POST", headers, body: "held" }));
			expect(responses.at(-1)!.status).toBe(200);
		} finally {
			await Promise.all(responses.map((response) => response.body!.cancel()));
		}
		expect(ingress.metrics.activeRequests).toBe(0);
	});

	it("rejects invalid authentication before capacity allocation and accounts for static MCP tenants", async () => {
		const { app, ingress } = setup(true);
		const hold = deferred();
		app.post("/mcp", async (c) => {
			await c.req.text();
			await hold.promise;
			return c.text("ok");
		});
		for (let i = 0; i < 10; i++)
			expect(
				(
					await consume(
						app.request("/mcp", { method: "POST", headers: { Authorization: "Bearer invalid" }, body: "bad" }),
					)
				).status,
			).toBe(401);
		expect(ingress.metrics).toMatchObject({ activeRequests: 0, retainedRawBytes: 0, refused: 0 });
		const pending = Array.from({ length: 4 }, (_, i) =>
			app.request("/mcp", {
				method: "POST",
				headers: { Authorization: "Bearer static-key", "X-Owner": `owner-${i}` },
				body: "held",
			}),
		);
		try {
			await expect.poll(() => ingress.metrics.activeRequests).toBe(4);
			expect(
				(
					await consume(
						app.request("/mcp", {
							method: "POST",
							headers: { Authorization: `Bearer ${await token("a")}` },
							body: "more",
						}),
					)
				).status,
			).toBe(503);
		} finally {
			hold.resolve();
			await Promise.all(pending.map(consume));
		}
		expect(ingress.metrics.activeRequests).toBe(0);
	});

	it("retains asynchronous work after the handler fails, then releases its quota", async () => {
		const { app, ingress } = setup();
		const hold = deferred();
		let work: Promise<void> | undefined;
		app.post("/work", async (c) => {
			await c.req.text();
			work = retainIngressWork(() => hold.promise)();
			throw new Error("failure");
		});
		expect(
			(
				await consume(
					app.request("/work", {
						method: "POST",
						headers: { Authorization: `Bearer ${await token("a")}` },
						body: "held",
					}),
				)
			).status,
		).toBe(400);
		expect(ingress.metrics).toMatchObject({ activeRequests: 1, retainedRawBytes: 4 });
		hold.resolve();
		await work;
		expect(ingress.metrics).toMatchObject({ activeRequests: 0, retainedRawBytes: 0 });
	});

	it("releases aborted body leases and keeps bootstrap capacity separate from verified tenants", async () => {
		vi.stubEnv("AUTH_SECRET", secret);
		vi.stubEnv("ADMIN_SECRET", "admin-secret");
		vi.stubEnv("BOOTSTRAP_RATE_LIMIT_MAX", "100");
		const ingress = new IngressAdmission(loadIngressOptions({}));
		const app = new Hono<{ Variables: AuthVariables }>();
		app.onError((_error, c) => c.text("aborted", 400));
		app.use("*", createAuthMiddleware(config));
		app.route("/v1/auth", authRoutes(ingress));
		app.post("/v1/work", ingress.middleware, async (c) => c.text(await c.req.text()));
		const pending: (Response | Promise<Response>)[] = [];
		const aborts: AbortController[] = [];
		try {
			for (let i = 0; i < 4; i++) {
				const abort = new AbortController();
				aborts.push(abort);
				pending.push(
					app.request(
						new Request("http://localhost/v1/auth/bootstrap", {
							method: "POST",
							headers: { "X-Auth-Secret": secret },
							signal: abort.signal,
							body: new ReadableStream<Uint8Array>({
								start(output) {
									output.enqueue(new TextEncoder().encode("{"));
								},
							}),
							duplex: "half",
						} as RequestInit),
					),
				);
			}
			await expect.poll(() => ingress.metrics.retainedRawBytes).toBe(4);
			expect(
				(
					await consume(
						app.request("/v1/auth/bootstrap", { method: "POST", headers: { "X-Auth-Secret": secret }, body: "{}" }),
					)
				).status,
			).toBe(503);
			expect(
				(
					await consume(
						app.request("/v1/work", {
							method: "POST",
							headers: { Authorization: `Bearer ${await token("b")}` },
							body: "other",
						}),
					)
				).status,
			).toBe(200);
			expect(
				(
					await consume(
						app.request("/v1/auth/admin", {
							method: "POST",
							headers: { Authorization: `Bearer ${await token("a")}` },
							body: "{}",
						}),
					)
				).status,
			).toBe(403);
			expect(ingress.metrics.activeRequests).toBe(4);
		} finally {
			for (const abort of aborts) abort.abort();
			await Promise.all(pending.map(consume));
		}
		expect(ingress.metrics).toMatchObject({ activeRequests: 0, retainedRawBytes: 0 });
		expect(
			(
				await consume(
					app.request("/v1/auth/bootstrap", { method: "POST", headers: { "X-Auth-Secret": secret }, body: "{}" }),
				)
			).status,
		).toBe(400);
		expect(ingress.metrics.activeRequests).toBe(0);
	});

	it("checks bootstrap secrets and rate limits before reserving body capacity", async () => {
		vi.stubEnv("AUTH_SECRET", secret);
		vi.stubEnv("BOOTSTRAP_RATE_LIMIT_MAX", "2");
		const ingress = new IngressAdmission(loadIngressOptions({}));
		const app = new Hono<{ Variables: AuthVariables }>();
		app.use("*", createAuthMiddleware(config));
		app.route("/v1/auth", authRoutes(ingress));
		for (let i = 0; i < 2; i++)
			expect((await consume(app.request("/v1/auth/bootstrap", { method: "POST", body: "invalid" }))).status).toBe(403);
		expect(
			(
				await consume(
					app.request("/v1/auth/bootstrap", {
						method: "POST",
						headers: { "X-Auth-Secret": secret },
						body: "invalid",
					}),
				)
			).status,
		).toBe(429);
		expect(ingress.metrics).toMatchObject({ activeRequests: 0, retainedRawBytes: 0, refused: 0 });
	});
});

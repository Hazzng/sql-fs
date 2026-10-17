import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { SignJWT } from "jose";
import { InMemoryFs } from "just-bash";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BulkIngestFile } from "../../../sql-fs/types.js";
import { type AuthVariables, authMiddleware, createAuthMiddleware } from "../../auth.js";
import { IngressAdmission, loadIngressOptions, retainIngressWork } from "../../ingress-admission.js";
import { signToken } from "../../lib/jwt.js";
import { handleMcpRequest, shutdownMcp } from "../../mcp/server.js";
import { fileRoutes } from "../../routes/files.js";
import { ingestRoutes } from "../../routes/ingest.js";
import { SessionManager } from "../../session-manager.js";

function deferred() {
	let resolve: () => void = () => {};
	const promise = new Promise<void>((release) => {
		resolve = release;
	});
	return { promise, resolve };
}

function setup(maxRequests = 8, maxBytes = 128, maxBodyBytes = 256) {
	const ingress = new IngressAdmission({
		maxRequests,
		maxTenantRequests: Math.max(1, Math.floor(maxRequests / 2)),
		maxBytes,
		maxTenantBytes: Math.max(1, maxBytes - 1),
		maxBodyBytes,
		waitMs: 250,
	});
	const app = new Hono<{ Variables: AuthVariables }>();
	let tenantSequence = 0;
	app.use("*", async (c, next) => {
		c.set("tenant", `test-${tenantSequence++}`);
		await next();
	});
	app.onError((_error, c) => c.json({ error: "invalid body" }, 400));
	app.use("*", ingress.middleware);
	return { ingress, app };
}

async function listen(fetchHandler: Parameters<typeof serve>[0]["fetch"]) {
	const server = serve({ fetch: fetchHandler, port: 0 });
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("HTTP server has no port");
	return {
		url: `http://127.0.0.1:${address.port}`,
		close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
	};
}

afterEach(() => {
	vi.unstubAllEnvs();
	process.env.AUTH_SECRET = "";
});

describe("ingress configuration", () => {
	it("waits 250 ms at ingress by default, independent of the worker queue wait", () => {
		expect(loadIngressOptions({ SQL_FS_WORKER_QUEUE_WAIT_MS: "900" }).waitMs).toBe(250);
		expect(loadIngressOptions({ SQL_FS_MAX_INGRESS_WAIT_MS: "40" }).waitMs).toBe(40);
	});

	it("reserves explicit raw-body headroom with bounded concurrent requests", () => {
		expect(loadIngressOptions({})).toEqual({
			maxRequests: 8,
			maxTenantRequests: 4,
			maxMcpListeners: 8,
			maxTenantMcpListeners: 4,
			maxBytes: 128 * 1024 * 1024,
			maxTenantBytes: 96 * 1024 * 1024,
			maxBodyBytes: 256 * 1024 * 1024,
			waitMs: 250,
		});
	});

	it.each([
		"SQL_FS_MAX_INGRESS_REQUESTS",
		"SQL_FS_MAX_INGRESS_TENANT_REQUESTS",
		"SQL_FS_MAX_INGRESS_MCP_LISTENERS",
		"SQL_FS_MAX_INGRESS_TENANT_MCP_LISTENERS",
		"SQL_FS_MAX_INGRESS_BYTES",
		"SQL_FS_MAX_INGRESS_TENANT_BYTES",
		"MAX_REQUEST_BODY_BYTES",
		"SQL_FS_MAX_INGRESS_WAIT_MS",
	])("rejects invalid %s instead of disabling its budget", (name) => {
		for (const value of ["0", "-1", "1.5", "NaN", "Infinity", "9007199254740992"]) {
			expect(() => loadIngressOptions({ [name]: value })).toThrow(name);
		}
	});
});

describe("HTTP body admission", () => {
	it("rejects excess request count without reading the rejected body", async () => {
		const { app, ingress } = setup(1);
		const hold = deferred();
		const entered = deferred();
		app.post("/hold", async (c) => {
			await c.req.text();
			entered.resolve();
			await hold.promise;
			return c.text("held");
		});
		let writes = 0;
		app.put("/write", async (c) => {
			await c.req.text();
			writes++;
			return c.body(null, 204);
		});
		const first = app.request("/hold", { method: "POST", body: "retained" });
		await entered.promise;
		let reads = 0;
		let cancelled = false;
		const stream = new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					reads++;
					controller.enqueue(new Uint8Array(100));
				},
				cancel() {
					cancelled = true;
				},
			},
			{ highWaterMark: 0 },
		);
		try {
			const response = await app.request(
				new Request("http://localhost/write", { method: "PUT", body: stream, duplex: "half" } as RequestInit),
			);
			expect(response.status).toBe(503);
			expect(response.headers.get("Retry-After")).toBe("1");
			expect(await response.json()).toEqual({
				code: "EWORKER_BUSY",
				error: "Request capacity is busy",
				retryable: true,
			});
			expect(reads).toBe(0);
			expect(cancelled).toBe(true);
			expect(writes).toBe(0);
			expect(ingress.metrics).toMatchObject({ activeRequests: 1, retainedRawBytes: 8, refused: 1 });
		} finally {
			hold.resolve();
			await (await first).arrayBuffer();
		}
		expect(ingress.metrics).toMatchObject({ activeRequests: 0, retainedRawBytes: 0 });
	});

	it("counts actual chunks instead of trusting Content-Length", async () => {
		const { app, ingress } = setup(8, 100);
		let mutations = 0;
		app.put("/write", async (c) => {
			await c.req.arrayBuffer();
			mutations++;
			return c.body(null, 204);
		});
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(60));
				controller.enqueue(new Uint8Array(60));
				controller.close();
			},
		});
		const response = await app.request(
			new Request("http://localhost/write", {
				method: "PUT",
				headers: { "Content-Length": "1" },
				body: stream,
				duplex: "half",
			} as RequestInit),
		);
		expect(response.status).toBe(413);
		expect(await response.json()).toMatchObject({
			code: "PAYLOAD_TOO_LARGE",
			details: ["Request body exceeds limit (99 bytes)"],
		});
		expect(mutations).toBe(0);
		expect(ingress.metrics).toMatchObject({ activeRequests: 0, retainedRawBytes: 0, payloadTooLarge: 1, refused: 0 });
	});

	it("preserves per-request 413 while counting underdeclared bodies", async () => {
		const { app, ingress } = setup(8, 100, 20);
		let mutations = 0;
		app.put("/write", async (c) => {
			await c.req.text();
			mutations++;
			return c.text("written");
		});
		const response = await app.request("/write", {
			method: "PUT",
			headers: { "Content-Length": "1" },
			body: "x".repeat(21),
		});
		expect(response.status).toBe(413);
		expect(await response.json()).toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
		expect(mutations).toBe(0);
		expect(ingress.metrics).toMatchObject({ retainedRawBytes: 0, activeRequests: 0, payloadTooLarge: 1 });
	});

	it("admits bodyless API requests within the same bounded capacity", async () => {
		const { app, ingress } = setup(1);
		const hold = deferred();
		const entered = deferred();
		app.post("/hold", async (c) => {
			await c.req.text();
			entered.resolve();
			await hold.promise;
			return c.text("done");
		});
		app.get("/health", (c) => c.text("ok"));
		const first = app.request("/hold", { method: "POST", body: "payload" });
		await entered.promise;
		try {
			const response = await app.request("/health");
			expect(response.status).toBe(503);
			expect(response.headers.get("Retry-After")).toBe("1");
			await response.arrayBuffer();
			expect(ingress.metrics.activeRequests).toBe(1);
		} finally {
			hold.resolve();
			await (await first).arrayBuffer();
		}
	});

	it("cancels incomplete uploads and releases body capacity", async () => {
		const { app, ingress } = setup(1);
		let mutations = 0;
		app.put("/write", async (c) => {
			await c.req.text();
			mutations++;
			return c.text("written");
		});
		const controller = new AbortController();
		let cancelled = false;
		const stream = new ReadableStream<Uint8Array>({
			start(output) {
				output.enqueue(new TextEncoder().encode("partial"));
			},
			cancel() {
				cancelled = true;
			},
		});
		const response = app.request(
			new Request("http://localhost/write", {
				method: "PUT",
				body: stream,
				signal: controller.signal,
				duplex: "half",
			} as RequestInit),
		);
		await expect.poll(() => ingress.metrics.retainedRawBytes).toBe(7);
		controller.abort();
		expect((await response).status).toBe(499);
		expect(cancelled).toBe(true);
		expect(mutations).toBe(0);
		expect(ingress.metrics).toMatchObject({ activeRequests: 0, retainedRawBytes: 0, aborted: 1 });
		const next = await app.request("/write", { method: "PUT", body: "next" });
		expect(await next.text()).toBe("written");
		expect(mutations).toBe(1);
	});

	it("keeps the real file-route limiter from executing an aborted partial upload", async () => {
		const fs = new InMemoryFs();
		const manager = new SessionManager({ createFs: async () => fs });
		await manager.getOrCreate("default", "file-upload", undefined, "owner");
		const ingress = new IngressAdmission({
			maxRequests: 2,
			maxTenantRequests: 1,
			maxBytes: 100,
			maxTenantBytes: 99,
			maxBodyBytes: 256,
			waitMs: 250,
		});
		const app = new Hono<{ Variables: AuthVariables }>();
		app.onError((_error, c) => c.text("body rejected", 400));
		app.use("*", async (c, next) => {
			c.set("owner", "owner");
			c.set("tenant", "default");
			await next();
		});
		app.use("*", ingress.middleware);
		app.route("/v1/sandboxes", fileRoutes(manager));
		const controller = new AbortController();
		const stream = new ReadableStream<Uint8Array>({
			start(output) {
				output.enqueue(new TextEncoder().encode("partial"));
			},
		});
		const response = app.request(
			new Request("http://localhost/v1/sandboxes/file-upload/files/upload", {
				method: "PUT",
				body: stream,
				signal: controller.signal,
				duplex: "half",
			} as RequestInit),
		);
		await expect.poll(() => ingress.metrics.retainedRawBytes).toBe(7);
		controller.abort();
		expect((await response).status).toBe(499);
		expect(await fs.exists("/upload")).toBe(false);
		expect(ingress.metrics).toMatchObject({ activeRequests: 0, retainedRawBytes: 0 });
	});

	it("rejects an oversized declared body before reading its bytes", async () => {
		const { app, ingress } = setup(8, 100, 20);
		let reads = 0;
		const stream = new ReadableStream<Uint8Array>(
			{
				pull(output) {
					reads++;
					output.close();
				},
			},
			{ highWaterMark: 0 },
		);
		const response = await app.request(
			new Request("http://localhost/write", {
				method: "PUT",
				headers: { "Content-Length": "21" },
				body: stream,
				duplex: "half",
			} as RequestInit),
		);
		expect(response.status).toBe(413);
		expect(reads).toBe(0);
		expect(ingress.metrics).toMatchObject({ activeRequests: 0, retainedRawBytes: 0, payloadTooLarge: 1 });
	});

	it("retains request bytes while the SSE callback is active after client cancellation", async () => {
		const { app, ingress } = setup(1);
		const hold = deferred();
		const entered = deferred();
		const finished = deferred();
		app.post("/events", async (c) => {
			await c.req.text();
			return streamSSE(
				c,
				retainIngressWork(async () => {
					entered.resolve();
					await hold.promise;
					finished.resolve();
				}),
			);
		});
		app.post("/other", (c) => c.text("admitted"));
		const response = await app.request("/events", { method: "POST", body: "payload" });
		await entered.promise;
		try {
			expect(ingress.metrics).toMatchObject({ activeRequests: 1, retainedRawBytes: 7 });
			await response.body!.cancel();
			expect(ingress.metrics).toMatchObject({ activeRequests: 1, retainedRawBytes: 7 });
			expect((await app.request("/other", { method: "POST", body: "next" })).status).toBe(503);
			hold.resolve();
			await finished.promise;
			await expect.poll(() => ingress.metrics.activeRequests).toBe(0);
			expect(ingress.metrics.retainedRawBytes).toBe(0);
			const admitted = await app.request("/other", { method: "POST", body: "next" });
			expect(admitted.status).toBe(200);
			await admitted.arrayBuffer();
		} finally {
			hold.resolve();
		}
	});

	it("releases a completed SSE request after its output is consumed", async () => {
		const { app, ingress } = setup(1);
		app.post("/events", async (c) => {
			await c.req.text();
			return streamSSE(
				c,
				retainIngressWork(async (stream) => {
					await stream.writeSSE({ data: "done" });
				}),
			);
		});
		const response = await app.request("/events", { method: "POST", body: "payload" });
		expect(ingress.metrics.activeRequests).toBe(1);
		expect(await response.text()).toContain("data: done");
		expect(ingress.metrics).toMatchObject({ activeRequests: 0, retainedRawBytes: 0 });
	});

	it("keeps real MCP requests charged until the tool finishes after disconnect", async () => {
		const { app, ingress } = setup(2, 4096, 4096);
		const manager = new SessionManager({ createFs: async () => new InMemoryFs() });
		await manager.getOrCreate("default", "mcp-ingress", undefined, "owner");
		const hold = deferred();
		const entered = deferred();
		const occupied = deferred();
		vi.spyOn(manager, "execWithRuntimeThrottle").mockImplementation(async () => {
			entered.resolve();
			await hold.promise;
			return { stdout: "done", stderr: "", exitCode: 0, env: {} };
		});
		app.all("/mcp", (c) => handleMcpRequest(c.req.raw, manager, "owner", "default"));
		app.post("/other", (c) => c.text("admitted"));
		app.post("/occupy", async (c) => {
			await c.req.text();
			await occupied.promise;
			return c.body(null, 204);
		});
		const server = await listen(app.fetch);
		const client = new Client({ name: "ingress-test", version: "1" });
		let operation: Promise<unknown> | undefined;
		let occupying: Promise<Response> | undefined;
		try {
			await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)));
			await expect.poll(() => ingress.metrics.activeRequests).toBe(1);
			operation = client.callTool({ name: "bash_exec", arguments: { id: "mcp-ingress", script: "echo held" } });
			void operation.catch(() => {});
			await entered.promise;
			expect(ingress.metrics.activeRequests).toBe(2);
			expect(ingress.metrics.retainedRawBytes).toBeGreaterThan(30);
			await client.close();
			await expect.poll(() => ingress.metrics.activeRequests).toBe(1);
			occupying = fetch(`${server.url}/occupy`, { method: "POST", body: "held" });
			await expect.poll(() => ingress.metrics.activeRequests).toBe(2);
			const rejected = await fetch(`${server.url}/other`, { method: "POST", body: "another" });
			expect(rejected.status).toBe(503);
			hold.resolve();
			await expect.poll(() => ingress.metrics.activeRequests).toBe(1);
			occupied.resolve();
			await (await occupying).arrayBuffer();
			await expect.poll(() => ingress.metrics.activeRequests).toBe(0);
			expect(ingress.metrics.retainedRawBytes).toBe(0);
		} finally {
			hold.resolve();
			occupied.resolve();
			if (occupying !== undefined) await occupying;
			await client.close();
			if (operation !== undefined) await Promise.allSettled([operation]);
			await shutdownMcp();
			await server.close();
		}
	});

	it("bounds real MCP SSE listeners separately from authenticated tool requests", async () => {
		const secret = "mcp-listener-admission-test-secret-32-bytes";
		vi.stubEnv("AUTH_SECRET", secret);
		const ingress = new IngressAdmission(loadIngressOptions({}));
		const manager = new SessionManager({ createFs: async () => new InMemoryFs() });
		await manager.getOrCreate("default", "mcp-ingress", undefined, "owner");
		const tenantConfig = {
			tenantIds: ["default", "other"],
			hasTenant: (tenant: string) => tenant === "default" || tenant === "other",
			getConnectionString: () => "postgres://unused/test",
		};
		const app = new Hono<{ Variables: AuthVariables }>();
		app.use("/mcp", createAuthMiddleware(tenantConfig));
		app.use("/mcp", ingress.mcpMiddleware);
		app.all("/mcp", (c) => handleMcpRequest(c.req.raw, manager, c.get("owner"), c.get("tenant")));
		const server = await listen(app.fetch);
		const makeClient = async (tenant: string) => {
			const token = await signToken({ sub: "mcp-listener-test", tenant, secret });
			const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), {
				requestInit: { headers: { Authorization: `Bearer ${token}` } },
			});
			const client = new Client({ name: "mcp-listener-admission-test", version: "1" });
			await client.connect(transport);
			return client;
		};
		const clients: Client[] = [];
		let fifthClient: Client | undefined;
		let deniedGet: Response | undefined;
		try {
			for (let index = 0; index < 4; index++) {
				const client = await makeClient("default");
				clients.push(client);
			}
			await expect.poll(() => ingress.metrics.activeMcpListeners).toBe(4);
			expect(ingress.metrics.activeRequests).toBe(0);

			const called = await clients[0]?.callTool({ name: "sandbox_create", arguments: { name: "active-listener" } });
			expect(called?.isError).not.toBe(true);
			const content = (called as { content: Array<{ type: string; text?: string }> }).content;
			expect(JSON.parse(content[0]?.type === "text" ? (content[0].text ?? "{}") : "{}")).toMatchObject({
				name: "active-listener",
			});
			expect(ingress.metrics.activeRequests).toBe(0);

			const fifthToken = await signToken({ sub: "mcp-listener-test", tenant: "default", secret });
			const fifthTransport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), {
				requestInit: { headers: { Authorization: `Bearer ${fifthToken}` } },
				fetch: async (input, init) => {
					const response = await fetch(input, init);
					if (init?.method === "GET" && !response.ok) deniedGet = response.clone();
					return response;
				},
			});
			fifthClient = new Client({ name: "mcp-listener-admission-test", version: "1" });
			await fifthClient.connect(fifthTransport);
			await expect.poll(() => deniedGet?.status).toBe(503);
			expect(deniedGet?.status).toBe(503);
			expect(await deniedGet?.json()).toMatchObject({ code: "EWORKER_BUSY", retryable: true });
			expect(ingress.metrics).toMatchObject({
				activeMcpListeners: 4,
				queuedMcpListeners: 0,
				mcpListenerQueueTimeouts: 1,
			});

			const otherTenant = await makeClient("other");
			clients.push(otherTenant);
			await expect.poll(() => ingress.metrics.activeMcpListeners).toBe(5);
		} finally {
			await fifthClient?.close().catch(() => {});
			await Promise.allSettled(clients.map((client) => client.close()));
			await expect.poll(() => ingress.metrics.activeMcpListeners).toBe(0);
			await shutdownMcp();
			ingress.close();
			const token = await signToken({ sub: "mcp-listener-test", tenant: "default", secret });
			const closed = await fetch(`${server.url}/mcp`, {
				headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
			});
			expect(closed.status).toBe(503);
			expect(await closed.json()).toMatchObject({ code: "ESHUTTINGDOWN" });
			await server.close();
		}
	});

	it("shows retained MCP requests can exhaust the shared ordinary request quota", async () => {
		const secret = "mcp-listener-admission-test-secret-32-bytes";
		vi.stubEnv("AUTH_SECRET", secret);
		const ingress = new IngressAdmission(loadIngressOptions({}));
		const manager = new SessionManager({ createFs: async () => new InMemoryFs() });
		const tenantConfig = {
			tenantIds: ["default"],
			hasTenant: (tenant: string) => tenant === "default",
			getConnectionString: () => "postgres://unused/test",
		};
		const app = new Hono<{ Variables: AuthVariables }>();
		app.use("/mcp", createAuthMiddleware(tenantConfig));
		app.use("/mcp", ingress.middleware);
		app.all("/mcp", (c) => handleMcpRequest(c.req.raw, manager, c.get("owner"), c.get("tenant")));
		const server = await listen(app.fetch);
		const token = await signToken({ sub: "mcp-listener-test", tenant: "default", secret });
		const clients: Client[] = [];
		let deniedPost: Response | undefined;
		try {
			for (let index = 0; index < 4; index++) {
				const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), {
					requestInit: { headers: { Authorization: `Bearer ${token}` } },
					fetch: async (input, init) => {
						const response = await fetch(input, init);
						if (index === 0 && init?.method === "POST" && !response.ok) deniedPost = response.clone();
						return response;
					},
				});
				const client = new Client({ name: "mcp-listener-starvation-test", version: "1" });
				await client.connect(transport);
				clients.push(client);
			}
			await expect.poll(() => ingress.metrics.activeRequests).toBe(4);
			await expect(clients[0]?.callTool({ name: "sandbox_create", arguments: { name: "starved" } })).rejects.toThrow();
			expect(deniedPost?.status).toBe(503);
			expect(await deniedPost?.json()).toMatchObject({ code: "EWORKER_BUSY", retryable: true });
		} finally {
			await Promise.allSettled(clients.map((client) => client.close()));
			await shutdownMcp();
			ingress.close();
			await server.close();
		}
	});

	it("bounds concurrent base64 manifests through the real HTTP ingest route", async () => {
		const secret = "test-secret-ingress-at-least-32bytes";
		process.env.AUTH_SECRET = secret;
		const fs = new InMemoryFs();
		const hold = deferred();
		const entered = deferred();
		Object.assign(fs, {
			async bulkIngest(files: BulkIngestFile[]) {
				entered.resolve();
				await hold.promise;
				for (const file of files) await fs.writeFile(file.path, file.content);
			},
		});
		const manager = new SessionManager({ createFs: async () => fs });
		await manager.getOrCreate("default", "ingress", undefined, "owner");
		const ingress = new IngressAdmission({
			maxRequests: 8,
			maxTenantRequests: 4,
			maxBytes: 150,
			maxTenantBytes: 149,
			maxBodyBytes: 256,
			waitMs: 250,
		});
		const app = new Hono<{ Variables: AuthVariables }>();
		app.use("/v1/*", authMiddleware);
		app.use("*", ingress.middleware);
		app.route("/v1/sandboxes", ingestRoutes(manager));
		const server = await listen(app.fetch);
		const token = await new SignJWT({ sub: "owner" })
			.setProtectedHeader({ alg: "HS256" })
			.sign(new TextEncoder().encode(secret));
		const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
		const firstBody = JSON.stringify({ basePath: "/", files: { first: Buffer.alloc(40, 97).toString("base64") } });
		const first = fetch(`${server.url}/v1/sandboxes/ingress/ingest-files`, {
			method: "POST",
			headers,
			body: firstBody,
		});
		await entered.promise;
		try {
			const response = await fetch(`${server.url}/v1/sandboxes/ingress/ingest-files`, {
				method: "POST",
				headers,
				body: JSON.stringify({ basePath: "/", files: { second: Buffer.alloc(40, 98).toString("base64") } }),
				signal: AbortSignal.timeout(2000),
			});
			expect(response.status).toBe(503);
			expect(response.headers.get("Retry-After")).toBe("1");
			expect(await response.json()).toMatchObject({ code: "EWORKER_BUSY", retryable: true });
			expect(await fs.exists("/second")).toBe(false);
			expect(ingress.metrics.retainedRawBytes).toBe(Buffer.byteLength(firstBody));
			hold.resolve();
			expect((await first).status).toBe(200);
			expect(await fs.readFile("/first")).toBe("a".repeat(40));
			expect(ingress.metrics).toMatchObject({ activeRequests: 0, retainedRawBytes: 0 });
		} finally {
			hold.resolve();
			await (await first).arrayBuffer();
			await server.close();
		}
	});
});

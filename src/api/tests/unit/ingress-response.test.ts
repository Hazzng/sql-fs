import { type ClientRequest, request as httpRequest, IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AuthVariables } from "../../auth.js";
import { IngressAdmission, loadIngressOptions, retainIngressWork } from "../../ingress-admission.js";

function setup(maxRequests = 8, maxTenantRequests = 4) {
	const ingress = new IngressAdmission(
		loadIngressOptions({
			SQL_FS_MAX_INGRESS_REQUESTS: String(maxRequests),
			SQL_FS_MAX_INGRESS_TENANT_REQUESTS: String(maxTenantRequests),
		}),
	);
	const app = new Hono<{ Variables: AuthVariables }>();
	app.onError((_error, c) => c.text("failed", 500));
	app.use("*", (c, next) => {
		c.set("tenant", c.req.header("X-Tenant") ?? "a");
		return ingress.middleware(c, next);
	});
	return { app, ingress };
}

function pausedDownload(url: string, tenant: string, method: "GET" | "POST") {
	let request: ClientRequest;
	const ready = new Promise<IncomingMessage>((resolve, reject) => {
		request = httpRequest(url, { method, headers: { "X-Tenant": tenant } }, (response) => {
			response.pause();
			response.on("error", () => {});
			resolve(response);
		});
		request.on("error", reject);
		request.end(method === "POST" ? "input" : undefined);
	});
	return { ready, close: () => request.destroy() };
}

async function consume(response: Response | Promise<Response>) {
	const result = await response;
	await result.arrayBuffer();
	return result;
}

describe("request and response admission", () => {
	it.each(["GET", "POST"] as const)(
		"holds eight Node %s permits beyond readable EOF and isolates four downloads per tenant",
		async (method) => {
			const { app, ingress } = setup();
			const outgoing: ServerResponse[] = [];
			let closedBodies = 0;
			let downloads = 0;
			app.on(["GET", "POST"], "/large", async (c) => {
				if (c.req.method === "POST") await c.req.text();
				downloads++;
				const response = c.body(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new Uint8Array(8 * 1024 * 1024));
							controller.close();
							closedBodies++;
						},
					}),
				);
				void response.body;
				return response;
			});
			app.get("/small", (c) => c.text("other tenant progresses"));
			const server = serve({
				port: 0,
				fetch: (request, env) => {
					if (new URL(request.url).pathname === "/large" && env.outgoing instanceof ServerResponse) {
						outgoing.push(env.outgoing);
					}
					return app.fetch(request, env);
				},
			});
			await new Promise<void>((resolve) => server.once("listening", resolve));
			const address = server.address();
			if (address === null || typeof address === "string") throw new Error("No server port");
			const url = `http://127.0.0.1:${address.port}`;
			const clients: ReturnType<typeof pausedDownload>[] = [];
			try {
				for (let i = 0; i < 4; i++) clients.push(pausedDownload(`${url}/large`, "a", method));
				await Promise.all(clients.map((client) => client.ready));
				await expect.poll(() => outgoing.slice(0, 4).every((response) => response.writableEnded)).toBe(true);
				expect(closedBodies).toBe(4);
				expect(outgoing.slice(0, 4).every((response) => !response.writableFinished)).toBe(true);
				expect(ingress.metrics).toMatchObject({ activeRequests: 4, retainedRawBytes: method === "POST" ? 20 : 0 });
				const sameTenant = await fetch(`${url}/large`, {
					method,
					...(method === "POST" && { body: "input" }),
					headers: { "X-Tenant": "a" },
				});
				expect(sameTenant.status).toBe(503);
				expect(sameTenant.headers.get("Retry-After")).toBe("1");
				await sameTenant.arrayBuffer();
				expect(downloads).toBe(4);
				const healthy = await fetch(`${url}/small`, { headers: { "X-Tenant": "b" } });
				expect(healthy.status).toBe(200);
				expect(await healthy.text()).toBe("other tenant progresses");
				await expect.poll(() => ingress.metrics.activeRequests).toBe(4);
				for (let i = 0; i < 4; i++) clients.push(pausedDownload(`${url}/large`, "b", method));
				await Promise.all(clients.map((client) => client.ready));
				await expect.poll(() => outgoing.slice(-4).every((response) => response.writableEnded)).toBe(true);
				expect(ingress.metrics).toMatchObject({ activeRequests: 8, retainedRawBytes: method === "POST" ? 40 : 0 });
				const full = await fetch(`${url}/small`, { headers: { "X-Tenant": "c" } });
				expect(full.status).toBe(503);
				await full.arrayBuffer();
				expect(downloads).toBe(8);
				expect(ingress.metrics).toMatchObject({ activeRequests: 8, queueTimeouts: 2, refused: 2 });
				clients[0]?.close();
				await expect.poll(() => ingress.metrics.activeRequests).toBe(7);
				const reused = await fetch(`${url}/small`, { headers: { "X-Tenant": "a" } });
				expect(await reused.text()).toBe("other tenant progresses");
				await expect.poll(() => ingress.metrics.activeRequests).toBe(7);
			} finally {
				for (const client of clients) client.close();
				if ("closeAllConnections" in server) server.closeAllConnections();
				await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
			}
			await expect.poll(() => ingress.metrics.activeRequests).toBe(0);
			expect(ingress.metrics).toMatchObject({ activeRequests: 0, queuedRequests: 0, retainedRawBytes: 0 });
		},
	);

	it("keeps bodyless mounted responses admitted until consumption or cancellation", async () => {
		const { app, ingress } = setup(2, 1);
		let dispatched = 0;
		app.get("/data", (c) => {
			dispatched++;
			return c.text("payload");
		});
		const response = await app.request("/data");
		expect(ingress.metrics.activeRequests).toBe(1);
		const refused = await app.request("/data");
		expect(refused.status).toBe(503);
		await refused.arrayBuffer();
		expect(await response.text()).toBe("payload");
		expect(ingress.metrics.activeRequests).toBe(0);
		const next = await app.request("/data");
		expect(ingress.metrics.activeRequests).toBe(1);
		await next.body?.cancel();
		expect(ingress.metrics.activeRequests).toBe(0);
		const held = await app.request("/data");
		const abort = new AbortController();
		const queued = app.request(new Request("http://localhost/data", { signal: abort.signal }));
		await expect.poll(() => ingress.metrics.queuedRequests).toBe(1);
		abort.abort();
		expect((await queued).status).toBe(499);
		expect(dispatched).toBe(3);
		expect(ingress.metrics).toMatchObject({ activeRequests: 1, queuedRequests: 0, aborted: 1 });
		await held.body?.cancel();
		expect(ingress.metrics.activeRequests).toBe(0);
	});

	it("retains ordinary POST response bytes and releases an output error", async () => {
		const { app, ingress } = setup(2, 1);
		app.post("/data", async (c) => {
			await c.req.text();
			return c.text("payload");
		});
		app.get("/error", (c) =>
			c.body(
				new ReadableStream<Uint8Array>({
					pull(controller) {
						controller.error(new Error("broken output"));
					},
				}),
			),
		);
		const response = await app.request("/data", { method: "POST", body: "input" });
		expect(ingress.metrics).toMatchObject({ activeRequests: 1, retainedRawBytes: 5 });
		await consume(response);
		expect(ingress.metrics).toMatchObject({ activeRequests: 0, retainedRawBytes: 0 });

		const broken = await app.request("/error");
		await expect(broken.text()).rejects.toThrow("broken output");
		expect(ingress.metrics.activeRequests).toBe(0);
	});

	it("keeps asynchronous work admitted after a bodyless output is aborted", async () => {
		const { app, ingress } = setup(2, 1);
		let finishWork: () => void = () => {};
		const work = new Promise<void>((resolve) => {
			finishWork = resolve;
		});
		let entered = false;
		app.get("/work", (c) => {
			void retainIngressWork(async () => {
				entered = true;
				await work;
			})();
			return c.body(new ReadableStream<Uint8Array>({}));
		});
		const abort = new AbortController();
		const response = await app.request(new Request("http://localhost/work", { signal: abort.signal }));
		expect(entered).toBe(true);
		abort.abort();
		await expect(response.text()).rejects.toThrow("Request aborted");
		expect(ingress.metrics.activeRequests).toBe(1);
		finishWork();
		await expect.poll(() => ingress.metrics.activeRequests).toBe(0);
		expect(ingress.metrics.aborted).toBe(1);
	});

	it("releases bodyless null responses and refuses them after shutdown", async () => {
		const { app, ingress } = setup(2, 1);
		app.get("/empty", (c) => c.body(null, 204));
		app.get("/head", (c) => c.text("suppressed"));
		const head = await app.request("/head", { method: "HEAD" });
		expect(head.status).toBe(200);
		expect(head.body).toBeNull();
		expect(ingress.metrics.activeRequests).toBe(0);
		expect((await app.request("/empty")).status).toBe(204);
		expect(ingress.metrics.activeRequests).toBe(0);
		ingress.close();
		const response = await app.request("/empty");
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({ code: "ESHUTTINGDOWN" });
		expect(ingress.metrics.activeRequests).toBe(0);
	});
	it.each(["finish", "close", "error", "destroyed"])(
		"releases a Node %s hold once while preserving asynchronous work",
		async (event) => {
			const { app, ingress } = setup(2, 1);
			const socket = new Socket();
			const outgoing = new ServerResponse(new IncomingMessage(socket));
			const errorListener = () => {};
			outgoing.on("error", errorListener);
			if (event === "destroyed") outgoing.destroy();
			let releaseWork: () => void = () => {};
			const work = new Promise<void>((resolve) => {
				releaseWork = resolve;
			});
			let operation: Promise<void> | undefined;
			app.get("/work", (c) => {
				operation = retainIngressWork(() => work)();
				return c.body(null, 204);
			});
			try {
				const response = await app.fetch(new Request("http://localhost/work"), { outgoing });
				expect(response.status).toBe(204);
				expect(ingress.metrics.activeRequests).toBe(1);
				outgoing.emit(event, event === "error" ? new Error("response failed") : undefined);
				outgoing.emit("finish");
				outgoing.emit("close");
				expect(outgoing.listenerCount("finish")).toBe(0);
				expect(outgoing.listenerCount("close")).toBe(0);
				expect(outgoing.listenerCount("error")).toBe(1);
				expect(ingress.metrics.activeRequests).toBe(1);
				releaseWork();
				await operation;
				expect(ingress.metrics.activeRequests).toBe(0);
			} finally {
				releaseWork();
				await operation;
				outgoing.destroy();
				socket.destroy();
			}
		},
	);

	it("releases an acquired response hold when wrapper construction fails", async () => {
		const { app, ingress } = setup(2, 1);
		app.get("/data", (c) => c.text("payload"));
		vi.stubGlobal(
			"ReadableStream",
			new Proxy(ReadableStream, {
				construct(target, args, newTarget) {
					if (args[1]?.highWaterMark === 0) throw new Error("response wrapper failed");
					return Reflect.construct(target, args, newTarget);
				},
			}),
		);
		try {
			const failed = await app.request("/data");
			expect(failed.status).toBe(500);
			expect(ingress.metrics.activeRequests).toBe(0);
		} finally {
			vi.unstubAllGlobals();
		}
		expect(await (await app.request("/data")).text()).toBe("payload");
		expect(ingress.metrics.activeRequests).toBe(0);
	});
});

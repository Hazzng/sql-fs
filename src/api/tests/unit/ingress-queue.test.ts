import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthVariables } from "../../auth.js";
import { IngressAdmission, type IngressOptions, loadIngressOptions } from "../../ingress-admission.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function setup(options: Partial<IngressOptions> = {}) {
	const ingress = new IngressAdmission({
		maxRequests: 2,
		maxTenantRequests: 1,
		maxQueuedRequests: 3,
		maxTenantQueuedRequests: 2,
		maxBytes: 100,
		maxTenantBytes: 75,
		maxBodyBytes: 60,
		waitMs: 250,
		...options,
	});
	const app = new Hono<{ Variables: AuthVariables }>();
	const hold = deferred<void>();
	let dispatched = 0;
	app.onError((_error, c) => c.text("failed", 500));
	app.use("*", (c, next) => {
		c.set("tenant", c.req.header("X-Tenant") ?? "a");
		return c.req.path === "/mcp" ? ingress.mcpMiddleware(c, next) : ingress.middleware(c, next);
	});
	app.on(["GET", "POST"], "/hold", async (c) => {
		await c.req.text();
		await hold.promise;
		return c.text("held");
	});
	app.on(["GET", "POST"], ["/work", "/mcp"], async (c) => {
		dispatched++;
		return c.text(await c.req.text());
	});
	return { app, ingress, hold, dispatched: () => dispatched };
}

function input(chunks: number[], onCancel?: () => void) {
	const observed = { reads: 0, cancelled: false };
	const body = new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				observed.reads++;
				const size = chunks.shift();
				if (size !== undefined) controller.enqueue(new Uint8Array(size));
			},
			cancel() {
				observed.cancelled = true;
				onCancel?.();
			},
		},
		{ highWaterMark: 0 },
	);
	return { body, observed };
}

function request(body: ReadableStream<Uint8Array>, signal?: AbortSignal, tenant = "a") {
	return new Request("http://localhost/work", {
		method: "POST",
		headers: { "X-Tenant": tenant },
		body,
		signal,
		duplex: "half",
	} as RequestInit);
}

async function consume(response: Response | Promise<Response>) {
	const result = await response;
	if (!result.bodyUsed) await result.arrayBuffer();
	return result;
}

const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("ingress queue configuration", () => {
	it.each([
		{ global: 0, tenant: 0 },
		{ global: 1, tenant: 1 },
		{ global: 2, tenant: 1 },
		{ global: 3, tenant: 2 },
		{ global: 12, tenant: 4 },
	])("bounds the default tenant share for a $global slot queue", ({ global, tenant }) => {
		expect(loadIngressOptions({ SQL_FS_MAX_INGRESS_QUEUED_REQUESTS: String(global) })).toMatchObject({
			maxQueuedRequests: global,
			maxTenantQueuedRequests: tenant,
			maxRequests: 8,
			maxTenantRequests: 4,
			waitMs: 250,
		});
	});

	it("allows zero tenant waiting and rejects invalid queue counts or tenant shares", () => {
		expect(loadIngressOptions({ SQL_FS_MAX_INGRESS_TENANT_QUEUED_REQUESTS: "0" }).maxTenantQueuedRequests).toBe(0);
		for (const name of ["SQL_FS_MAX_INGRESS_QUEUED_REQUESTS", "SQL_FS_MAX_INGRESS_TENANT_QUEUED_REQUESTS"]) {
			for (const value of ["-1", "1.5", "NaN", "Infinity", "9007199254740992"]) {
				expect(() => loadIngressOptions({ [name]: value })).toThrow(name);
			}
		}
		for (const [global, tenant] of [
			[0, 1],
			[1, 2],
			[2, 2],
			[3, 3],
		]) {
			expect(() =>
				loadIngressOptions({
					SQL_FS_MAX_INGRESS_QUEUED_REQUESTS: String(global),
					SQL_FS_MAX_INGRESS_TENANT_QUEUED_REQUESTS: String(tenant),
				}),
			).toThrow("SQL_FS_MAX_INGRESS_TENANT_QUEUED_REQUESTS");
		}
	});
});

describe("queued input ownership", () => {
	it("cancels an immediately admitted request when consuming its input observes cancellation", async () => {
		const { app, ingress, dispatched } = setup();
		const abort = new AbortController();
		const body = new ReadableStream<Uint8Array>(
			{
				pull() {
					abort.abort();
				},
			},
			{ highWaterMark: 0 },
		);
		expect((await app.request(request(body, abort.signal))).status).toBe(499);
		expect(dispatched()).toBe(1);
		expect(ingress.metrics).toMatchObject({ activeRequests: 0, queuedRequests: 0, retainedRawBytes: 0, aborted: 1 });
	});

	it("allows immediate admission with zero waiting and refuses excess input unread", async () => {
		const { app, ingress, hold } = setup({ maxQueuedRequests: 0, maxTenantQueuedRequests: 0 });
		const active = app.request("/hold", { method: "POST", body: "held" });
		const rejected = input([1]);
		try {
			await flush();
			const response = await app.request(request(rejected.body));
			expect(response.status).toBe(503);
			expect(rejected.observed).toEqual({ reads: 0, cancelled: true });
			expect(ingress.metrics).toMatchObject({ activeRequests: 1, queuedRequests: 0, queueTimeouts: 0, refused: 1 });
			expect((await consume(app.request("/work", { method: "POST", headers: { "X-Tenant": "b" } }))).status).toBe(200);
		} finally {
			hold.resolve();
			await consume(active);
		}
		expect(ingress.metrics).toMatchObject({ activeRequests: 0, queuedRequests: 0, retainedRawBytes: 0 });
	});

	it("enforces queue counts independently of active counts across HTTP and MCP POST", async () => {
		const { app, ingress, hold } = setup();
		const post = (tenant: string, path: string) =>
			app.request(path, {
				method: "POST",
				headers: { "X-Tenant": tenant },
				body: "data",
			});
		const active = [post("a", "/hold"), post("b", "/hold")];
		const pending: (Response | Promise<Response>)[] = [];
		try {
			await flush();
			pending.push(post("a", "/work"), post("a", "/mcp"));
			await flush();
			expect(ingress.metrics).toMatchObject({ activeRequests: 2, queuedRequests: 2, retainedRawBytes: 16 });
			const tenantExcess = input([1]);
			expect((await app.request(request(tenantExcess.body))).status).toBe(503);
			expect(tenantExcess.observed).toEqual({ reads: 0, cancelled: true });
			pending.push(post("b", "/work"));
			await flush();
			expect(ingress.metrics).toMatchObject({ activeRequests: 2, queuedRequests: 3, retainedRawBytes: 20 });
			const globalExcess = input([1]);
			expect((await app.request(request(globalExcess.body, undefined, "c"))).status).toBe(503);
			expect(globalExcess.observed).toEqual({ reads: 0, cancelled: true });
			expect((await consume(app.request("/mcp"))).status).toBe(200);
			expect(ingress.metrics).toMatchObject({ queuedRequests: 3, refused: 2, queueTimeouts: 0 });
		} finally {
			hold.resolve();
			await Promise.allSettled([...active, ...pending].map(consume));
		}
		expect(ingress.metrics).toMatchObject({ activeRequests: 0, queuedRequests: 0, retainedRawBytes: 0 });
	});

	it.each([
		{ limit: "tenant", maxBytes: 100, maxTenantBytes: 20, maxBodyBytes: 60, chunks: [8, 9], status: 503 },
		{ limit: "global", maxBytes: 20, maxTenantBytes: 75, maxBodyBytes: 60, chunks: [8, 9], status: 503 },
		{ limit: "body", maxBytes: 100, maxTenantBytes: 75, maxBodyBytes: 12, chunks: [8, 5], status: 413 },
	])(
		"removes queued input at the $limit byte limit and preserves the cause during cancellation",
		async ({ chunks, status, ...options }) => {
			const { app, ingress, hold, dispatched } = setup(options);
			const active = app.request("/hold", { method: "POST", body: "held" });
			const abort = new AbortController();
			const incoming = input(chunks, () => abort.abort());
			try {
				await flush();
				const result = await app.request(request(incoming.body, abort.signal));
				expect(result.status).toBe(status);
				expect(await result.json()).toMatchObject({ code: status === 413 ? "PAYLOAD_TOO_LARGE" : "EWORKER_BUSY" });
				expect(incoming.observed.cancelled).toBe(true);
				expect(dispatched()).toBe(0);
				expect(ingress.metrics).toMatchObject({
					activeRequests: 1,
					queuedRequests: 0,
					retainedRawBytes: 4,
					aborted: 0,
					queueTimeouts: 0,
				});
			} finally {
				hold.resolve();
				await consume(active);
			}
			expect(ingress.metrics).toMatchObject({ activeRequests: 0, retainedRawBytes: 0 });
		},
	);

	it("dispatches an admitted request while its queued body is still arriving", async () => {
		const { app, ingress, hold, dispatched } = setup();
		const active = app.request("/hold", { method: "POST", body: "held" });
		const outgoing = deferred<ReadableStreamDefaultController<Uint8Array>>();
		const body = new ReadableStream<Uint8Array>({ start: outgoing.resolve });
		const controller = await outgoing.promise;
		controller.enqueue(new TextEncoder().encode("first"));
		const waiting = app.request(request(body));
		try {
			await flush();
			expect(ingress.metrics).toMatchObject({ activeRequests: 1, queuedRequests: 1, retainedRawBytes: 9 });
			expect(dispatched()).toBe(0);
			hold.resolve();
			await consume(active);
			await flush();
			expect(dispatched()).toBe(1);
			expect(ingress.metrics).toMatchObject({ activeRequests: 1, queuedRequests: 0, retainedRawBytes: 5 });
			controller.enqueue(new TextEncoder().encode("second"));
			controller.close();
			expect(await (await waiting).text()).toBe("firstsecond");
		} finally {
			hold.resolve();
			ingress.close();
		}
		expect(ingress.metrics).toMatchObject({ activeRequests: 0, queuedRequests: 0, retainedRawBytes: 0 });
	});

	it("cancels active work at a body limit while retaining its permit until settlement", async () => {
		const { app, ingress, hold } = setup({ maxBodyBytes: 12 });
		let workSignal: AbortSignal | undefined;
		app.post("/stream", async (c) => {
			workSignal = c.req.raw.signal;
			const reader = c.req.raw.body!.getReader();
			await reader.read();
			await expect(reader.read()).rejects.toMatchObject({ name: "AbortError" });
			await hold.promise;
			return c.text("settled");
		});
		const body = input([8, 5]).body;
		const response = app.request(
			new Request("http://localhost/stream", {
				method: "POST",
				body,
				duplex: "half",
			} as RequestInit),
		);
		try {
			await flush();
			expect(workSignal?.aborted).toBe(true);
			expect(ingress.metrics).toMatchObject({ activeRequests: 1, retainedRawBytes: 8, payloadTooLarge: 1, aborted: 0 });
		} finally {
			hold.resolve();
		}
		expect((await consume(response)).status).toBe(413);
		expect(ingress.metrics).toMatchObject({ activeRequests: 0, retainedRawBytes: 0 });
	});

	it("drops an input read that settles after queued cancellation", async () => {
		const { app, ingress, hold, dispatched } = setup();
		const active = app.request("/hold", { method: "POST", body: "held" });
		const body = new ReadableStream<Uint8Array>();
		const abort = new AbortController();
		const incoming = request(body, abort.signal);
		const reader = body.getReader();
		const late = deferred<Awaited<ReturnType<typeof reader.read>>>();
		vi.spyOn(reader, "read").mockReturnValue(late.promise);
		vi.spyOn(reader, "cancel").mockResolvedValue();
		vi.spyOn(body, "getReader").mockReturnValue(reader);
		const waiting = app.request(incoming);
		try {
			await flush();
			expect(ingress.metrics.queuedRequests).toBe(1);
			abort.abort();
			expect((await waiting).status).toBe(499);
			late.resolve({ done: false, value: new Uint8Array(50) });
			await flush();
			expect(dispatched()).toBe(0);
			expect(ingress.metrics).toMatchObject({ activeRequests: 1, queuedRequests: 0, retainedRawBytes: 4, aborted: 1 });
		} finally {
			hold.resolve();
			await consume(active);
		}
		expect(ingress.metrics).toMatchObject({ activeRequests: 0, queuedRequests: 0, retainedRawBytes: 0 });
	});

	it("removes a client that disconnects after body EOF while still queued", async () => {
		const { app, ingress, hold, dispatched } = setup();
		const active = app.request("/hold", { method: "POST", body: "held" });
		const abort = new AbortController();
		const waiting = app.request("/work", { method: "POST", body: "complete", signal: abort.signal });
		try {
			await flush();
			expect(ingress.metrics).toMatchObject({ activeRequests: 1, queuedRequests: 1, retainedRawBytes: 12 });
			abort.abort();
			expect((await waiting).status).toBe(499);
			expect(dispatched()).toBe(0);
			expect(ingress.metrics).toMatchObject({ activeRequests: 1, queuedRequests: 0, retainedRawBytes: 4, aborted: 1 });
		} finally {
			hold.resolve();
			await consume(active);
		}
		expect(ingress.metrics).toMatchObject({ activeRequests: 0, queuedRequests: 0, retainedRawBytes: 0 });
	});

	it("discards unread counted chunks when the response completes", async () => {
		const { app, ingress, hold } = setup();
		let retainedRequest: Request | undefined;
		app.post("/ignore", async (c) => {
			retainedRequest = c.req.raw;
			await flush();
			return c.text("ignored");
		});
		const active = app.request("/hold", { method: "POST", body: "held" });
		await flush();
		const ignored = app.request("/ignore", { method: "POST", body: "unconsumed" });
		try {
			await flush();
			expect(ingress.metrics).toMatchObject({ activeRequests: 1, queuedRequests: 1, retainedRawBytes: 14 });
		} finally {
			hold.resolve();
			await consume(active);
			await consume(ignored);
		}
		expect(ingress.metrics).toMatchObject({ activeRequests: 0, retainedRawBytes: 0 });
		expect(retainedRequest).toBeDefined();
		await expect(retainedRequest?.text()).rejects.toMatchObject({ name: "AbortError" });
	});

	it("releases a queued permit granted in the same turn as cancellation", async () => {
		const { app, ingress, dispatched } = setup();
		app.get("/events", () => new Response(new ReadableStream()));
		const active = await app.request("/events");
		const abort = new AbortController();
		const waiting = app.request(request(input([5]).body, abort.signal));
		await flush();
		expect(ingress.metrics).toMatchObject({ activeRequests: 1, queuedRequests: 1, retainedRawBytes: 5 });
		const cancelled = active.body!.cancel();
		abort.abort();
		await cancelled;
		expect((await waiting).status).toBe(499);
		expect(dispatched()).toBe(0);
		expect(ingress.metrics).toMatchObject({ activeRequests: 0, queuedRequests: 0, retainedRawBytes: 0, aborted: 1 });
		expect((await consume(app.request("/work", { method: "POST", body: "next" }))).status).toBe(200);
	});
});

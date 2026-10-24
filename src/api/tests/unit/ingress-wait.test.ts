import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthVariables } from "../../auth.js";
import { IngressAdmission, loadIngressOptions, retainIngressWork } from "../../ingress-admission.js";

function deferred() {
	let resolve: () => void = () => {};
	const promise = new Promise<void>((release) => {
		resolve = release;
	});
	return { promise, resolve };
}

function setup(maxRequests = 8, maxTenantRequests = 4, env: NodeJS.ProcessEnv = {}) {
	const ingress = new IngressAdmission(
		loadIngressOptions({
			SQL_FS_MAX_INGRESS_REQUESTS: String(maxRequests),
			SQL_FS_MAX_INGRESS_TENANT_REQUESTS: String(maxTenantRequests),
			...env,
		}),
	);
	const app = new Hono<{ Variables: AuthVariables }>();
	app.onError((_error, c) => c.text("failed", 500));
	app.use("*", (c, next) => {
		if (c.req.path.startsWith("/bootstrap/")) return ingress.bootstrapMiddleware(c, next);
		c.set("tenant", c.req.header("X-Tenant") ?? "observer");
		return c.req.path.startsWith("/mcp") ? ingress.mcpMiddleware(c, next) : ingress.middleware(c, next);
	});
	app.post("/work", async (c) => c.text(await c.req.text()));
	return { ingress, app };
}

function unreadBody(complete = true) {
	const observed = { reads: 0, cancelled: false };
	const body = new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				observed.reads++;
				controller.enqueue(new TextEncoder().encode("delayed"));
				if (complete) controller.close();
				else return new Promise<void>(() => {});
			},
			cancel() {
				observed.cancelled = true;
			},
		},
		{ highWaterMark: 0 },
	);
	return { body, observed };
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
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("bounded ingress wait", () => {
	it("reads a queued fifth observer body without exceeding active quotas", async () => {
		const { app, ingress } = setup();
		const hold = deferred();
		let peakActive = 0;
		app.post("/hold", async (c) => {
			await c.req.text();
			peakActive = Math.max(peakActive, ingress.metrics.activeRequests);
			await hold.promise;
			return c.text("held");
		});
		const active = Array.from({ length: 4 }, () => app.request("/hold", { method: "POST", body: "held" }));
		active.push(app.request("/hold", { method: "POST", headers: { "X-Tenant": "aggressor" }, body: "held" }));
		const input = unreadBody();
		let delayed: Promise<Response> | undefined;
		try {
			await flush();
			expect(ingress.metrics).toMatchObject({ activeRequests: 5, retainedRawBytes: 20 });
			delayed = Promise.resolve(
				app.request(
					new Request("http://localhost/work", { method: "POST", body: input.body, duplex: "half" } as RequestInit),
				),
			);
			await flush();
			expect(ingress.metrics).toMatchObject({ activeRequests: 5, queuedRequests: 1, retainedRawBytes: 27, refused: 0 });
			expect(input.observed.reads).toBe(1);
			hold.resolve();
			await Promise.all(active.map(consume));
			await flush();
			expect((await delayed).status).toBe(200);
			expect(await (await delayed).text()).toBe("delayed");
			expect(input.observed.reads).toBe(1);
			expect(peakActive).toBe(5);
		} finally {
			hold.resolve();
			await Promise.allSettled([...active, ...(delayed ? [delayed] : [])].map(consume));
		}
		expect(ingress.metrics).toMatchObject({ activeRequests: 0, queuedRequests: 0, retainedRawBytes: 0, refused: 0 });
	});

	it("bounds pending requests globally and per tenant without reading refused bodies", async () => {
		const { app, ingress } = setup(2, 1);
		const hold = deferred();
		app.post("/hold", async (c) => {
			await c.req.text();
			await hold.promise;
			return c.text("held");
		});
		const request = (tenant: string, path = "/work") =>
			app.request(path, { method: "POST", headers: { "X-Tenant": tenant }, body: "held" });
		const active = [request("a", "/hold"), request("b", "/hold")];
		const waiting: (Response | Promise<Response>)[] = [];
		try {
			await flush();
			waiting.push(request("a"));
			await flush();
			expect(ingress.metrics).toMatchObject({ activeRequests: 2, queuedRequests: 1, retainedRawBytes: 12 });
			const tenantInput = unreadBody();
			const tenantResponse = await app.request(
				new Request("http://localhost/work", {
					method: "POST",
					headers: { "X-Tenant": "a" },
					body: tenantInput.body,
					duplex: "half",
				} as RequestInit),
			);
			expect(tenantResponse.status).toBe(503);
			expect(tenantResponse.headers.get("Retry-After")).toBe("1");
			expect(tenantInput.observed).toEqual({ reads: 0, cancelled: true });
			expect(ingress.metrics).toMatchObject({ activeRequests: 2, queuedRequests: 1, refused: 1, queueTimeouts: 0 });
			waiting.push(request("b"));
			await flush();
			expect(ingress.metrics).toMatchObject({ activeRequests: 2, queuedRequests: 2, retainedRawBytes: 16 });
			for (const tenant of ["a", "c"]) {
				const input = unreadBody();
				const response = await app.request(
					new Request("http://localhost/work", {
						method: "POST",
						headers: { "X-Tenant": tenant },
						body: input.body,
						duplex: "half",
					} as RequestInit),
				);
				expect(response.status).toBe(503);
				expect(response.headers.get("Retry-After")).toBe("1");
				expect(input.observed).toEqual({ reads: 0, cancelled: true });
			}
			expect(ingress.metrics).toMatchObject({ activeRequests: 2, queuedRequests: 2, refused: 3, queueTimeouts: 0 });
		} finally {
			hold.resolve();
			await Promise.allSettled([...active, ...waiting].map(consume));
		}
		expect(ingress.metrics).toMatchObject({ activeRequests: 0, queuedRequests: 0, retainedRawBytes: 0 });
	});

	it("times out a partially read queued body after 250ms with retry guidance and no dispatch", async () => {
		const { app, ingress } = setup(2, 1);
		const hold = deferred();
		app.post("/hold", async (c) => {
			await c.req.text();
			await hold.promise;
			return c.text("held");
		});
		const active = app.request("/hold", { method: "POST", body: "held" });
		const input = unreadBody(false);
		let waiting: Promise<Response> | undefined;
		try {
			await flush();
			waiting = Promise.resolve(
				app.request(
					new Request("http://localhost/work", { method: "POST", body: input.body, duplex: "half" } as RequestInit),
				),
			);
			await flush();
			await vi.advanceTimersByTimeAsync(249);
			expect(ingress.metrics).toMatchObject({ activeRequests: 1, queuedRequests: 1, retainedRawBytes: 11, refused: 0 });
			expect(input.observed.reads).toBe(1);
			await vi.advanceTimersByTimeAsync(1);
			const response = await waiting;
			expect(response.status).toBe(503);
			expect(response.headers.get("Retry-After")).toBe("1");
			expect(await response.json()).toEqual({
				code: "EWORKER_BUSY",
				error: "Request capacity is busy",
				retryable: true,
			});
			expect(input.observed).toEqual({ reads: 1, cancelled: true });
			expect(ingress.metrics).toMatchObject({ activeRequests: 1, queuedRequests: 0, queueTimeouts: 1, refused: 1 });
		} finally {
			hold.resolve();
			await Promise.allSettled([active, ...(waiting ? [waiting] : [])].map(consume));
		}
	});

	it.each([
		{ gate: "request", method: "POST", path: "/hold" },
		{ gate: "MCP listener", method: "GET", path: "/mcp/listen" },
	])("refuses a queued $gate only after SQL_FS_MAX_INGRESS_WAIT_MS", async ({ method, path }) => {
		const { app, ingress } = setup(2, 1, { SQL_FS_MAX_INGRESS_WAIT_MS: "40" });
		const hold = deferred();
		app.on(["GET", "POST"], path, async (c) => {
			await hold.promise;
			return c.text("held");
		});
		const active = app.request(path, { method });
		let waiting: Promise<Response> | undefined;
		try {
			await flush();
			waiting = Promise.resolve(app.request(path, { method }));
			await flush();
			await vi.advanceTimersByTimeAsync(39);
			const gate = () =>
				method === "GET"
					? { queued: ingress.metrics.queuedMcpListeners, timeouts: ingress.metrics.mcpListenerQueueTimeouts }
					: { queued: ingress.metrics.queuedRequests, timeouts: ingress.metrics.queueTimeouts };
			expect(gate()).toEqual({ queued: 1, timeouts: 0 });
			await vi.advanceTimersByTimeAsync(1);
			expect(gate()).toEqual({ queued: 0, timeouts: 1 });
			const response = await waiting;
			expect(response.status).toBe(503);
			expect(response.headers.get("Retry-After")).toBe("1");
			expect(await response.json()).toMatchObject({ code: "EWORKER_BUSY", retryable: true });
		} finally {
			hold.resolve();
			await Promise.allSettled([active, ...(waiting ? [waiting] : [])].map(consume));
		}
	});

	it("cancels a queued body and reuses its pending slot", async () => {
		const { app, ingress } = setup(2, 1);
		const hold = deferred();
		app.post("/hold", async (c) => {
			await c.req.text();
			await hold.promise;
			return c.text("held");
		});
		const active = app.request("/hold", { method: "POST", body: "held" });
		const abort = new AbortController();
		const input = unreadBody(false);
		const pending: (Response | Promise<Response>)[] = [];
		try {
			await flush();
			const waiting = app.request(
				new Request("http://localhost/work", {
					method: "POST",
					body: input.body,
					signal: abort.signal,
					duplex: "half",
				} as RequestInit),
			);
			pending.push(waiting);
			await flush();
			expect(ingress.metrics).toMatchObject({ queuedRequests: 1, retainedRawBytes: 11 });
			abort.abort();
			await flush();
			expect((await waiting).status).toBe(499);
			expect(input.observed).toEqual({ reads: 1, cancelled: true });
			expect(ingress.metrics).toMatchObject({ activeRequests: 1, queuedRequests: 0, aborted: 1 });
			const replacement = app.request("/work", { method: "POST", body: "replacement" });
			pending.push(replacement);
			await flush();
			expect(ingress.metrics.queuedRequests).toBe(1);
			hold.resolve();
			await consume(active);
			await flush();
			expect((await consume(replacement)).status).toBe(200);
		} finally {
			abort.abort();
			hold.resolve();
			await Promise.allSettled([active, ...pending].map(consume));
		}
		expect(ingress.metrics).toMatchObject({ activeRequests: 0, queuedRequests: 0, retainedRawBytes: 0 });
	});

	it("rechecks cancellation after an immediate reservation before dispatch or reading", async () => {
		const { app, ingress } = setup(2, 1);
		const abort = new AbortController();
		const input = unreadBody();
		const response = app.request(
			new Request("http://localhost/work", {
				method: "POST",
				body: input.body,
				signal: abort.signal,
				duplex: "half",
			} as RequestInit),
		);
		abort.abort();
		await flush();
		expect((await response).status).toBe(499);
		expect(input.observed).toEqual({ reads: 0, cancelled: true });
		expect(ingress.metrics).toMatchObject({ activeRequests: 0, queuedRequests: 0, aborted: 1, retainedRawBytes: 0 });
	});

	it("lets another tenant proceed while a saturated tenant is waiting", async () => {
		const { app, ingress } = setup(2, 1);
		const hold = deferred();
		app.post("/hold", async (c) => {
			await c.req.text();
			await hold.promise;
			return c.text("held");
		});
		const active = app.request("/hold", { method: "POST", body: "held" });
		const pending: (Response | Promise<Response>)[] = [];
		try {
			await flush();
			pending.push(app.request("/work", { method: "POST", body: "queued" }));
			await flush();
			const other = await app.request("/work", {
				method: "POST",
				headers: { "X-Tenant": "other" },
				body: "independent",
			});
			expect(other.status).toBe(200);
			expect(await other.text()).toBe("independent");
			expect(ingress.metrics).toMatchObject({ activeRequests: 1, queuedRequests: 1, retainedRawBytes: 10 });
		} finally {
			hold.resolve();
			await Promise.allSettled([active, ...pending].map(consume));
		}
	});

	it("keeps bootstrap reservations separate from a real tenant named bootstrap", async () => {
		const { app, ingress } = setup(2, 1);
		const hold = deferred();
		app.post("/bootstrap/hold", async (c) => {
			await c.req.text();
			await hold.promise;
			return c.text("held");
		});
		const active = app.request("/bootstrap/hold", { method: "POST", body: "held" });
		try {
			await flush();
			const tenant = await app.request("/work", {
				method: "POST",
				headers: { "X-Tenant": "bootstrap" },
				body: "separate",
			});
			expect(tenant.status).toBe(200);
			expect(await tenant.text()).toBe("separate");
			expect(ingress.metrics).toMatchObject({ activeRequests: 1, queuedRequests: 0 });
		} finally {
			hold.resolve();
			await consume(active);
		}
	});

	it("retains capacity after the handler returns until retained work settles", async () => {
		const { app, ingress } = setup(2, 1);
		const hold = deferred();
		let work: Promise<void> | undefined;
		app.post("/retained", async (c) => {
			await c.req.text();
			work = retainIngressWork(() => hold.promise)();
			return c.text("returned");
		});
		const pending: (Response | Promise<Response>)[] = [];
		try {
			expect((await consume(app.request("/retained", { method: "POST", body: "held" }))).status).toBe(200);
			const waiting = app.request("/work", { method: "POST", body: "queued" });
			pending.push(waiting);
			await flush();
			expect(ingress.metrics).toMatchObject({ activeRequests: 1, queuedRequests: 1, retainedRawBytes: 10 });
			hold.resolve();
			await flush();
			expect((await consume(waiting)).status).toBe(200);
		} finally {
			hold.resolve();
			await work;
			await Promise.allSettled(pending.map(consume));
		}
		expect(ingress.metrics).toMatchObject({ activeRequests: 0, queuedRequests: 0, retainedRawBytes: 0 });
	});

	it("counts a queued body while an SSE response retains capacity", async () => {
		const { app, ingress } = setup(2, 1);
		app.post("/events", () => new Response(new ReadableStream(), { headers: { "Content-Type": "text/event-stream" } }));
		const response = await app.request("/events", { method: "POST", body: "held" });
		const input = unreadBody();
		const waiting = app.request(
			new Request("http://localhost/work", { method: "POST", body: input.body, duplex: "half" } as RequestInit),
		);
		try {
			await flush();
			expect(ingress.metrics).toMatchObject({ activeRequests: 1, queuedRequests: 1 });
			expect(input.observed.reads).toBe(1);
			await response.body!.cancel();
			await flush();
			expect((await consume(waiting)).status).toBe(200);
		} finally {
			await response.body?.cancel();
			await consume(waiting);
		}
		expect(ingress.metrics).toMatchObject({ activeRequests: 0, queuedRequests: 0, retainedRawBytes: 0 });
	});

	it("releases an acquired reservation when the input reader cannot be constructed", async () => {
		const { app, ingress } = setup(2, 1);
		const request = new Request("http://localhost/work", { method: "POST", body: "held" });
		const locked = request.body!.getReader();
		try {
			expect((await consume(app.request(request))).status).toBe(500);
		} finally {
			locked.releaseLock();
		}
		expect(ingress.metrics).toMatchObject({ activeRequests: 0, queuedRequests: 0, retainedRawBytes: 0 });
		expect((await consume(app.request("/work", { method: "POST", body: "reusable" }))).status).toBe(200);
	});

	it("releases an acquired reservation when counted stream construction fails", async () => {
		const { app, ingress } = setup(2, 1);
		const request = new Request("http://localhost/work", { method: "POST", body: "held" });
		let constructions = 0;
		vi.stubGlobal(
			"ReadableStream",
			new Proxy(ReadableStream, {
				construct(target, args, newTarget) {
					if (++constructions === 1) throw new Error("counted stream failed");
					return Reflect.construct(target, args, newTarget);
				},
			}),
		);
		expect((await consume(app.request(request))).status).toBe(500);
		vi.unstubAllGlobals();
		expect(ingress.metrics).toMatchObject({ activeRequests: 0, queuedRequests: 0, retainedRawBytes: 0 });
		expect((await consume(app.request("/work", { method: "POST", body: "reusable" }))).status).toBe(200);
	});

	it("closes pending admissions and releases their bytes while preserving active retention", async () => {
		const { app, ingress } = setup(2, 1);
		const hold = deferred();
		app.post("/hold", async (c) => {
			await c.req.text();
			await hold.promise;
			return c.text("held");
		});
		const active = app.request("/hold", { method: "POST", body: "held" });
		const input = unreadBody(false);
		let pending: Response | Promise<Response> | undefined;
		try {
			await flush();
			pending = app.request(
				new Request("http://localhost/work", { method: "POST", body: input.body, duplex: "half" } as RequestInit),
			);
			await flush();
			expect(ingress.metrics).toMatchObject({ queuedRequests: 1, retainedRawBytes: 11 });
			ingress.close();
			ingress.close();
			await flush();
			const response = await pending;
			expect(response.status).toBe(503);
			expect(response.headers.get("Retry-After")).toBe("1");
			expect(await response.json()).toMatchObject({ code: "ESHUTTINGDOWN", retryable: true });
			expect(input.observed).toEqual({ reads: 1, cancelled: true });
			expect(ingress.metrics).toMatchObject({ activeRequests: 1, queuedRequests: 0, retainedRawBytes: 4 });
			expect((await consume(app.request("/work", { method: "POST", body: "rejected" }))).status).toBe(503);
		} finally {
			hold.resolve();
			await Promise.allSettled([active, ...(pending ? [pending] : [])].map(consume));
		}
		expect(ingress.metrics).toMatchObject({ activeRequests: 0, queuedRequests: 0, retainedRawBytes: 0 });
	});
});

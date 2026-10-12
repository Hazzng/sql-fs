import { Hono } from "hono";
import { SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AuthVariables, createAuthMiddleware } from "../../auth.js";
import { IngressAdmission, loadIngressOptions, retainIngressWork } from "../../ingress-admission.js";

const secret = "tenant-bytes-test-secret-32-characters";
const headers = async (tenant: string) => ({
	Authorization: `Bearer ${await new SignJWT({ sub: "owner", tenant }).setProtectedHeader({ alg: "HS256" }).sign(new TextEncoder().encode(secret))}`,
});
function setup() {
	vi.stubEnv("AUTH_SECRET", secret);
	const ingress = new IngressAdmission(
		loadIngressOptions({ SQL_FS_MAX_INGRESS_BYTES: "128", SQL_FS_MAX_INGRESS_TENANT_BYTES: "64" }),
	);
	const app = new Hono<{ Variables: AuthVariables }>();
	app.onError((_error, c) => c.text("body rejected", 400));
	app.use(
		"*",
		createAuthMiddleware({
			tenantIds: ["a", "b", "c", "d", "e"],
			hasTenant: (id) => ["a", "b", "c", "d", "e"].includes(id),
			getConnectionString: () => "postgres://unused/test",
		}),
	);
	app.use("*", ingress.middleware);
	let applied = 0;
	app.post("/hold", async (c) => {
		await c.req.text();
		applied++;
		return new Response(new ReadableStream(), { headers: { "Content-Type": "text/event-stream" } });
	});
	app.post("/finish", async (c) => c.text(await c.req.text()));
	return { app, ingress, applied: () => applied };
}
function chunked(size: number) {
	return new ReadableStream<Uint8Array>({
		start(output) {
			output.enqueue(new Uint8Array(size));
			output.close();
		},
	});
}
function post(
	app: ReturnType<typeof setup>["app"],
	path: string,
	auth: Record<string, string>,
	size: number,
	signal?: AbortSignal,
) {
	return app.request(
		new Request(`http://localhost${path}`, {
			method: "POST",
			headers: auth,
			body: chunked(size),
			signal,
			duplex: "half",
		} as RequestInit),
	);
}
async function consume(response: Response | Promise<Response>) {
	const result = await response;
	await result.arrayBuffer();
	return result;
}

afterEach(() => vi.unstubAllEnvs());

describe("tenant raw byte admission", () => {
	it("validates a finite tenant byte budget smaller than the global budget", () => {
		expect(loadIngressOptions({ SQL_FS_MAX_INGRESS_BYTES: "1" }).maxTenantBytes).toBe(1);
		expect(loadIngressOptions({ SQL_FS_MAX_INGRESS_BYTES: "192" }).maxTenantBytes).toBe(144);
		for (const value of ["0", "-1", "1.5", "NaN", "Infinity", "9007199254740992", "128", "129"]) {
			expect(() =>
				loadIngressOptions({ SQL_FS_MAX_INGRESS_BYTES: "128", SQL_FS_MAX_INGRESS_TENANT_BYTES: value }),
			).toThrow("SQL_FS_MAX_INGRESS_TENANT_BYTES");
		}
		expect(() => loadIngressOptions({ SQL_FS_MAX_INGRESS_BYTES: "1", SQL_FS_MAX_INGRESS_TENANT_BYTES: "2" })).toThrow();
	});

	it("keeps a base64 encoded 50 MiB file within the default finite tenant limit", () => {
		const options = loadIngressOptions({});
		expect(options.maxBytes).toBe(128 * 1024 * 1024);
		expect(options.maxTenantBytes).toBe(96 * 1024 * 1024);
		const encodedBytes = 4 * Math.ceil((50 * 1024 * 1024) / 3);
		const envelopeBytes = Buffer.byteLength(JSON.stringify({ basePath: "/", files: { file: "" } }));
		expect(encodedBytes + envelopeBytes).toBeLessThan(options.maxTenantBytes);
		expect(options.maxBytes - options.maxTenantBytes).toBe(32 * 1024 * 1024);
	});

	it("rejects an oversized declared body with its effective limit without reading it", async () => {
		const { app, ingress, applied } = setup();
		let reads = 0;
		const body = new ReadableStream<Uint8Array>(
			{
				pull(output) {
					reads++;
					output.enqueue(new Uint8Array(65));
				},
			},
			{ highWaterMark: 0 },
		);
		const response = await app.request(
			new Request("http://localhost/hold", {
				method: "POST",
				headers: { ...(await headers("a")), "Content-Length": "65" },
				body,
				duplex: "half",
			} as RequestInit),
		);
		expect(response.status).toBe(413);
		expect(await response.json()).toEqual({
			code: "PAYLOAD_TOO_LARGE",
			retryable: false,
			error: "payload_too_large",
			details: ["Request body exceeds limit (64 bytes)"],
		});
		expect(response.headers.get("Retry-After")).toBeNull();
		expect(reads).toBe(0);
		expect(applied()).toBe(0);
		expect(ingress.metrics).toMatchObject({ retainedRawBytes: 0, activeRequests: 0, refused: 0, payloadTooLarge: 1 });
	});

	it("reserves byte headroom for B while A holds its ceiling after body EOF", async () => {
		const { app, ingress, applied } = setup();
		const a = await headers("a");
		const responses: Response[] = [];
		try {
			responses.push(await post(app, "/hold", a, 64));
			const excess = await post(app, "/hold", a, 64);
			responses.push(excess);
			const other = await consume(post(app, "/finish", await headers("b"), 1));
			expect([excess.status, other.status]).toEqual([503, 200]);
			expect(excess.headers.get("Retry-After")).toBe("1");
			expect(await excess.json()).toMatchObject({ code: "EWORKER_BUSY", retryable: true });
			expect(applied()).toBe(1);
			expect(ingress.metrics).toMatchObject({ retainedRawBytes: 64, activeRequests: 1 });
		} finally {
			await Promise.all(responses.map((response) => (response.bodyUsed ? undefined : response.body?.cancel())));
		}
		expect(ingress.metrics).toMatchObject({ retainedRawBytes: 0, activeRequests: 0, queuedRequests: 0 });
		expect(Reflect.get(ingress, "tenantBytes")).toEqual(new Map());
		expect((await consume(post(app, "/finish", a, 64))).status).toBe(200);
	});

	it("rejects a crossing chunk before applying a partially read body", async () => {
		const { app, ingress, applied } = setup();
		const body = new ReadableStream<Uint8Array>({
			start(output) {
				output.enqueue(new Uint8Array(32));
				output.enqueue(new Uint8Array(33));
				output.close();
			},
		});
		const response = await app.request(
			new Request("http://localhost/hold", {
				method: "POST",
				headers: await headers("a"),
				body,
				duplex: "half",
			} as RequestInit),
		);
		expect(response.status).toBe(413);
		expect(await response.json()).toMatchObject({
			code: "PAYLOAD_TOO_LARGE",
			retryable: false,
			details: ["Request body exceeds limit (64 bytes)"],
		});
		expect(applied()).toBe(0);
		expect(ingress.metrics).toMatchObject({ retainedRawBytes: 0, activeRequests: 0, queuedRequests: 0 });
		expect(Reflect.get(ingress, "tenantBytes")).toEqual(new Map());
		expect((await consume(post(app, "/finish", await headers("a"), 64))).status).toBe(200);
	});

	it("still enforces global bytes across distinct tenants", async () => {
		const { app, ingress } = setup();
		const responses: Response[] = [];
		try {
			for (const tenant of ["a", "b", "c", "d"]) responses.push(await post(app, "/hold", await headers(tenant), 32));
			expect(ingress.metrics.retainedRawBytes).toBe(128);
			expect((await consume(post(app, "/finish", await headers("e"), 1))).status).toBe(503);
			await responses.pop()!.body!.cancel();
			expect((await consume(post(app, "/finish", await headers("e"), 1))).status).toBe(200);
		} finally {
			await Promise.all(responses.map((response) => response.body!.cancel()));
		}
		expect(ingress.metrics).toMatchObject({ retainedRawBytes: 0, activeRequests: 0, queuedRequests: 0 });
		expect(Reflect.get(ingress, "tenantBytes")).toEqual(new Map());
	});

	it("retains tenant bytes for asynchronous work after failure and releases them once", async () => {
		const { app, ingress } = setup();
		let release!: () => void;
		const hold = new Promise<void>((r) => {
			release = r;
		});
		let work: Promise<void> | undefined;
		app.post("/async", async (c) => {
			await c.req.text();
			work = retainIngressWork(() => hold)();
			throw new Error("failure");
		});
		const a = await headers("a");
		try {
			expect((await consume(post(app, "/async", a, 64))).status).toBe(400);
			expect((await consume(post(app, "/finish", a, 1))).status).toBe(503);
			expect((await consume(post(app, "/finish", await headers("b"), 1))).status).toBe(200);
			expect(ingress.metrics.retainedRawBytes).toBe(64);
		} finally {
			release();
			await work;
		}
		expect((await consume(post(app, "/finish", a, 64))).status).toBe(200);
		expect(ingress.metrics).toMatchObject({ retainedRawBytes: 0, activeRequests: 0, queuedRequests: 0 });
		expect(Reflect.get(ingress, "tenantBytes")).toEqual(new Map());
	});

	it("releases aborted streams and allows the same tenant to reuse its byte budget", async () => {
		const { app, ingress } = setup();
		const abort = new AbortController();
		const a = await headers("a");
		const body = new ReadableStream<Uint8Array>({
			start(output) {
				output.enqueue(new Uint8Array(64));
			},
		});
		const pending = app.request(
			new Request("http://localhost/finish", {
				method: "POST",
				headers: a,
				body,
				signal: abort.signal,
				duplex: "half",
			} as RequestInit),
		);
		try {
			await expect.poll(() => ingress.metrics.retainedRawBytes).toBe(64);
			expect((await consume(post(app, "/finish", a, 1))).status).toBe(503);
		} finally {
			abort.abort();
			await pending;
		}
		expect(ingress.metrics).toMatchObject({ retainedRawBytes: 0, activeRequests: 0, queuedRequests: 0 });
		expect(Reflect.get(ingress, "tenantBytes")).toEqual(new Map());
		expect((await consume(post(app, "/finish", a, 64))).status).toBe(200);
	});
});

import { Hono } from "hono";
import { InMemoryFs } from "just-bash";
import { describe, expect, it, vi } from "vitest";
import type { AuthVariables } from "../../auth.js";
import { IngressAdmission } from "../../ingress-admission.js";
import { fileRoutes } from "../../routes/files.js";
import { SessionManager } from "../../session-manager.js";

function deferred() {
	let resolve: () => void = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function setup() {
	const ingress = new IngressAdmission({
		maxRequests: 2,
		maxTenantRequests: 1,
		maxBytes: 10,
		maxTenantBytes: 9,
		maxBodyBytes: 20,
		waitMs: 250,
	});
	const app = new Hono<{ Variables: AuthVariables }>();
	app.use("*", (c, next) => {
		c.set("tenant", c.req.header("X-Tenant") ?? "a");
		c.set("owner", "owner");
		return ingress.middleware(c, next);
	});
	app.post("/holder", async (c) => {
		await c.req.text();
		return c.body(new ReadableStream());
	});
	app.get("/blocker", (c) => c.body(new ReadableStream()));
	return { app, ingress };
}

describe("body-ignoring mutation outcomes", () => {
	it.each(["immediate", "queued"] as const)(
		"preserves an unknown outcome after %s admission when unused body bytes arrive",
		async (admission) => {
			const { app, ingress } = setup();
			const mutated = deferred();
			const finish = deferred();
			let mutations = 0;
			app.delete("/outcome", async (c) => {
				mutations++;
				mutated.resolve();
				await finish.promise;
				return c.json({ code: "EEXEC_OUTCOME_UNKNOWN", error: "Worker reply lost", retryable: false }, 503);
			});
			const holder = await app.request("/holder", {
				method: "POST",
				headers: { "X-Tenant": "b" },
				body: "12345678",
			});
			const blocker = admission === "queued" ? await app.request("/blocker") : undefined;
			const reading = deferred();
			let source!: ReadableStreamDefaultController<Uint8Array>;
			let cancelled = false;
			let reads = 0;
			const body = new ReadableStream<Uint8Array>(
				{
					start(controller) {
						source = controller;
					},
					pull() {
						reads++;
						reading.resolve();
					},
					cancel() {
						cancelled = true;
					},
				},
				{ highWaterMark: 0 },
			);
			const response = app.request(
				new Request("http://localhost/outcome", { method: "DELETE", body, duplex: "half" } as RequestInit),
			);
			try {
				if (blocker !== undefined) {
					await reading.promise;
					expect(ingress.metrics.queuedRequests).toBe(1);
					await blocker.body?.cancel();
				}
				await mutated.promise;
				expect(reads).toBe(admission === "queued" ? 1 : 0);
				source.enqueue(new Uint8Array(3));
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(reads).toBe(admission === "queued" ? 1 : 0);
				expect(ingress.metrics).toMatchObject({ retainedRawBytes: 8, refused: 0 });
				finish.resolve();
				const result = await response;
				expect(result.status).toBe(503);
				expect(await result.json()).toEqual({
					code: "EEXEC_OUTCOME_UNKNOWN",
					error: "Worker reply lost",
					retryable: false,
				});
				expect(result.headers.get("Retry-After")).toBeNull();
				expect(mutations).toBe(1);
				expect(cancelled).toBe(true);
				expect(ingress.metrics).toMatchObject({ activeRequests: 1, retainedRawBytes: 8, refused: 0, aborted: 0 });
			} finally {
				finish.resolve();
				await holder.body?.cancel();
				await blocker?.body?.cancel();
				const result = await response;
				if (!result.bodyUsed) await result.body?.cancel();
			}
			expect(ingress.metrics).toMatchObject({ activeRequests: 0, queuedRequests: 0, retainedRawBytes: 0 });
		},
	);

	it.each(["immediate", "queued"] as const)(
		"preserves the real file DELETE's 204 after %s admission when unused body bytes arrive",
		async (admission) => {
			const { app, ingress } = setup();
			const fs = new InMemoryFs();
			const manager = new SessionManager({ createFs: async () => fs });
			await manager.getOrCreate("a", "delete-outcome", undefined, "owner");
			await fs.writeFile("/target", "present");
			const mutated = deferred();
			const finish = deferred();
			const remove = fs.rm.bind(fs);
			vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
				await remove(...args);
				mutated.resolve();
				await finish.promise;
			});
			app.route("/v1/sandboxes", fileRoutes(manager));
			const holder = await app.request("/holder", {
				method: "POST",
				headers: { "X-Tenant": "b" },
				body: "12345678",
			});
			const blocker = admission === "queued" ? await app.request("/blocker") : undefined;
			const reading = deferred();
			let source!: ReadableStreamDefaultController<Uint8Array>;
			const body = new ReadableStream<Uint8Array>(
				{
					start(controller) {
						source = controller;
					},
					pull: reading.resolve,
				},
				{ highWaterMark: 0 },
			);
			const response = app.request(
				new Request("http://localhost/v1/sandboxes/delete-outcome/files/target", {
					method: "DELETE",
					body,
					duplex: "half",
				} as RequestInit),
			);
			try {
				if (blocker !== undefined) {
					await reading.promise;
					expect(ingress.metrics.queuedRequests).toBe(1);
					await blocker.body?.cancel();
				}
				await mutated.promise;
				expect(await fs.exists("/target")).toBe(false);
				source.enqueue(new Uint8Array(3));
				await new Promise<void>((resolve) => setImmediate(resolve));
				finish.resolve();
				const result = await response;
				expect(result.status).toBe(204);
				expect(result.headers.get("Retry-After")).toBeNull();
				expect(ingress.metrics).toMatchObject({ activeRequests: 1, retainedRawBytes: 8, refused: 0, aborted: 0 });
			} finally {
				finish.resolve();
				await holder.body?.cancel();
				await blocker?.body?.cancel();
				await (await response).body?.cancel();
				vi.restoreAllMocks();
				await manager.destroy("a", "delete-outcome");
				await manager.shutdown();
			}
			expect(ingress.metrics).toMatchObject({ activeRequests: 0, queuedRequests: 0, retainedRawBytes: 0 });
		},
	);
});

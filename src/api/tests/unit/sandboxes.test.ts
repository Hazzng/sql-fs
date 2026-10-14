/**
 * Unit tests for sandbox CRUD routes (US-059, US-060)
 */

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { SignJWT } from "jose";
import type { IFileSystem } from "just-bash";
import { InMemoryFs } from "just-bash";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxMeta } from "../../../sql-fs/types.js";
import { type AuthVariables, authMiddleware } from "../../auth.js";
import { IngressAdmission } from "../../ingress-admission.js";
import { sandboxRoutes } from "../../routes/sandboxes.js";
import { SessionManager } from "../../session-manager.js";
import { FairAdmission } from "../../worker-owner/admission.js";
import { workerRequestContext } from "../../worker-owner/request-context.js";

const AUTH_SECRET = "test-secret-for-sandbox-tests-at-least-32b";
const secretBytes = new TextEncoder().encode(AUTH_SECRET);

async function makeToken(sub = "agent-1"): Promise<string> {
	return new SignJWT({ sub }).setProtectedHeader({ alg: "HS256" }).sign(secretBytes);
}

function makeTestEnv(): { sessionManager: SessionManager; fs: IFileSystem } {
	const fs = new InMemoryFs();
	const sessionManager = new SessionManager({
		createFs: async () => fs,
	});
	return { sessionManager, fs };
}

function makeTestApp(sessionManager: SessionManager) {
	const app = new Hono<{ Variables: AuthVariables }>();
	app.use("/v1/*", authMiddleware);
	app.route("/v1/sandboxes", sandboxRoutes(sessionManager));
	return app;
}

describe("POST /v1/sandboxes", () => {
	beforeEach(() => {
		process.env.AUTH_SECRET = AUTH_SECRET;
	});

	afterEach(() => {
		process.env.AUTH_SECRET = "";
	});

	it("create sandbox returns 201 with id, owner, createdAt", async () => {
		const { sessionManager } = makeTestEnv();
		const app = makeTestApp(sessionManager);
		const token = await makeToken("owner-1");

		const res = await app.request("/v1/sandboxes", {
			method: "POST",
			headers: { Authorization: `Bearer ${token}` },
		});

		expect(res.status).toBe(201);
		const body = (await res.json()) as { id: string; owner: string; createdAt: string };
		expect(typeof body.id).toBe("string");
		expect(body.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		expect(body.owner).toBe("owner-1");
		expect(typeof body.createdAt).toBe("string");
	});

	it("create sandbox with network=true returns network:true in response and sets runtime flag", async () => {
		const { sessionManager } = makeTestEnv();
		const app = makeTestApp(sessionManager);
		const token = await makeToken("owner-net");

		const res = await app.request("/v1/sandboxes", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ javascript: true, network: true }),
		});

		expect(res.status).toBe(201);
		const body = (await res.json()) as { id: string; javascript: boolean; network: boolean };
		expect(body.javascript).toBe(true);
		expect(body.network).toBe(true);

		// Verify the session was created with network=true in runtimeOptions
		const session = sessionManager.getSession("default", body.id);
		expect(session?.runtimeOptions.network).toBe(true);
	});

	it("create sandbox without network flag returns network:false by default", async () => {
		const { sessionManager } = makeTestEnv();
		const app = makeTestApp(sessionManager);
		const token = await makeToken("owner-no-net");

		const res = await app.request("/v1/sandboxes", {
			method: "POST",
			headers: { Authorization: `Bearer ${token}` },
		});

		expect(res.status).toBe(201);
		const body = (await res.json()) as { network: boolean };
		expect(body.network).toBe(false);
	});

	it("create sandbox with initial files writes files to fs", async () => {
		const { sessionManager, fs } = makeTestEnv();
		const app = makeTestApp(sessionManager);
		const token = await makeToken("owner-2");

		const res = await app.request("/v1/sandboxes", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				files: {
					"/hello.txt": "hello world",
				},
			}),
		});

		expect(res.status).toBe(201);

		// Verify the file was written to the shared InMemoryFs instance
		const content = await fs.readFile("/hello.txt");
		const decoded = typeof content === "string" ? content : new TextDecoder().decode(content);
		expect(decoded).toBe("hello world");
	});
});

describe("DELETE /v1/sandboxes/:id", () => {
	beforeEach(() => {
		process.env.AUTH_SECRET = AUTH_SECRET;
	});

	afterEach(() => {
		process.env.AUTH_SECRET = "";
	});

	it("create then delete sandbox returns 204", async () => {
		const { sessionManager } = makeTestEnv();
		const app = makeTestApp(sessionManager);
		const token = await makeToken("owner-del");

		// Create a sandbox
		const postRes = await app.request("/v1/sandboxes", {
			method: "POST",
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(postRes.status).toBe(201);
		const { id } = (await postRes.json()) as { id: string };

		// Delete it
		const delRes = await app.request(`/v1/sandboxes/${id}`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(delRes.status).toBe(204);
	});

	it("queued delete is cancelled when the request aborts after ownership validation", async () => {
		const admission = new FairAdmission({
			capacity: 1,
			maxActivePerTenant: 1,
			maxQueued: 1,
			maxQueuedPerTenant: 1,
			maxQueuedBytes: 1024,
			maxQueuedBytesPerTenant: 1024,
			waitMs: 1000,
		});
		const releaseActive = await admission.acquire("tenant", "active", 1);
		let destroyed = 0;
		const manager = {
			withSessionOrRehydrate: async (_tenant: string, _id: string, fn: (session: { owner: string }) => Promise<void>) =>
				fn({ owner: "owner-del" }),
			destroy: async () => {
				const signal = workerRequestContext.getStore()?.signal;
				const release = await admission.acquire("tenant", "delete", 1, signal);
				destroyed++;
				release();
				return true;
			},
		} as unknown as SessionManager;
		const app = makeTestApp(manager);
		app.onError(() => new Response(null, { status: 499 }));
		const token = await makeToken("owner-del");
		const controller = new AbortController();
		const responsePromise = app.fetch(
			new Request("http://localhost/v1/sandboxes/queued-delete", {
				method: "DELETE",
				headers: { Authorization: `Bearer ${token}` },
				signal: controller.signal,
			}),
		);

		try {
			await vi.waitFor(() => expect(admission.metrics.queued).toBe(1));
			controller.abort();
			releaseActive();
			const response = await responsePromise;
			expect(destroyed).toBe(0);
			expect(response.status).toBe(499);
			expect(admission.metrics.cancelled).toBe(1);
		} finally {
			releaseActive();
		}
	});

	it("delete non-existent sandbox returns 404", async () => {
		const { sessionManager } = makeTestEnv();
		const app = makeTestApp(sessionManager);
		const token = await makeToken("owner-del");

		const res = await app.request("/v1/sandboxes/00000000-0000-0000-0000-000000000000", {
			method: "DELETE",
			headers: { Authorization: `Bearer ${token}` },
		});

		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: string; code: string };
		expect(body.error).toBe("not_found");
		expect(body.code).toBe("SANDBOX_NOT_FOUND");
	});

	it("delete returns 403 on a cold replica when another owner created the sandbox", async () => {
		const meta = new Map<string, SandboxMeta>();
		const ownerManager = new SessionManager({
			createFs: async () => new InMemoryFs(),
			getSandboxMetaFn: async (_tenantId, sandboxId) => meta.get(sandboxId) ?? null,
			persistSandboxMetaFn: async (_tenantId, sandboxId, sandboxMeta) => {
				meta.set(sandboxId, sandboxMeta);
			},
		});
		const ownerApp = makeTestApp(ownerManager);
		const ownerToken = await makeToken("owner-a");
		const createRes = await ownerApp.request("/v1/sandboxes", {
			method: "POST",
			headers: { Authorization: `Bearer ${ownerToken}` },
		});
		const { id } = (await createRes.json()) as { id: string };

		const coldReplica = new SessionManager({
			createFs: async () => new InMemoryFs(),
			getSandboxMetaFn: async (_tenantId, sandboxId) => meta.get(sandboxId) ?? null,
		});
		const app = makeTestApp(coldReplica);
		const otherToken = await makeToken("owner-b");

		const res = await app.request(`/v1/sandboxes/${id}`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${otherToken}` },
		});

		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: string; code: string };
		expect(body).toEqual({ error: "forbidden", code: "FORBIDDEN" });
	});
});

describe("GET /v1/sandboxes/:id", () => {
	beforeEach(() => {
		process.env.AUTH_SECRET = AUTH_SECRET;
	});

	afterEach(() => {
		process.env.AUTH_SECRET = "";
	});

	it("get existing sandbox returns 200 with correct metadata", async () => {
		const { sessionManager } = makeTestEnv();
		const app = makeTestApp(sessionManager);
		const token = await makeToken("owner-get");

		// Create a sandbox first
		const postRes = await app.request("/v1/sandboxes", {
			method: "POST",
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(postRes.status).toBe(201);
		const { id } = (await postRes.json()) as { id: string };

		// Get the sandbox
		const getRes = await app.request(`/v1/sandboxes/${id}`, {
			headers: { Authorization: `Bearer ${token}` },
		});

		expect(getRes.status).toBe(200);
		const body = (await getRes.json()) as { id: string; owner: string; createdAt: string; lastUsedAt: string };
		expect(body.id).toBe(id);
		expect(body.owner).toBe("owner-get");
		expect(typeof body.createdAt).toBe("string");
		expect(typeof body.lastUsedAt).toBe("string");
	});

	it("get non-existent sandbox returns 404", async () => {
		const { sessionManager } = makeTestEnv();
		const app = makeTestApp(sessionManager);
		const token = await makeToken("owner-get");

		const res = await app.request("/v1/sandboxes/00000000-0000-0000-0000-000000000000", {
			headers: { Authorization: `Bearer ${token}` },
		});

		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: string; code: string };
		expect(body.error).toBe("not_found");
		expect(body.code).toBe("SANDBOX_NOT_FOUND");
	});

	it("returns 200 with correct createdAt after session eviction (DB fallback, no 404)", async () => {
		// Simulate a cold replica: getSandboxMetaFn is wired up but the session
		// pool starts empty (the sandbox was created on a different replica).
		const knownCreatedAt = "2026-05-15T10:00:00.000Z";
		const meta = new Map<string, SandboxMeta>();
		const sandboxId = crypto.randomUUID();
		meta.set(sandboxId, {
			owner: "owner-evict",
			name: null,
			python: false,
			javascript: false,
			network: false,
			createdAt: knownCreatedAt,
		});

		const coldReplica = new SessionManager({
			createFs: async () => new InMemoryFs(),
			getSandboxMetaFn: async (_tenantId, id) => meta.get(id) ?? null,
		});
		const app = makeTestApp(coldReplica);
		const ownerToken = await makeToken("owner-evict");

		// GET on a sandbox that exists in meta but not in the in-memory pool must
		// return 200 (not 404) and supply the correct createdAt from DB.
		const getRes = await app.request(`/v1/sandboxes/${sandboxId}`, {
			headers: { Authorization: `Bearer ${ownerToken}` },
		});

		expect(getRes.status).toBe(200);
		const body = (await getRes.json()) as { id: string; createdAt: string };
		expect(body.id).toBe(sandboxId);
		expect(body.createdAt).toBe(knownCreatedAt);
	});

	it("createdAt from GET matches createdAt from POST (no rehydration drift)", async () => {
		const { sessionManager } = makeTestEnv();
		const app = makeTestApp(sessionManager);
		const token = await makeToken("owner-drift");

		const postRes = await app.request("/v1/sandboxes", {
			method: "POST",
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(postRes.status).toBe(201);
		const { id, createdAt: postCreatedAt } = (await postRes.json()) as { id: string; createdAt: string };

		const getRes = await app.request(`/v1/sandboxes/${id}`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(getRes.status).toBe(200);
		const { createdAt: getCreatedAt } = (await getRes.json()) as { createdAt: string };

		// The timestamps must agree — no clock-based drift between POST and GET
		expect(getCreatedAt).toBe(postCreatedAt);
	});
});

describe("sandbox creation body admission", () => {
	const managers: SessionManager[] = [];

	beforeEach(() => {
		vi.stubEnv("AUTH_SECRET", AUTH_SECRET);
	});

	afterEach(async () => {
		await Promise.all(managers.splice(0).map((manager) => manager.shutdown()));
		vi.unstubAllEnvs();
	});

	function setup(stackBodyLimit = false) {
		const metadata = new Map<string, SandboxMeta>();
		let filesystems = 0;
		const manager = new SessionManager({
			createFs: async () => {
				filesystems++;
				return new InMemoryFs();
			},
			persistSandboxMetaFn: async (_tenant, id, meta) => {
				metadata.set(id, meta);
			},
		});
		managers.push(manager);
		const ingress = new IngressAdmission({
			maxRequests: 8,
			maxTenantRequests: 4,
			maxBytes: 128,
			maxTenantBytes: 96,
			maxBodyBytes: 64,
		});
		const app = new Hono<{ Variables: AuthVariables }>();
		app.onError((_error, c) => c.json({ error: "body rejected" }, 500));
		app.use("*", authMiddleware);
		app.use("*", ingress.middleware);
		if (stackBodyLimit) app.use("*", bodyLimit({ maxSize: 64 }));
		app.post("/hold", async (c) => {
			await c.req.text();
			return new Response(new ReadableStream(), { headers: { "Content-Type": "text/event-stream" } });
		});
		app.route("/v1/sandboxes", sandboxRoutes(manager));
		return { app, ingress, metadata, filesystems: () => filesystems };
	}

	async function request(
		app: ReturnType<typeof setup>["app"],
		body?: ReadableStream<Uint8Array> | string,
		options: { path?: string; signal?: AbortSignal; declared?: string } = {},
	) {
		return app.request(
			new Request(`http://localhost${options.path ?? "/v1/sandboxes"}`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${await makeToken()}`,
					...(options.declared === undefined ? {} : { "Content-Length": options.declared }),
				},
				body,
				signal: options.signal,
				duplex: "half",
			} as RequestInit),
		);
	}

	function chunks(text: string) {
		return new ReadableStream<Uint8Array>({
			start(output) {
				output.enqueue(new TextEncoder().encode(text.slice(0, 8)));
				output.enqueue(new TextEncoder().encode(text.slice(8)));
				output.close();
			},
		});
	}

	for (const declared of [undefined, "1"]) {
		it(`creates no sandbox after a ${declared === undefined ? "chunked" : "underdeclared"} body exceeds its limit`, async () => {
			const { app, ingress, metadata, filesystems } = setup();
			const response = await request(app, chunks(JSON.stringify({ name: "x".repeat(64) })), { declared });
			expect(response.status).toBe(413);
			expect(await response.json()).toMatchObject({ code: "PAYLOAD_TOO_LARGE", retryable: false });
			expect(filesystems()).toBe(0);
			expect(metadata.size).toBe(0);
			expect(ingress.metrics).toMatchObject({ activeRequests: 0, retainedRawBytes: 0, payloadTooLarge: 1 });
		});

		it(`creates no sandbox after a ${declared === undefined ? "chunked" : "underdeclared"} body exhausts tenant bytes`, async () => {
			const { app, ingress, metadata, filesystems } = setup();
			const held = await request(app, "x".repeat(64), { path: "/hold" });
			try {
				const response = await request(app, chunks(JSON.stringify({ name: "x".repeat(40) })), { declared });
				expect(response.status).toBe(503);
				expect(await response.json()).toMatchObject({ code: "EWORKER_BUSY", retryable: true });
				expect(response.headers.get("Retry-After")).toBe("1");
				expect(filesystems()).toBe(0);
				expect(metadata.size).toBe(0);
				expect(ingress.metrics).toMatchObject({ activeRequests: 1, retainedRawBytes: 64, refused: 1 });
			} finally {
				await held.body!.cancel();
			}
			expect(ingress.metrics).toMatchObject({ activeRequests: 0, retainedRawBytes: 0 });
		});
	}

	for (const stackBodyLimit of [false, true]) {
		it(`creates no sandbox after abort${stackBodyLimit ? " with Hono bodyLimit" : ""}`, async () => {
			const { app, ingress, metadata, filesystems } = setup(stackBodyLimit);
			const abort = new AbortController();
			const body = new ReadableStream<Uint8Array>({
				start(output) {
					output.enqueue(new TextEncoder().encode("{}"));
				},
			});
			const pending = request(app, body, { signal: abort.signal });
			await expect.poll(() => ingress.metrics.retainedRawBytes).toBe(2);
			abort.abort();
			const response = await pending;
			expect(response.status).toBe(499);
			expect(filesystems()).toBe(0);
			expect(metadata.size).toBe(0);
			expect(ingress.metrics).toMatchObject({ activeRequests: 0, retainedRawBytes: 0, aborted: 1 });
		});
	}

	for (const error of [new Error("body transport failed"), new SyntaxError("body transport failed")]) {
		it(`creates no sandbox when the transport throws ${error.name}`, async () => {
			const { app, metadata, filesystems } = setup();
			const body = new ReadableStream<Uint8Array>({
				start(output) {
					output.error(error);
				},
			});
			expect((await request(app, body)).status).toBe(500);
			expect(filesystems()).toBe(0);
			expect(metadata.size).toBe(0);
		});
	}

	for (const body of [undefined, "", "{}", '{"name":"valid"}']) {
		it(`accepts a complete optional body ${JSON.stringify(body)}`, async () => {
			const { app, metadata, filesystems } = setup();
			expect((await request(app, body)).status).toBe(201);
			expect(filesystems()).toBe(1);
			expect(metadata.size).toBe(1);
		});
	}

	it("rejects malformed nonempty JSON before creating a sandbox", async () => {
		const { app, metadata, filesystems } = setup();
		const response = await request(app, "{");
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ code: "INVALID_INPUT", details: ["Invalid JSON body"] });
		expect(filesystems()).toBe(0);
		expect(metadata.size).toBe(0);
	});
});

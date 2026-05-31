/**
 * Unit tests for sandbox CRUD routes (US-059, US-060)
 */

import { Hono } from "hono";
import { SignJWT } from "jose";
import { InMemoryFs } from "just-bash";
import type { IFileSystem } from "just-bash";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SandboxMeta } from "../../../sql-fs/types.js";
import { type AuthVariables, authMiddleware } from "../../auth.js";
import { sandboxRoutes } from "../../routes/sandboxes.js";
import { SessionManager } from "../../session-manager.js";

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

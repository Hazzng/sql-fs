/**
 * Unit tests for POST /v1/sandboxes (US-059)
 */

import { Hono } from "hono";
import { SignJWT } from "jose";
import { InMemoryFs } from "just-bash";
import type { IFileSystem } from "just-bash";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AuthVariables, authMiddleware } from "../auth.js";
import { sandboxRoutes } from "../routes/sandboxes.js";
import { SessionManager } from "../session-manager.js";

const AUTH_SECRET = "test-secret-for-sandbox-tests-at-least-32b";
const secretBytes = new TextEncoder().encode(AUTH_SECRET);

async function makeToken(sub = "agent-1"): Promise<string> {
	return new SignJWT({ sub }).setProtectedHeader({ alg: "HS256" }).sign(secretBytes);
}

function makeTestEnv(): { sessionManager: SessionManager; fs: IFileSystem } {
	const fs = new InMemoryFs();
	const sessionManager = new SessionManager({
		backend: "memory",
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

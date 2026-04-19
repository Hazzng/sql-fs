/**
 * Unit tests for file operation routes.
 * US-062: GET /v1/sandboxes/:id/files/*path — read file
 */

import { Hono } from "hono";
import { SignJWT } from "jose";
import { InMemoryFs } from "just-bash";
import type { IFileSystem } from "just-bash";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AuthVariables, authMiddleware } from "../auth.js";
import { fileRoutes } from "../routes/files.js";
import { SessionManager } from "../session-manager.js";

const AUTH_SECRET = "test-secret-for-files-tests-at-least-32bytes!";
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
	app.route("/v1/sandboxes", fileRoutes(sessionManager));
	return app;
}

const SANDBOX_ID = "test-sandbox-files-abc";

describe("GET /v1/sandboxes/:id/files/*path", () => {
	beforeEach(() => {
		process.env.AUTH_SECRET = AUTH_SECRET;
	});

	afterEach(() => {
		process.env.AUTH_SECRET = "";
	});

	it("read existing file returns content with correct Content-Type and X-FS-Stat", async () => {
		const { sessionManager, fs } = makeTestEnv();
		const app = makeTestApp(sessionManager);
		const token = await makeToken();

		await (fs as InMemoryFs).writeFile("/hello.txt", "hello world");

		const res = await app.request(`/v1/sandboxes/${SANDBOX_ID}/files/hello.txt`, {
			headers: { Authorization: `Bearer ${token}` },
		});

		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toContain("text/plain");
		expect(await res.text()).toBe("hello world");

		const statRaw = res.headers.get("X-FS-Stat");
		expect(statRaw).not.toBeNull();
		const stat = JSON.parse(statRaw ?? "{}") as { kind: string; mode: number; size: number; mtime: string };
		expect(stat.kind).toBe("file");
		expect(typeof stat.mode).toBe("number");
		expect(typeof stat.mtime).toBe("string");
	});

	it("read non-existent file returns 404", async () => {
		const { sessionManager } = makeTestEnv();
		const app = makeTestApp(sessionManager);
		const token = await makeToken();

		const res = await app.request(`/v1/sandboxes/${SANDBOX_ID}/files/nonexistent.txt`, {
			headers: { Authorization: `Bearer ${token}` },
		});

		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: string; code: string };
		expect(body.code).toBe("ENOENT");
	});

	it("read directory returns 400", async () => {
		const { sessionManager, fs } = makeTestEnv();
		const app = makeTestApp(sessionManager);
		const token = await makeToken();

		await (fs as InMemoryFs).mkdir("/testdir");

		const res = await app.request(`/v1/sandboxes/${SANDBOX_ID}/files/testdir`, {
			headers: { Authorization: `Bearer ${token}` },
		});

		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string; code: string };
		expect(body.code).toBe("EISDIR");
	});
});

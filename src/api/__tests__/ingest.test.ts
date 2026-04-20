/**
 * Unit tests for ingest routes.
 * US-071: POST /v1/sandboxes/:id/ingest — tar.gz upload
 * US-072: POST /v1/sandboxes/:id/ingest-files — JSON manifest upload
 */

import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { SignJWT } from "jose";
import { InMemoryFs } from "just-bash";
import type { IFileSystem } from "just-bash";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AuthVariables, authMiddleware } from "../auth.js";
import { ingestRoutes } from "../routes/ingest.js";
import { SessionManager } from "../session-manager.js";

const AUTH_SECRET = "test-secret-for-ingest-tests-at-least-32bytes!";
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
	app.route("/v1/sandboxes", ingestRoutes(sessionManager));
	return app;
}

/**
 * Creates a tar.gz archive on the host filesystem containing the given files,
 * and returns its contents as a Uint8Array.
 */
function createTarGz(files: Record<string, string>): Uint8Array {
	const tmpDir = path.join(os.tmpdir(), `ingest-test-${Date.now()}`);
	mkdirSync(tmpDir, { recursive: true });
	try {
		for (const [name, content] of Object.entries(files)) {
			writeFileSync(path.join(tmpDir, name), content, "utf-8");
		}
		const archivePath = path.join(tmpDir, "_archive.tar.gz");
		const fileNames = Object.keys(files).join(" ");
		execSync(`tar czf '${archivePath}' -C '${tmpDir}' ${fileNames}`);
		const buf = readFileSync(archivePath);
		return new Uint8Array(buf);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
}

const SANDBOX_ID = "test-sandbox-ingest-abc";

describe("POST /v1/sandboxes/:id/ingest", () => {
	beforeEach(() => {
		process.env.AUTH_SECRET = AUTH_SECRET;
	});

	afterEach(() => {
		process.env.AUTH_SECRET = "";
	});

	it("ingest tar.gz of 3 files — files are readable in sandbox at basePath", async () => {
		const { sessionManager } = makeTestEnv();
		const app = makeTestApp(sessionManager);
		const token = await makeToken();

		const files = {
			"hello.txt": "hello world",
			"foo.js": "console.log('foo');",
			"bar.md": "# Bar\nSome content",
		};
		const archiveBytes = createTarGz(files);

		const formData = new FormData();
		formData.append("archive", new File([archiveBytes], "archive.tar.gz", { type: "application/gzip" }));
		formData.append("basePath", "/home/user/project");

		const res = await app.request(`/v1/sandboxes/${SANDBOX_ID}/ingest`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}` },
			body: formData,
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as { status: string; basePath: string };
		expect(body.status).toBe("ok");
		expect(body.basePath).toBe("/home/user/project");

		// Verify files are readable in the sandbox
		const session = await sessionManager.getOrCreate(SANDBOX_ID);
		for (const [name, expectedContent] of Object.entries(files)) {
			const content = await session.fs.readFile(`/home/user/project/${name}`);
			expect(content).toBe(expectedContent);
		}
	});

	it("uses default basePath /home/user/project when not specified", async () => {
		const { sessionManager } = makeTestEnv();
		const app = makeTestApp(sessionManager);
		const token = await makeToken();

		const archiveBytes = createTarGz({ "readme.txt": "hello" });
		const formData = new FormData();
		formData.append("archive", new File([archiveBytes], "archive.tar.gz", { type: "application/gzip" }));
		// No basePath field

		const res = await app.request(`/v1/sandboxes/${SANDBOX_ID}/ingest`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}` },
			body: formData,
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as { status: string; basePath: string };
		expect(body.basePath).toBe("/home/user/project");
	});

	it("missing archive field returns 400", async () => {
		const { sessionManager } = makeTestEnv();
		const app = makeTestApp(sessionManager);
		const token = await makeToken();

		const formData = new FormData();
		formData.append("basePath", "/home/user/project");

		const res = await app.request(`/v1/sandboxes/${SANDBOX_ID}/ingest`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}` },
			body: formData,
		});

		expect(res.status).toBe(400);
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("INVALID_INPUT");
	});

	it("unauthenticated request returns 401", async () => {
		const { sessionManager } = makeTestEnv();
		const app = makeTestApp(sessionManager);

		const res = await app.request(`/v1/sandboxes/${SANDBOX_ID}/ingest`, {
			method: "POST",
		});

		expect(res.status).toBe(401);
	});
});

describe("POST /v1/sandboxes/:id/ingest-files", () => {
	beforeEach(() => {
		process.env.AUTH_SECRET = AUTH_SECRET;
	});

	afterEach(() => {
		process.env.AUTH_SECRET = "";
	});

	it("ingest 3 files via JSON — content matches after base64 decode", async () => {
		const { sessionManager } = makeTestEnv();
		const app = makeTestApp(sessionManager);
		const token = await makeToken();

		const files: Record<string, string> = {
			"hello.txt": Buffer.from("hello world").toString("base64"),
			"foo.js": Buffer.from("console.log('foo');").toString("base64"),
			"sub/bar.md": Buffer.from("# Bar\nSome content").toString("base64"),
		};

		const res = await app.request(`/v1/sandboxes/${SANDBOX_ID}/ingest-files`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ basePath: "/home/user/project", files }),
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as { status: string; fileCount: number };
		expect(body.status).toBe("ok");
		expect(body.fileCount).toBe(3);

		const session = await sessionManager.getOrCreate(SANDBOX_ID);
		expect(await session.fs.readFile("/home/user/project/hello.txt")).toBe("hello world");
		expect(await session.fs.readFile("/home/user/project/foo.js")).toBe("console.log('foo');");
		expect(await session.fs.readFile("/home/user/project/sub/bar.md")).toBe("# Bar\nSome content");
	});

	it("missing basePath returns 400 validation error", async () => {
		const { sessionManager } = makeTestEnv();
		const app = makeTestApp(sessionManager);
		const token = await makeToken();

		const res = await app.request(`/v1/sandboxes/${SANDBOX_ID}/ingest-files`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ files: { "a.txt": Buffer.from("a").toString("base64") } }),
		});

		expect(res.status).toBe(400);
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("INVALID_INPUT");
	});

	it("missing files returns 400 validation error", async () => {
		const { sessionManager } = makeTestEnv();
		const app = makeTestApp(sessionManager);
		const token = await makeToken();

		const res = await app.request(`/v1/sandboxes/${SANDBOX_ID}/ingest-files`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ basePath: "/home/user" }),
		});

		expect(res.status).toBe(400);
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("INVALID_INPUT");
	});
});

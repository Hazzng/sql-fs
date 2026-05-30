/**
 * Unit tests for file operation routes.
 * US-062: GET /v1/sandboxes/:id/files/*path — read file
 * US-063: PUT /v1/sandboxes/:id/files/*path — write file
 * US-064: DELETE /v1/sandboxes/:id/files/*path — delete file or dir
 * US-065: POST /v1/sandboxes/:id/mkdir — create directory
 * US-066: POST /v1/sandboxes/:id/writeFiles — bulk write
 * US-067: GET /v1/sandboxes/:id/tree — list file tree
 */

import { Hono } from "hono";
import { SignJWT } from "jose";
import { InMemoryFs } from "just-bash";
import type { IFileSystem } from "just-bash";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SandboxMeta } from "../../../fs/sql-fs/types.js";
import { type AuthVariables, authMiddleware } from "../../auth.js";
import { fileRoutes } from "../../routes/files.js";
import { SessionManager } from "../../session-manager.js";

const AUTH_SECRET = "test-secret-for-files-tests-at-least-32bytes!";
const secretBytes = new TextEncoder().encode(AUTH_SECRET);

async function makeToken(sub = "agent-1"): Promise<string> {
	return new SignJWT({ sub }).setProtectedHeader({ alg: "HS256" }).sign(secretBytes);
}

async function makeTestEnv(): Promise<{ sessionManager: SessionManager; fs: IFileSystem }> {
	const fs = new InMemoryFs();
	const sessionManager = new SessionManager({
		createFs: async () => fs,
	});
	await sessionManager.getOrCreate("default", SANDBOX_ID, undefined, "agent-1");
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
		const { sessionManager, fs } = await makeTestEnv();
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
		const { sessionManager } = await makeTestEnv();
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
		const { sessionManager, fs } = await makeTestEnv();
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

describe("PUT /v1/sandboxes/:id/files/*path", () => {
	beforeEach(() => {
		process.env.AUTH_SECRET = AUTH_SECRET;
	});

	afterEach(() => {
		process.env.AUTH_SECRET = "";
	});

	it("write new file returns 204 and content is readable via GET", async () => {
		const { sessionManager } = await makeTestEnv();
		const app = makeTestApp(sessionManager);
		const token = await makeToken();
		const content = "hello from PUT";

		const putRes = await app.request(`/v1/sandboxes/${SANDBOX_ID}/files/put-new.txt`, {
			method: "PUT",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
			body: content,
		});
		expect(putRes.status).toBe(204);

		const getRes = await app.request(`/v1/sandboxes/${SANDBOX_ID}/files/put-new.txt`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(getRes.status).toBe(200);
		expect(await getRes.text()).toBe(content);
	});

	it("overwrite existing file via PUT returns 204 and new content is readable", async () => {
		const { sessionManager, fs } = await makeTestEnv();
		const app = makeTestApp(sessionManager);
		const token = await makeToken();

		await (fs as InMemoryFs).writeFile("/overwrite.txt", "original content");

		const putRes = await app.request(`/v1/sandboxes/${SANDBOX_ID}/files/overwrite.txt`, {
			method: "PUT",
			headers: { Authorization: `Bearer ${token}` },
			body: "new content",
		});
		expect(putRes.status).toBe(204);

		const getRes = await app.request(`/v1/sandboxes/${SANDBOX_ID}/files/overwrite.txt`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(getRes.status).toBe(200);
		expect(await getRes.text()).toBe("new content");
	});

	it("write file under nested path creates parent dirs automatically", async () => {
		const { sessionManager } = await makeTestEnv();
		const app = makeTestApp(sessionManager);
		const token = await makeToken();

		const putRes = await app.request(`/v1/sandboxes/${SANDBOX_ID}/files/a/b/c/deep.txt`, {
			method: "PUT",
			headers: { Authorization: `Bearer ${token}` },
			body: "deep content",
		});
		expect(putRes.status).toBe(204);

		const getRes = await app.request(`/v1/sandboxes/${SANDBOX_ID}/files/a/b/c/deep.txt`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(getRes.status).toBe(200);
		expect(await getRes.text()).toBe("deep content");
	});

	it("returns 403 when a cold replica rehydrates a sandbox owned by another caller", async () => {
		const meta = new Map<string, SandboxMeta>();
		const ownerManager = new SessionManager({
			createFs: async () => new InMemoryFs(),
			getSandboxMetaFn: async (_tenantId, sandboxId) => meta.get(sandboxId) ?? null,
			persistSandboxMetaFn: async (_tenantId, sandboxId, sandboxMeta) => {
				meta.set(sandboxId, sandboxMeta);
			},
		});
		await ownerManager.withSession("default", SANDBOX_ID, async (session) => {
			session.owner = "agent-1";
			await ownerManager.persistSandboxMeta("default", SANDBOX_ID, {
				owner: "agent-1",
				name: null,
				python: false,
				javascript: false,
				network: false,
			});
		});

		const coldReplica = new SessionManager({
			createFs: async () => new InMemoryFs(),
			getSandboxMetaFn: async (_tenantId, sandboxId) => meta.get(sandboxId) ?? null,
		});
		const app = makeTestApp(coldReplica);
		const token = await makeToken("agent-2");

		const res = await app.request(`/v1/sandboxes/${SANDBOX_ID}/files/blocked.txt`, {
			method: "PUT",
			headers: { Authorization: `Bearer ${token}` },
			body: "should not write",
		});

		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: string; code: string };
		expect(body).toEqual({ error: "forbidden", code: "FORBIDDEN" });
	});
});

describe("DELETE /v1/sandboxes/:id/files/*path", () => {
	beforeEach(() => {
		process.env.AUTH_SECRET = AUTH_SECRET;
	});

	afterEach(() => {
		process.env.AUTH_SECRET = "";
	});

	it("delete existing file returns 204", async () => {
		const { sessionManager, fs } = await makeTestEnv();
		const app = makeTestApp(sessionManager);
		const token = await makeToken();

		await (fs as InMemoryFs).writeFile("/to-delete.txt", "bye");

		const res = await app.request(`/v1/sandboxes/${SANDBOX_ID}/files/to-delete.txt`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(res.status).toBe(204);
	});

	it("delete non-existent file returns 404", async () => {
		const { sessionManager } = await makeTestEnv();
		const app = makeTestApp(sessionManager);
		const token = await makeToken();

		const res = await app.request(`/v1/sandboxes/${SANDBOX_ID}/files/ghost.txt`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(res.status).toBe(404);
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("ENOENT");
	});

	it("delete non-empty directory without recursive returns 409", async () => {
		const { sessionManager, fs } = await makeTestEnv();
		const app = makeTestApp(sessionManager);
		const token = await makeToken();

		await (fs as InMemoryFs).mkdir("/nonempty");
		await (fs as InMemoryFs).writeFile("/nonempty/child.txt", "content");

		const res = await app.request(`/v1/sandboxes/${SANDBOX_ID}/files/nonempty`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(res.status).toBe(409);
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("ENOTEMPTY");
	});

	it("delete directory with recursive=true returns 204", async () => {
		const { sessionManager, fs } = await makeTestEnv();
		const app = makeTestApp(sessionManager);
		const token = await makeToken();

		await (fs as InMemoryFs).mkdir("/recursive-dir");
		await (fs as InMemoryFs).writeFile("/recursive-dir/file.txt", "data");

		const res = await app.request(`/v1/sandboxes/${SANDBOX_ID}/files/recursive-dir?recursive=true`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(res.status).toBe(204);
	});
});

describe("POST /v1/sandboxes/:id/mkdir", () => {
	beforeEach(() => {
		process.env.AUTH_SECRET = AUTH_SECRET;
	});

	afterEach(() => {
		process.env.AUTH_SECRET = "";
	});

	it("mkdir returns 204 and directory is created", async () => {
		const { sessionManager, fs } = await makeTestEnv();
		const app = makeTestApp(sessionManager);
		const token = await makeToken();

		const res = await app.request(`/v1/sandboxes/${SANDBOX_ID}/mkdir`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ path: "/newdir" }),
		});
		expect(res.status).toBe(204);

		const stat = await (fs as InMemoryFs).stat("/newdir");
		expect(stat.isDirectory).toBe(true);
	});

	it("mkdir with recursive creates nested directories", async () => {
		const { sessionManager, fs } = await makeTestEnv();
		const app = makeTestApp(sessionManager);
		const token = await makeToken();

		const res = await app.request(`/v1/sandboxes/${SANDBOX_ID}/mkdir`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ path: "/a/b/c", recursive: true }),
		});
		expect(res.status).toBe(204);

		const stat = await (fs as InMemoryFs).stat("/a/b/c");
		expect(stat.isDirectory).toBe(true);
	});

	it("mkdir existing directory without recursive returns 409", async () => {
		const { sessionManager, fs } = await makeTestEnv();
		const app = makeTestApp(sessionManager);
		const token = await makeToken();

		await (fs as InMemoryFs).mkdir("/existing");

		const res = await app.request(`/v1/sandboxes/${SANDBOX_ID}/mkdir`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ path: "/existing" }),
		});
		expect(res.status).toBe(409);
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("EEXIST");
	});
});

describe("POST /v1/sandboxes/:id/writeFiles", () => {
	beforeEach(() => {
		process.env.AUTH_SECRET = AUTH_SECRET;
	});

	afterEach(() => {
		process.env.AUTH_SECRET = "";
	});

	it("write 5 files in one call, verify all readable via GET", async () => {
		const { sessionManager } = await makeTestEnv();
		const app = makeTestApp(sessionManager);
		const token = await makeToken();

		const files: Record<string, string> = {
			"/a.txt": "content-a",
			"/b.txt": "content-b",
			"/sub/c.txt": "content-c",
			"/sub/deep/d.txt": "content-d",
			"/e.txt": "content-e",
		};

		const writeRes = await app.request(`/v1/sandboxes/${SANDBOX_ID}/writeFiles`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ files }),
		});
		expect(writeRes.status).toBe(204);

		for (const [path, expected] of Object.entries(files)) {
			const getRes = await app.request(`/v1/sandboxes/${SANDBOX_ID}/files${path}`, {
				headers: { Authorization: `Bearer ${token}` },
			});
			expect(getRes.status).toBe(200);
			expect(await getRes.text()).toBe(expected);
		}
	});
});

describe("GET /v1/sandboxes/:id/tree", () => {
	beforeEach(() => {
		process.env.AUTH_SECRET = AUTH_SECRET;
	});

	afterEach(() => {
		process.env.AUTH_SECRET = "";
	});

	it("tree of nested structure returns all entries", async () => {
		const { sessionManager, fs } = await makeTestEnv();
		const app = makeTestApp(sessionManager);
		const token = await makeToken();

		// Use a unique prefix to isolate from InMemoryFs built-in paths (/bin, /dev, etc.)
		await (fs as InMemoryFs).mkdir("/myapp");
		await (fs as InMemoryFs).mkdir("/myapp/sub");
		await (fs as InMemoryFs).mkdir("/myapp/sub/deep");
		await (fs as InMemoryFs).writeFile("/myapp/a.txt", "content-a");
		await (fs as InMemoryFs).writeFile("/myapp/sub/b.txt", "content-b");
		await (fs as InMemoryFs).writeFile("/myapp/sub/deep/c.txt", "content-c");

		const res = await app.request(`/v1/sandboxes/${SANDBOX_ID}/tree?prefix=/myapp`, {
			headers: { Authorization: `Bearer ${token}` },
		});

		expect(res.status).toBe(200);
		type Entry = { path: string; kind: string; size: number; mtime: string };
		const entries = (await res.json()) as Entry[];
		const paths = entries.map((e) => e.path).sort();

		expect(paths).toEqual([
			"/myapp/a.txt",
			"/myapp/sub",
			"/myapp/sub/b.txt",
			"/myapp/sub/deep",
			"/myapp/sub/deep/c.txt",
		]);

		// Verify entry shape
		const fileEntry = entries.find((e) => e.path === "/myapp/a.txt");
		expect(fileEntry?.kind).toBe("file");
		expect(typeof fileEntry?.size).toBe("number");
		expect(typeof fileEntry?.mtime).toBe("string");

		const dirEntry = entries.find((e) => e.path === "/myapp/sub");
		expect(dirEntry?.kind).toBe("dir");
	});

	it("tree with depth=1 returns only direct children", async () => {
		const { sessionManager, fs } = await makeTestEnv();
		const app = makeTestApp(sessionManager);
		const token = await makeToken();

		// Use a unique prefix to isolate from InMemoryFs built-in paths
		await (fs as InMemoryFs).mkdir("/myapp");
		await (fs as InMemoryFs).mkdir("/myapp/sub");
		await (fs as InMemoryFs).mkdir("/myapp/sub/deep");
		await (fs as InMemoryFs).writeFile("/myapp/a.txt", "content-a");
		await (fs as InMemoryFs).writeFile("/myapp/sub/b.txt", "content-b");
		await (fs as InMemoryFs).writeFile("/myapp/sub/deep/c.txt", "content-c");

		const res = await app.request(`/v1/sandboxes/${SANDBOX_ID}/tree?prefix=/myapp&depth=1`, {
			headers: { Authorization: `Bearer ${token}` },
		});

		expect(res.status).toBe(200);
		type Entry = { path: string; kind: string; size: number; mtime: string };
		const entries = (await res.json()) as Entry[];
		const paths = entries.map((e) => e.path).sort();

		// Only /myapp/a.txt and /myapp/sub are direct children of /myapp
		expect(paths).toEqual(["/myapp/a.txt", "/myapp/sub"]);
	});
});

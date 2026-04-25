/**
 * Unit tests for ingest routes.
 * US-072: POST /v1/sandboxes/:id/ingest-files — JSON manifest upload
 * US-073: GET /v1/sandboxes/:id/export — tar.gz download
 */

import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { SignJWT } from "jose";
import { InMemoryFs } from "just-bash";
import type { IFileSystem } from "just-bash";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ICoherentFs } from "../../fs/sql-fs/sql-fs.js";
import type { BulkIngestFile, SandboxMeta } from "../../fs/sql-fs/types.js";
import { type AuthVariables, authMiddleware } from "../auth.js";
import { ingestRoutes } from "../routes/ingest.js";
import { SessionManager } from "../session-manager.js";

const AUTH_SECRET = "test-secret-for-ingest-tests-at-least-32bytes!";
const secretBytes = new TextEncoder().encode(AUTH_SECRET);

async function makeToken(sub = "agent-1"): Promise<string> {
	return new SignJWT({ sub }).setProtectedHeader({ alg: "HS256" }).sign(secretBytes);
}

/**
 * Wraps `InMemoryFs` with a `bulkIngest` shim that the route layer expects on
 * an `ICoherentFs`. The implementation just walks the file list with mkdir+writeFile
 * — fast enough for unit tests, and behaviourally equivalent for the assertions
 * we make (file readable, fileCount returned).
 */
function withBulkIngest(fs: IFileSystem): IFileSystem & Pick<ICoherentFs, "bulkIngest"> {
	const bulkIngest = async (files: BulkIngestFile[]): Promise<void> => {
		for (const f of files) {
			const lastSlash = f.path.lastIndexOf("/");
			const parentDir = lastSlash > 0 ? f.path.slice(0, lastSlash) : "/";
			if (parentDir !== "/") {
				try {
					await fs.mkdir(parentDir, { recursive: true });
				} catch (e) {
					const code = (e as Error & { code?: string }).code;
					if (code !== "EEXIST") throw e;
				}
			}
			await fs.writeFile(f.path, f.content);
		}
	};
	return Object.assign(fs, { bulkIngest }) satisfies IFileSystem & Pick<ICoherentFs, "bulkIngest">;
}

function makeTestEnv(): { sessionManager: SessionManager; fs: IFileSystem } {
	const fs = withBulkIngest(new InMemoryFs());
	const sessionManager = new SessionManager({
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

const SANDBOX_ID = "test-sandbox-ingest-abc";

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
		await sessionManager.getOrCreate("default", SANDBOX_ID);

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

		const session = await sessionManager.getOrCreate("default", SANDBOX_ID);
		expect(await session.fs.readFile("/home/user/project/hello.txt")).toBe("hello world");
		expect(await session.fs.readFile("/home/user/project/foo.js")).toBe("console.log('foo');");
		expect(await session.fs.readFile("/home/user/project/sub/bar.md")).toBe("# Bar\nSome content");
	});

	it("invokes bulkIngest exactly once with decoded BulkIngestFile[] (no per-file loop regression)", async () => {
		const fs = withBulkIngest(new InMemoryFs());
		const spy = vi.spyOn(fs, "bulkIngest");
		const sessionManager = new SessionManager({ createFs: async () => fs });
		const app = makeTestApp(sessionManager);
		const token = await makeToken();
		await sessionManager.getOrCreate("default", SANDBOX_ID);

		const files: Record<string, string> = {
			"a.txt": Buffer.from("alpha").toString("base64"),
			"sub/b.txt": Buffer.from("bravo").toString("base64"),
		};

		const res = await app.request(`/v1/sandboxes/${SANDBOX_ID}/ingest-files`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ basePath: "/home/user/project", files }),
		});

		expect(res.status).toBe(200);
		expect(spy).toHaveBeenCalledOnce();

		const arg = spy.mock.calls[0]?.[0] as BulkIngestFile[];
		expect(arg).toHaveLength(2);

		const a = arg.find((f) => f.path === "/home/user/project/a.txt");
		expect(a).toBeDefined();
		expect(new TextDecoder().decode(a!.content)).toBe("alpha");
		expect(a!.mode).toBe(0o644);

		const b = arg.find((f) => f.path === "/home/user/project/sub/b.txt");
		expect(b).toBeDefined();
		expect(new TextDecoder().decode(b!.content)).toBe("bravo");
		expect(b!.mode).toBe(0o644);
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

	it("returns 400 listing offending keys when any file value is not valid base64", async () => {
		const { sessionManager } = makeTestEnv();
		const app = makeTestApp(sessionManager);
		const token = await makeToken();
		await sessionManager.getOrCreate("default", SANDBOX_ID);

		const res = await app.request(`/v1/sandboxes/${SANDBOX_ID}/ingest-files`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({
				basePath: "/home/user/project",
				files: {
					"good.txt": Buffer.from("hello").toString("base64"),
					"bad.txt": "not*valid*base64!!!",
					"truncated.txt": "abc", // length not divisible by 4
				},
			}),
		});

		expect(res.status).toBe(400);
		const body = (await res.json()) as { code: string; details: string[] };
		expect(body.code).toBe("INVALID_INPUT");
		expect(body.details.some((d) => d.includes("invalid base64"))).toBe(true);
		expect(body.details.some((d) => d.includes("bad.txt"))).toBe(true);
		expect(body.details.some((d) => d.includes("truncated.txt"))).toBe(true);
	});

	it("returns 404 for non-existent sandbox", async () => {
		const { sessionManager } = makeTestEnv();
		const app = makeTestApp(sessionManager);
		const token = await makeToken();

		const res = await app.request("/v1/sandboxes/00000000-0000-0000-0000-000000000000/ingest-files", {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({
				basePath: "/home/user",
				files: { "a.txt": Buffer.from("hello").toString("base64") },
			}),
		});

		expect(res.status).toBe(404);
	});

	it("unauthenticated request returns 401", async () => {
		const { sessionManager } = makeTestEnv();
		const app = makeTestApp(sessionManager);

		const res = await app.request(`/v1/sandboxes/${SANDBOX_ID}/ingest-files`, {
			method: "POST",
		});

		expect(res.status).toBe(401);
	});

	it("returns 403 when ingest-files hits a cold replica owned by another caller", async () => {
		const meta = new Map<string, SandboxMeta>();
		const ownerManager = new SessionManager({
			createFs: async () => withBulkIngest(new InMemoryFs()),
			getSandboxMetaFn: async (_tenantId, sandboxId) => meta.get(sandboxId) ?? null,
			persistSandboxMetaFn: async (_tenantId, sandboxId, sandboxMeta) => {
				meta.set(sandboxId, sandboxMeta);
			},
		});
		await ownerManager.withSession("default", SANDBOX_ID, async (session) => {
			session.owner = "agent-1";
			await ownerManager.persistSandboxMeta("default", SANDBOX_ID, {
				owner: "agent-1",
				python: false,
				javascript: false,
			});
		});

		const coldReplica = new SessionManager({
			createFs: async () => withBulkIngest(new InMemoryFs()),
			getSandboxMetaFn: async (_tenantId, sandboxId) => meta.get(sandboxId) ?? null,
		});
		const app = makeTestApp(coldReplica);
		const token = await makeToken("agent-2");

		const res = await app.request(`/v1/sandboxes/${SANDBOX_ID}/ingest-files`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({
				basePath: "/home/user/project",
				files: { "blocked.txt": Buffer.from("denied").toString("base64") },
			}),
		});

		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: string; code: string };
		expect(body).toEqual({ error: "forbidden", code: "FORBIDDEN" });
	});
});

describe("GET /v1/sandboxes/:id/export", () => {
	beforeEach(() => {
		process.env.AUTH_SECRET = AUTH_SECRET;
	});

	afterEach(() => {
		process.env.AUTH_SECRET = "";
	});

	it("write files to sandbox, export, verify response is gzip with correct headers", async () => {
		const { sessionManager } = makeTestEnv();
		const app = makeTestApp(sessionManager);
		const token = await makeToken();

		// Seed files directly into the sandbox FS before exporting
		await sessionManager.withSession("default", SANDBOX_ID, async (session) => {
			await session.fs.mkdir("/home/user", { recursive: true });
			await session.fs.writeFile("/home/user/hello.txt", new TextEncoder().encode("hello world"));
			await session.fs.writeFile("/home/user/foo.js", new TextEncoder().encode("console.log('foo');"));
		});

		const res = await app.request(`/v1/sandboxes/${SANDBOX_ID}/export?basePath=/home/user`, {
			method: "GET",
			headers: { Authorization: `Bearer ${token}` },
		});

		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("application/gzip");
		expect(res.headers.get("Content-Disposition")).toBe("attachment; filename=export.tar.gz");

		// Verify body is a valid gzip archive (magic bytes 0x1f 0x8b)
		const bytes = new Uint8Array(await res.arrayBuffer());
		expect(bytes[0]).toBe(0x1f);
		expect(bytes[1]).toBe(0x8b);

		// Verify contents by extracting on the host
		const tmpDir = mkdtempSync(path.join(os.tmpdir(), "export-test-"));
		try {
			const archivePath = path.join(tmpDir, "export.tar.gz");
			writeFileSync(archivePath, Buffer.from(bytes));
			execSync(`tar -xzf '${archivePath}' -C '${tmpDir}'`);
			expect(readFileSync(path.join(tmpDir, "hello.txt"), "utf-8")).toBe("hello world");
			expect(readFileSync(path.join(tmpDir, "foo.js"), "utf-8")).toBe("console.log('foo');");
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("returns 404 when basePath does not exist in sandbox", async () => {
		const { sessionManager } = makeTestEnv();
		const app = makeTestApp(sessionManager);
		const token = await makeToken();
		// Pre-create sandbox so "sandbox not found" is not the reason for 404
		await sessionManager.getOrCreate("default", SANDBOX_ID);

		const res = await app.request(`/v1/sandboxes/${SANDBOX_ID}/export?basePath=/nonexistent/path`, {
			method: "GET",
			headers: { Authorization: `Bearer ${token}` },
		});

		expect(res.status).toBe(404);
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("ENOENT");
	});

	it("returns 404 for non-existent sandbox", async () => {
		const { sessionManager } = makeTestEnv();
		const app = makeTestApp(sessionManager);
		const token = await makeToken();

		const res = await app.request("/v1/sandboxes/00000000-0000-0000-0000-000000000000/export", {
			method: "GET",
			headers: { Authorization: `Bearer ${token}` },
		});

		expect(res.status).toBe(404);
	});

	it("unauthenticated request returns 401", async () => {
		const { sessionManager } = makeTestEnv();
		const app = makeTestApp(sessionManager);

		const res = await app.request(`/v1/sandboxes/${SANDBOX_ID}/export`, {
			method: "GET",
		});

		expect(res.status).toBe(401);
	});
});

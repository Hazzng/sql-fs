/**
 * PATCH /v1/sandboxes/:id/files/*path — exact-string edit.
 *
 * The uniqueness rule carries the weight here: an ambiguous `oldString` must be refused
 * rather than applied to an arbitrary occurrence, and every rejection must leave the file
 * byte-identical.
 */

import { Hono } from "hono";
import { SignJWT } from "jose";
import { InMemoryFs } from "just-bash";
import type { IFileSystem } from "just-bash";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AuthVariables, authMiddleware } from "../../auth.js";
import { fileRoutes } from "../../routes/files.js";
import { SessionManager } from "../../session-manager.js";

const AUTH_SECRET = "test-secret-for-edit-tests-at-least-32bytes!";
const SANDBOX_ID = "test-sandbox-edit-abc";
const secretBytes = new TextEncoder().encode(AUTH_SECRET);

async function makeToken(sub = "agent-1"): Promise<string> {
	return new SignJWT({ sub }).setProtectedHeader({ alg: "HS256" }).sign(secretBytes);
}

async function makeEnv(): Promise<{ app: Hono<{ Variables: AuthVariables }>; fs: IFileSystem; token: string }> {
	const fs = new InMemoryFs();
	const sessionManager = new SessionManager({ createFs: async () => fs });
	await sessionManager.getOrCreate("default", SANDBOX_ID, undefined, "agent-1");
	const app = new Hono<{ Variables: AuthVariables }>();
	app.use("/v1/*", authMiddleware);
	app.route("/v1/sandboxes", fileRoutes(sessionManager));
	return { app, fs, token: await makeToken() };
}

async function json(res: Response): Promise<Record<string, unknown>> {
	return (await res.json()) as Record<string, unknown>;
}

async function edit(
	app: Hono<{ Variables: AuthVariables }>,
	token: string,
	path: string,
	body: Record<string, unknown>,
): Promise<Response> {
	return app.request(`/v1/sandboxes/${SANDBOX_ID}/files/${path}`, {
		method: "PATCH",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("PATCH /v1/sandboxes/:id/files/*path", () => {
	beforeEach(() => {
		// stubEnv so the suite restores whatever AUTH_SECRET the process already had.
		vi.stubEnv("AUTH_SECRET", AUTH_SECRET);
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("replaces a unique occurrence and reports the new size", async () => {
		const { app, fs, token } = await makeEnv();
		await fs.writeFile("/src/app.ts", "const port = 3000;\nexport default port;\n");

		const res = await edit(app, token, "src/app.ts", { oldString: "3000", newString: "8080" });

		expect(res.status).toBe(200);
		expect(await json(res)).toEqual({ path: "/src/app.ts", replacements: 1, size: 40 });
		expect(await fs.readFile("/src/app.ts")).toBe("const port = 8080;\nexport default port;\n");
	});

	it("deletes the matched text when newString is empty", async () => {
		const { app, fs, token } = await makeEnv();
		await fs.writeFile("/a.txt", "keep REMOVE keep");

		const res = await edit(app, token, "a.txt", { oldString: " REMOVE", newString: "" });

		expect(res.status).toBe(200);
		expect(await fs.readFile("/a.txt")).toBe("keep keep");
	});

	it("rejects an ambiguous match and leaves the file untouched", async () => {
		const { app, fs, token } = await makeEnv();
		const original = "let x = 1;\nlet y = 1;\n";
		await fs.writeFile("/dup.ts", original);

		const res = await edit(app, token, "dup.ts", { oldString: "1", newString: "2" });

		expect(res.status).toBe(409);
		expect(await json(res)).toEqual({
			error: "old_string_not_unique",
			code: "EDIT_NOT_UNIQUE",
			details: ["oldString appears 2 times; pass replaceAll or include more context"],
		});
		expect(await fs.readFile("/dup.ts")).toBe(original);
	});

	it("replaces every occurrence when replaceAll is set", async () => {
		const { app, fs, token } = await makeEnv();
		await fs.writeFile("/dup.ts", "let x = 1;\nlet y = 1;\n");

		const res = await edit(app, token, "dup.ts", { oldString: "1", newString: "2", replaceAll: true });

		expect(res.status).toBe(200);
		expect((await json(res)).replacements).toBe(2);
		expect(await fs.readFile("/dup.ts")).toBe("let x = 2;\nlet y = 2;\n");
	});

	it("returns EDIT_NO_MATCH when oldString is absent and leaves the file untouched", async () => {
		const { app, fs, token } = await makeEnv();
		await fs.writeFile("/a.txt", "content");

		const res = await edit(app, token, "a.txt", { oldString: "missing", newString: "x" });

		expect(res.status).toBe(409);
		expect((await json(res)).code).toBe("EDIT_NO_MATCH");
		expect(await fs.readFile("/a.txt")).toBe("content");
	});

	it("returns 404 when the file does not exist", async () => {
		const { app, token } = await makeEnv();

		const res = await edit(app, token, "nope.txt", { oldString: "a", newString: "b" });

		expect(res.status).toBe(404);
		expect((await json(res)).code).toBe("ENOENT");
	});

	it("returns 400 when the path is a directory", async () => {
		const { app, fs, token } = await makeEnv();
		await fs.mkdir("/dir", { recursive: true });

		const res = await edit(app, token, "dir", { oldString: "a", newString: "b" });

		expect(res.status).toBe(400);
		expect((await json(res)).code).toBe("EISDIR");
	});

	it("refuses a file that is not valid UTF-8", async () => {
		const { app, fs, token } = await makeEnv();
		await fs.writeFile("/bin.dat", new Uint8Array([0xff, 0xfe, 0x00, 0x01]));

		const res = await edit(app, token, "bin.dat", { oldString: "a", newString: "b" });

		expect(res.status).toBe(400);
		expect((await json(res)).code).toBe("EDIT_BINARY");
	});

	it("rejects an empty oldString rather than matching everywhere", async () => {
		const { app, fs, token } = await makeEnv();
		await fs.writeFile("/a.txt", "content");

		const res = await edit(app, token, "a.txt", { oldString: "", newString: "x" });

		expect(res.status).toBe(400);
		expect((await json(res)).code).toBe("INVALID_INPUT");
		expect(await fs.readFile("/a.txt")).toBe("content");
	});

	it("rejects an edit whose strings are identical", async () => {
		const { app, fs, token } = await makeEnv();
		await fs.writeFile("/a.txt", "content");

		const res = await edit(app, token, "a.txt", { oldString: "same", newString: "same" });

		expect(res.status).toBe(400);
		expect((await json(res)).details).toEqual(["oldString and newString must differ"]);
	});

	it("treats oldString literally rather than as a pattern", async () => {
		const { app, fs, token } = await makeEnv();
		await fs.writeFile("/re.txt", "a.c and abc\n");

		const res = await edit(app, token, "re.txt", { oldString: "a.c", newString: "X" });

		expect(res.status).toBe(200);
		expect(await fs.readFile("/re.txt")).toBe("X and abc\n");
	});

	it("requires authentication", async () => {
		const { app, fs } = await makeEnv();
		await fs.writeFile("/a.txt", "content");

		const res = await app.request(`/v1/sandboxes/${SANDBOX_ID}/files/a.txt`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ oldString: "content", newString: "x" }),
		});

		expect(res.status).toBe(401);
		expect(await fs.readFile("/a.txt")).toBe("content");
	});
});

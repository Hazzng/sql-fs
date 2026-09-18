/**
 * MCP tool — file_edit.
 *
 * Shares `editFile` with `PATCH /files/*`, so these pin the MCP-facing contract: the JSON
 * envelope, the `ok:false` rejection codes, and that a rejection leaves the file untouched.
 */

import { InMemoryFs } from "just-bash";
import type { IFileSystem } from "just-bash";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerTools } from "../../mcp/tools.js";
import { SessionManager } from "../../session-manager.js";
import { captureToolHandlers, requireHandler } from "../helpers/mcp.js";

const SANDBOX_ID = "mcp-file-edit-sandbox";
const OWNER = "agent-1";

async function makeEnv(): Promise<{
	call: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
	fs: IFileSystem;
}> {
	const fs = new InMemoryFs();
	const sessionManager = new SessionManager({ createFs: async () => fs });
	await sessionManager.getOrCreate("default", SANDBOX_ID, undefined, OWNER);
	const { server, handlers } = captureToolHandlers();
	registerTools(server, sessionManager, OWNER, "default");

	const call = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
		const result = (await requireHandler(handlers, "file_edit")({ id: SANDBOX_ID, ...args }, {})) as {
			content: Array<{ text: string }>;
		};
		const text = result.content[0]?.text;
		if (text === undefined) throw new Error("tool returned no text content");
		return JSON.parse(text) as Record<string, unknown>;
	};
	return { call, fs };
}

describe("MCP tool — file_edit", () => {
	beforeEach(() => {
		// stubEnv so the suite restores whatever AUTH_SECRET the process already had.
		vi.stubEnv("AUTH_SECRET", "test-secret-mcp-file-edit-at-least-32b!!");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("replaces a unique occurrence and reports the result", async () => {
		const { call, fs } = await makeEnv();
		await fs.writeFile("/src/app.ts", "const port = 3000;\n");

		const result = await call({ path: "/src/app.ts", oldString: "3000", newString: "8080" });

		expect(result).toEqual({ ok: true, path: "/src/app.ts", replacements: 1, size: 19 });
		expect(await fs.readFile("/src/app.ts")).toBe("const port = 8080;\n");
	});

	it("normalizes a relative path to an absolute sandbox path", async () => {
		const { call, fs } = await makeEnv();
		await fs.writeFile("/a.txt", "one");

		const result = await call({ path: "a.txt", oldString: "one", newString: "two" });

		expect(result.ok).toBe(true);
		expect(result.path).toBe("/a.txt");
		expect(await fs.readFile("/a.txt")).toBe("two");
	});

	it("contains a traversing path inside the sandbox", async () => {
		const { call, fs } = await makeEnv();
		await fs.writeFile("/outside.txt", "one");

		// The filesystem resolves `..` against the sandbox root, so neither form escapes it.
		expect((await call({ path: "../outside.txt", oldString: "one", newString: "two" })).ok).toBe(true);
		expect(await fs.readFile("/outside.txt", "utf8")).toBe("two");
		expect((await call({ path: "/../../outside.txt", oldString: "two", newString: "three" })).ok).toBe(true);
		expect(await fs.readFile("/outside.txt", "utf8")).toBe("three");
	});

	it("rejects a path containing a NUL byte and leaves the file untouched", async () => {
		const { call, fs } = await makeEnv();
		await fs.writeFile("/a.txt", "one");

		const result = await call({ path: "/a\0.txt", oldString: "one", newString: "two" });

		expect(result).toEqual({ ok: false, error: "file not found", code: "ENOENT", path: "/a\0.txt" });
		expect(await fs.readFile("/a.txt", "utf8")).toBe("one");
	});

	it("refuses an ambiguous match and leaves the file untouched", async () => {
		const { call, fs } = await makeEnv();
		await fs.writeFile("/dup.ts", "a\na\n");

		const result = await call({ path: "/dup.ts", oldString: "a", newString: "b" });

		expect(result).toEqual({
			ok: false,
			error: "oldString appears 2 times; pass replaceAll or include more context",
			code: "EDIT_NOT_UNIQUE",
			occurrences: 2,
			path: "/dup.ts",
		});
		expect(await fs.readFile("/dup.ts")).toBe("a\na\n");
	});

	it("replaces every occurrence when replaceAll is set", async () => {
		const { call, fs } = await makeEnv();
		await fs.writeFile("/dup.ts", "a\na\n");

		const result = await call({ path: "/dup.ts", oldString: "a", newString: "b", replaceAll: true });

		expect(result.ok).toBe(true);
		expect(result.replacements).toBe(2);
		expect(await fs.readFile("/dup.ts")).toBe("b\nb\n");
	});

	it("reports a missing file rather than creating one", async () => {
		const { call, fs } = await makeEnv();

		const result = await call({ path: "/nope.txt", oldString: "a", newString: "b" });

		expect(result).toMatchObject({ ok: false, code: "ENOENT" });
		expect(await fs.exists("/nope.txt")).toBe(false);
	});

	it("reports EDIT_NO_MATCH when oldString is absent", async () => {
		const { call, fs } = await makeEnv();
		await fs.writeFile("/a.txt", "content");

		const result = await call({ path: "/a.txt", oldString: "missing", newString: "x" });

		expect(result).toMatchObject({ ok: false, code: "EDIT_NO_MATCH" });
		expect(await fs.readFile("/a.txt")).toBe("content");
	});

	it("rejects an edit whose strings are identical", async () => {
		const { call, fs } = await makeEnv();
		await fs.writeFile("/a.txt", "same");

		const result = await call({ path: "/a.txt", oldString: "same", newString: "same" });

		expect(result).toEqual({ ok: false, error: "oldString and newString must differ" });
		expect(await fs.readFile("/a.txt")).toBe("same");
	});
});

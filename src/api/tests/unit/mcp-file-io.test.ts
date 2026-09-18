/**
 * MCP tools — file_read / file_write.
 *
 * These are the shell-free path to file content, so the contract that matters is the JSON
 * envelope, paging bounds, and that non-text files are refused rather than mangled.
 */

import { InMemoryFs } from "just-bash";
import type { IFileSystem } from "just-bash";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerTools } from "../../mcp/tools.js";
import { SessionManager } from "../../session-manager.js";
import { captureToolHandlers, requireHandler } from "../helpers/mcp.js";

const SANDBOX_ID = "mcp-file-io-sandbox";
const OWNER = "agent-1";

async function makeEnv(): Promise<{
	call: (tool: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
	fs: IFileSystem;
}> {
	const fs = new InMemoryFs();
	const sessionManager = new SessionManager({ createFs: async () => fs });
	await sessionManager.getOrCreate("default", SANDBOX_ID, undefined, OWNER);

	const { server, handlers } = captureToolHandlers();
	registerTools(server, sessionManager, OWNER, "default");

	const call = async (tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
		const result = (await requireHandler(handlers, tool)({ id: SANDBOX_ID, ...args }, {})) as {
			content: Array<{ text: string }>;
		};
		const text = result.content[0]?.text;
		if (text === undefined) throw new Error("tool returned no text content");
		return JSON.parse(text) as Record<string, unknown>;
	};
	return { call, fs };
}

describe("MCP tool — file_read", () => {
	beforeEach(() => {
		// stubEnv so the suite restores whatever AUTH_SECRET the process already had.
		vi.stubEnv("AUTH_SECRET", "test-secret-mcp-file-io-at-least-32bytes");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("returns the whole file with its size and line count", async () => {
		const { call, fs } = await makeEnv();
		await fs.writeFile("/src/a.ts", "one\ntwo\nthree\n");

		const result = await call("file_read", { path: "/src/a.ts" });

		expect(result).toEqual({
			ok: true,
			path: "/src/a.ts",
			content: "one\ntwo\nthree\n",
			size: 14,
			totalLines: 4,
			firstLine: 1,
			truncated: false,
		});
	});

	it("contains a traversing path inside the sandbox and rejects a NUL byte", async () => {
		const { call, fs } = await makeEnv();
		await fs.writeFile("/outside.txt", "contained\n");

		// `..` resolves against the sandbox root, so it reads the in-sandbox file, not a host one.
		expect(await call("file_read", { path: "../outside.txt" })).toMatchObject({ ok: true, content: "contained\n" });
		expect(await call("file_read", { path: "/../../outside.txt" })).toMatchObject({ ok: true, content: "contained\n" });
		expect(await call("file_read", { path: "/outside\0.txt" })).toMatchObject({ ok: false, code: "ENOENT" });
	});

	it("pages with offset and limit", async () => {
		const { call, fs } = await makeEnv();
		await fs.writeFile("/a.txt", "l1\nl2\nl3\nl4\nl5\n");

		const result = await call("file_read", { path: "/a.txt", offset: 2, limit: 2 });

		expect(result.content).toBe("l2\nl3");
		expect(result.firstLine).toBe(2);
		expect(result.totalLines).toBe(6);
	});

	it("normalizes a relative path", async () => {
		const { call, fs } = await makeEnv();
		await fs.writeFile("/a.txt", "x");

		const result = await call("file_read", { path: "a.txt" });

		expect(result.ok).toBe(true);
		expect(result.path).toBe("/a.txt");
	});

	it("reports a missing file", async () => {
		const { call } = await makeEnv();

		expect(await call("file_read", { path: "/nope.txt" })).toMatchObject({ ok: false, code: "ENOENT" });
	});

	it("refuses a directory", async () => {
		const { call, fs } = await makeEnv();
		await fs.mkdir("/dir", { recursive: true });

		expect(await call("file_read", { path: "/dir" })).toMatchObject({ ok: false, code: "EISDIR" });
	});

	it("refuses a file that is not valid UTF-8 rather than mangling it", async () => {
		const { call, fs } = await makeEnv();
		await fs.writeFile("/bin.dat", new Uint8Array([0xff, 0xfe, 0x00, 0x01]));

		expect(await call("file_read", { path: "/bin.dat" })).toMatchObject({ ok: false, code: "NOT_TEXT" });
	});

	it("truncates a response that would exceed the wire cap", async () => {
		const { call, fs } = await makeEnv();
		await fs.writeFile("/big.txt", "z".repeat(2 * 1024 * 1024));

		const result = await call("file_read", { path: "/big.txt" });

		expect(result.ok).toBe(true);
		expect(result.truncated).toBe(true);
		expect((result.content as string).length).toBe(1024 * 1024);
		expect(result.size).toBe(2 * 1024 * 1024);
	});
});

describe("MCP tool — file_write", () => {
	beforeEach(() => {
		// stubEnv so the suite restores whatever AUTH_SECRET the process already had.
		vi.stubEnv("AUTH_SECRET", "test-secret-mcp-file-io-at-least-32bytes");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("creates a file and its parent directories", async () => {
		const { call, fs } = await makeEnv();

		const result = await call("file_write", { path: "/deep/nested/a.ts", content: "export const x = 1;\n" });

		expect(result).toEqual({ ok: true, path: "/deep/nested/a.ts", size: 20 });
		expect(await fs.readFile("/deep/nested/a.ts")).toBe("export const x = 1;\n");
	});

	it("overwrites existing content entirely", async () => {
		const { call, fs } = await makeEnv();
		await fs.writeFile("/a.txt", "old content that is longer");

		const result = await call("file_write", { path: "/a.txt", content: "new" });

		expect(result).toMatchObject({ ok: true, size: 3 });
		expect(await fs.readFile("/a.txt")).toBe("new");
	});

	it("writes an empty file", async () => {
		const { call, fs } = await makeEnv();

		expect(await call("file_write", { path: "/empty.txt", content: "" })).toMatchObject({ ok: true, size: 0 });
		expect(await fs.readFile("/empty.txt")).toBe("");
	});

	it("refuses to clobber a directory", async () => {
		const { call, fs } = await makeEnv();
		await fs.mkdir("/dir", { recursive: true });

		expect(await call("file_write", { path: "/dir", content: "x" })).toMatchObject({ ok: false, code: "EISDIR" });
	});

	it("contains a traversing path inside the sandbox", async () => {
		const { call, fs } = await makeEnv();

		expect(await call("file_write", { path: "/../../outside.txt", content: "contained" })).toMatchObject({ ok: true });
		expect(await fs.readFile("/outside.txt")).toBe("contained");
	});

	it("rejects a path containing a NUL byte without creating a file", async () => {
		const { call, fs } = await makeEnv();

		expect(await call("file_write", { path: "/nul\0.txt", content: "x" })).toMatchObject({ ok: false });
		// Neither the literal name nor a NUL-stripped variant may appear.
		expect((await fs.readdir("/")).filter((name) => name.includes("nul"))).toEqual([]);
	});

	it("round-trips content through file_write and file_read", async () => {
		const { call } = await makeEnv();
		const content = "line one\nline two\n\ttabbed\n\"quoted\" and 'single' and $VAR\n";

		await call("file_write", { path: "/rt.txt", content });

		expect((await call("file_read", { path: "/rt.txt" })).content).toBe(content);
	});
});

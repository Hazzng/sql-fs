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
	callRaw: (tool: string, args: Record<string, unknown>) => Promise<string>;
	fs: IFileSystem;
}> {
	const fs = new InMemoryFs();
	const sessionManager = new SessionManager({ createFs: async () => fs });
	await sessionManager.getOrCreate("default", SANDBOX_ID, undefined, OWNER);

	const { server, handlers } = captureToolHandlers();
	registerTools(server, sessionManager, OWNER, "default");

	const callRaw = async (tool: string, args: Record<string, unknown>): Promise<string> => {
		const result = (await requireHandler(handlers, tool)({ id: SANDBOX_ID, ...args }, {})) as {
			content: Array<{ text: string }>;
		};
		const text = result.content[0]?.text;
		if (text === undefined) throw new Error("tool returned no text content");
		return text;
	};
	const call = async (tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> =>
		JSON.parse(await callRaw(tool, args)) as Record<string, unknown>;
	return { call, callRaw, fs };
}

/** What the cap governs: the serialized reply, envelope included. */
const MAX_READ_RESPONSE_BYTES = 1024 * 1024;

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

	// The cap governs the reply, so it is asserted on the serialized envelope: budgeting only the
	// content let the echoed path and metadata push the actual response past it.
	// `editFile` preserves a BOM, so a read that consumed it would strip the marker on the first
	// read-then-write round trip, and every byte offset would sit 3 bytes off the file's own.
	it("keeps a leading UTF-8 BOM in the content it returns", async () => {
		const { call, fs } = await makeEnv();
		const withBom = new TextEncoder().encode("\uFEFFconst port = 3000;\n");
		await fs.writeFile("/bom.ts", withBom);

		const result = await call("file_read", { path: "/bom.ts" });

		expect(result.content).toBe("\uFEFFconst port = 3000;\n");
		expect(result.size).toBe(withBom.byteLength);
		// Round-trips: writing the content back reproduces the file byte for byte.
		expect(Array.from(new TextEncoder().encode(result.content as string))).toEqual(Array.from(withBom));
	});

	// 0, not 1: bare `"".split("\n")` would say 1, and the code this replaced special-cased the empty
	// string to avoid exactly that.
	it("reports an empty file as having no lines", async () => {
		const { call, fs } = await makeEnv();
		await fs.writeFile("/empty.txt", "");

		expect(await call("file_read", { path: "/empty.txt" })).toMatchObject({
			ok: true,
			content: "",
			size: 0,
			totalLines: 0,
			truncated: false,
		});
	});

	// The cap takes any positive integer, so it can sit below the envelope — where the only pages on
	// offer are one over the cap or one whose `nextByteOffset` never advances.
	it("refuses a configured budget too small to hold an envelope", async () => {
		vi.stubEnv("AUTH_SECRET", "test-secret-mcp-file-io-at-least-32bytes");
		vi.stubEnv("MAX_MCP_READ_RESPONSE_BYTES", "50");
		vi.resetModules();
		const { registerTools: registerFresh } = await import("../../mcp/tools.js");

		const fs = new InMemoryFs();
		const sessionManager = new SessionManager({ createFs: async () => fs });
		await sessionManager.getOrCreate("default", SANDBOX_ID, undefined, OWNER);
		const { server, handlers } = captureToolHandlers();
		registerFresh(server, sessionManager, OWNER, "default");
		await fs.writeFile("/x.txt", "hello world");

		const res = (await requireHandler(handlers, "file_read")({ id: SANDBOX_ID, path: "/x.txt" }, {})) as {
			content: Array<{ text: string }>;
		};

		expect(JSON.parse(res.content[0]?.text ?? "")).toMatchObject({
			ok: false,
			code: "RESPONSE_BUDGET_TOO_SMALL",
		});
	});

	it("keeps the whole serialized reply within the wire cap", async () => {
		const { callRaw, fs } = await makeEnv();
		await fs.writeFile("/big.txt", "z".repeat(2 * 1024 * 1024));

		const raw = await callRaw("file_read", { path: "/big.txt" });
		const result = JSON.parse(raw) as Record<string, unknown>;

		expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(MAX_READ_RESPONSE_BYTES);
		expect(result.ok).toBe(true);
		expect(result.truncated).toBe(true);
		expect(result.size).toBe(2 * 1024 * 1024);
		// ASCII, so one char is one byte: the resume offset is where the content stopped.
		expect(result.nextByteOffset).toBe((result.content as string).length);
	});

	it("keeps the reply within the cap when a long path eats into the budget", async () => {
		const { callRaw, fs } = await makeEnv();
		const deep = `/${"d".repeat(200)}/${"e".repeat(200)}`;
		await fs.mkdir(deep, { recursive: true });
		const longPath = `${deep}/${"f".repeat(200)}.txt`;
		await fs.writeFile(longPath, "z".repeat(2 * 1024 * 1024));

		const raw = await callRaw("file_read", { path: longPath });
		const result = JSON.parse(raw) as Record<string, unknown>;

		// A failed read echoes `path` too and is tiny, so the size assertion alone would pass on one:
		// pin the success and the truncation, or a long-path regression hides inside an error reply.
		expect(result.ok).toBe(true);
		expect(result.truncated).toBe(true);
		expect(result.path).toBe(longPath);
		expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(MAX_READ_RESPONSE_BYTES);
	});

	// The reply is serialized again inside the MCP JSON-RPC result, so every backslash the first
	// pass added is escaped a second time. NULs are the worst case: six characters here, seven there.
	it("keeps the twice-escaped reply within the cap for content that escapes badly", async () => {
		const { callRaw, fs } = await makeEnv();
		await fs.writeFile("/nuls.txt", "\0".repeat(2 * 1024 * 1024));

		const raw = await callRaw("file_read", { path: "/nuls.txt" });
		const result = JSON.parse(raw) as Record<string, unknown>;

		expect(result.ok).toBe(true);
		expect(result.truncated).toBe(true);
		// What the transport embeds: this text re-serialized as a JSON string.
		const embedded = Buffer.byteLength(JSON.stringify(raw), "utf8") - 2;
		expect(embedded).toBeLessThanOrEqual(MAX_READ_RESPONSE_BYTES);
	});

	// Lines are counted and located by scanning rather than `split`. These pin the semantics that
	// rewrite has to preserve — the seam is the synthetic empty line after a trailing newline, which
	// starts at the end of the text, so a page ending just before it must still drop its separator.
	it("pages lines exactly as split and join did", async () => {
		const { call, fs } = await makeEnv();
		await fs.writeFile("/lines.txt", "a\nb\nc\nd\n");
		const read = async (args: Record<string, unknown>): Promise<unknown> =>
			(await call("file_read", { path: "/lines.txt", ...args })).content;

		expect(await call("file_read", { path: "/lines.txt" })).toMatchObject({
			totalLines: 5,
			content: "a\nb\nc\nd\n",
		});
		expect(await read({ offset: 2, limit: 2 })).toBe("b\nc");
		expect(await read({ offset: 3 })).toBe("c\nd\n");
		// The page stops before the trailing empty line: no newline of its own.
		expect(await read({ offset: 1, limit: 4 })).toBe("a\nb\nc\nd");
		expect(await read({ offset: 4, limit: 1 })).toBe("d");
		// Reaching past the last line takes the rest of the file, trailing newline included.
		expect(await read({ offset: 1, limit: 5 })).toBe("a\nb\nc\nd\n");
		expect(await read({ offset: 99 })).toBe("");
	});

	it("pages a file of bare newlines the same way", async () => {
		const { call, fs } = await makeEnv();
		await fs.writeFile("/blank.txt", "\n\n\n");
		const read = async (args: Record<string, unknown>): Promise<unknown> =>
			(await call("file_read", { path: "/blank.txt", ...args })).content;

		expect(await read({ offset: 2, limit: 2 })).toBe("\n");
		expect(await read({ offset: 3, limit: 1 })).toBe("");
		expect(await read({ offset: 1, limit: 4 })).toBe("\n\n\n");
	});

	// The allocation this replaced was one array slot per line, so the shape that mattered is a file
	// with a great many of them. Memory is not asserted here — what is asserted is that a file with
	// a million line boundaries is counted and capped correctly rather than by materializing them.
	it("counts a newline-heavy file and still caps the reply", async () => {
		const { call, callRaw, fs } = await makeEnv();
		await fs.writeFile("/many-lines.txt", "\n".repeat(1_000_000));

		const result = await call("file_read", { path: "/many-lines.txt" });
		const raw = await callRaw("file_read", { path: "/many-lines.txt" });

		expect(result.totalLines).toBe(1_000_001);
		expect(result.truncated).toBe(true);
		expect(Buffer.byteLength(JSON.stringify(raw), "utf8") - 2).toBeLessThanOrEqual(MAX_READ_RESPONSE_BYTES);
	});

	it("normalizes the path it echoes rather than replaying the caller's string", async () => {
		const { call, fs } = await makeEnv();
		await fs.writeFile("/f.txt", "hi");

		const result = await call("file_read", { path: `/${"x/../".repeat(500)}f.txt` });

		expect(result.path).toBe("/f.txt");
		expect(result.content).toBe("hi");
	});

	// The cap is in bytes and the paging controls are in lines, so one over-long line would otherwise
	// strand its own tail: every read of that line returns the same prefix, and the next line skips it.
	it("resumes a truncated single line from nextByteOffset", async () => {
		const { call, fs } = await makeEnv();
		const line = "z".repeat(2 * 1024 * 1024);
		await fs.writeFile("/one-line.txt", line);

		let assembled = "";
		let offset: number | undefined;
		let pages = 0;
		let page: Record<string, unknown>;
		do {
			page = await call("file_read", {
				path: "/one-line.txt",
				...(offset === undefined ? {} : { byteOffset: offset }),
			});
			assembled += page.content as string;
			offset = page.nextByteOffset as number | undefined;
			pages += 1;
		} while (page.truncated === true && pages < 10);

		expect(page.truncated).toBe(false);
		expect(page.nextByteOffset).toBeUndefined();
		expect(assembled).toBe(line);
	});

	it("resumes on a codepoint boundary rather than splitting a character", async () => {
		const { call, fs } = await makeEnv();
		// 3 bytes per `€`, so the 1 MiB budget lands mid-character.
		const line = "€".repeat(500 * 1024);
		await fs.writeFile("/euro.txt", line);

		const first = await call("file_read", { path: "/euro.txt" });
		const second = await call("file_read", { path: "/euro.txt", byteOffset: first.nextByteOffset as number });

		expect(first.truncated).toBe(true);
		expect(first.nextByteOffset).toBe(Buffer.byteLength(first.content as string, "utf8"));
		expect((first.content as string) + (second.content as string)).toBe(line);
	});

	// The response is JSON, so the budget has to hold for the escaped form: a NUL is six characters
	// there. Cutting on raw bytes alone would let a megabyte of them leave as six.
	it("keeps the cap on the escaped response, not the raw bytes", async () => {
		const { call, fs } = await makeEnv();
		const line = "\u0000".repeat(1024 * 1024);
		await fs.writeFile("/nuls.txt", line);

		const first = await call("file_read", { path: "/nuls.txt" });

		expect(first.truncated).toBe(true);
		expect(JSON.stringify(first.content as string).length - 2).toBeLessThanOrEqual(1024 * 1024);
		// Still resumable, and the pieces still reassemble.
		let content = first.content as string;
		let next = first.nextByteOffset as number | undefined;
		while (next !== undefined) {
			const page = await call("file_read", { path: "/nuls.txt", byteOffset: next });
			content += page.content as string;
			next = page.nextByteOffset as number | undefined;
		}
		expect(content).toBe(line);
	});

	// U+FFFD is a character a file may legitimately contain; only a cut through a multi-byte
	// character should ever cost one, and cutting on a boundary means none is ever invented.
	it("keeps a U+FFFD the file itself contains at the cut point", async () => {
		const { call, fs } = await makeEnv();
		// Every character is a replacement char, so wherever the budget falls the cut lands on one —
		// the assertion cannot drift with the budget the way a hand-aligned offset would.
		const line = "\uFFFD".repeat(400_000);
		await fs.writeFile("/fffd.txt", line);

		const first = await call("file_read", { path: "/fffd.txt" });

		expect(first.truncated).toBe(true);
		// A trailing U+FFFD that came from the file, not from a character we split.
		expect((first.content as string).endsWith("\uFFFD")).toBe(true);
		const second = await call("file_read", { path: "/fffd.txt", byteOffset: first.nextByteOffset as number });
		expect((first.content as string) + (second.content as string)).toBe(line);
	});

	// nextByteOffset is absolute in the file, so resuming does not depend on the caller repeating
	// the offset/limit that produced the truncated page.
	it("returns a resume offset that is absolute even for a paged read", async () => {
		const { call, fs } = await makeEnv();
		// 1.5 MiB: one page fills the 1 MiB budget, and what is left fits in the resume page.
		const long = "z".repeat(1536 * 1024);
		await fs.writeFile("/paged.txt", `first line\n${long}\n`);

		const page = await call("file_read", { path: "/paged.txt", offset: 2, limit: 1 });
		const rest = await call("file_read", { path: "/paged.txt", byteOffset: page.nextByteOffset as number });

		expect(page.truncated).toBe(true);
		expect(rest.truncated).toBe(false);
		// Absolute: the skipped first line plus what this page returned (ASCII, one byte per char).
		expect(page.nextByteOffset).toBe("first line\n".length + (page.content as string).length);
		expect((page.content as string) + (rest.content as string)).toBe(`${long}\n`);
	});

	it("snaps a hand-written byteOffset back to the start of the character it lands inside", async () => {
		const { call, fs } = await makeEnv();
		await fs.writeFile("/euro-small.txt", "a€b");

		// Byte 2 is the middle of `€` (bytes 1-3); the read resumes at the character, not inside it.
		const result = await call("file_read", { path: "/euro-small.txt", byteOffset: 2 });

		expect(result.content).toBe("€b");
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

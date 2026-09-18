/**
 * `editFile` byte-level contract: an edit rewrites what it matched and nothing else, and it
 * refuses a result it cannot legally write *before* building it. Both surfaces share this code,
 * so these pin behaviour the HTTP and MCP suites only see through their envelopes.
 */

import { InMemoryFs } from "just-bash";
import { describe, expect, it } from "vitest";
import { REPLACE_FLUSH_PIECES, editFile } from "../../lib/file-ops.js";
import type { Session } from "../../session-manager.js";

const MAX = 1024;

/** editFile only touches `fs` and `scriptTx`; an undefined scriptTx is the in-memory path. */
function makeSession(fs: InMemoryFs): Session {
	return { fs, scriptTx: undefined } as unknown as Session;
}

describe("editFile", () => {
	it("keeps the UTF-8 BOM a file started with", async () => {
		const fs = new InMemoryFs();
		await fs.writeFile("/bom.ts", new TextEncoder().encode("﻿const port = 3000;\n"));

		const outcome = await editFile(makeSession(fs), "/bom.ts", { oldString: "3000", newString: "8080" }, MAX);

		expect(outcome).toEqual({ kind: "ok", replacements: 1, size: 22 });
		// Compared as bytes: reading it back as a string would drop the very marker under test.
		expect(Array.from(await fs.readFileBuffer("/bom.ts"))).toEqual(
			Array.from(new TextEncoder().encode("﻿const port = 8080;\n")),
		);
	});

	it("keeps a non-default file mode", async () => {
		const fs = new InMemoryFs();
		await fs.writeFile("/deploy.sh", "echo old\n");
		await fs.chmod("/deploy.sh", 0o755);

		const outcome = await editFile(makeSession(fs), "/deploy.sh", { oldString: "old", newString: "new" }, MAX);

		expect(outcome).toEqual({ kind: "ok", replacements: 1, size: 9 });
		expect((await fs.stat("/deploy.sh")).mode).toBe(0o755);
	});

	it("reports the byte size of a multibyte replacement", async () => {
		const fs = new InMemoryFs();
		await fs.writeFile("/a.txt", "abc");

		const outcome = await editFile(makeSession(fs), "/a.txt", { oldString: "b", newString: "é" }, MAX);

		expect(outcome).toEqual({ kind: "ok", replacements: 1, size: 4 });
	});

	it("refuses an edit whose result would exceed the limit and leaves the file untouched", async () => {
		const fs = new InMemoryFs();
		await fs.writeFile("/a.txt", "abc");

		const outcome = await editFile(makeSession(fs), "/a.txt", { oldString: "b", newString: "x".repeat(20) }, 8);

		expect(outcome).toEqual({ kind: "too_large" });
		expect(await fs.readFile("/a.txt", "utf8")).toBe("abc");
	});

	it("counts every occurrence of a replaceAll edit against the limit", async () => {
		const fs = new InMemoryFs();
		await fs.writeFile("/a.txt", "aaaa");

		const outcome = await editFile(
			makeSession(fs),
			"/a.txt",
			{ oldString: "a", newString: "bbb", replaceAll: true },
			8,
		);

		expect(outcome).toEqual({ kind: "too_large" });
		expect(await fs.readFile("/a.txt", "utf8")).toBe("aaaa");
	});

	// The replacement is built in flushed chunks. These pin the seams that shape can get wrong:
	// matches either side of a flush, adjacent matches, and matches touching both ends of the file.
	it("replaces every occurrence across the chunk-flush boundary", async () => {
		const fs = new InMemoryFs();
		// Derived, not literal: a raised flush threshold must not quietly stop crossing a boundary.
		const count = REPLACE_FLUSH_PIECES;
		await fs.writeFile("/many.txt", "ab".repeat(count));

		const outcome = await editFile(
			makeSession(fs),
			"/many.txt",
			{ oldString: "a", newString: "X", replaceAll: true },
			MAX * 8,
		);

		expect(outcome).toEqual({ kind: "ok", replacements: count, size: count * 2 });
		expect(await fs.readFile("/many.txt", "utf8")).toBe("Xb".repeat(count));
	});

	it("replaces adjacent matches at both ends of the file", async () => {
		const fs = new InMemoryFs();
		await fs.writeFile("/edges.txt", "aabaa");

		const outcome = await editFile(
			makeSession(fs),
			"/edges.txt",
			{ oldString: "a", newString: "z", replaceAll: true },
			MAX,
		);

		expect(outcome).toEqual({ kind: "ok", replacements: 4, size: 5 });
		expect(await fs.readFile("/edges.txt", "utf8")).toBe("zzbzz");
	});

	// A lone surrogate matches half of a supplementary character. Re-encoding the result turns the
	// orphaned half into U+FFFD — rewriting bytes the edit never matched — and the size projection,
	// which assumes a match encodes to the bytes it replaces, was off by two per occurrence: a
	// 400-byte file of emoji edited under a 420-byte limit wrote 500 bytes and reported "ok".
	it("refuses an edit whose oldString would cut a character in half", async () => {
		const fs = new InMemoryFs();
		const emoji = "\u{1F600}".repeat(100);
		await fs.writeFile("/emoji.txt", emoji);

		const outcome = await editFile(
			makeSession(fs),
			"/emoji.txt",
			{ oldString: "\uD83D", newString: "aa", replaceAll: true },
			420,
		);

		expect(outcome).toEqual({ kind: "lone_surrogate" });
		expect(await fs.readFile("/emoji.txt", "utf8")).toBe(emoji);
	});

	it("refuses a newString carrying a lone surrogate", async () => {
		const fs = new InMemoryFs();
		await fs.writeFile("/t.txt", "hello");

		const outcome = await editFile(makeSession(fs), "/t.txt", { oldString: "hello", newString: "\uDE00" }, MAX);

		expect(outcome).toEqual({ kind: "lone_surrogate" });
		expect(await fs.readFile("/t.txt", "utf8")).toBe("hello");
	});

	it("still edits a whole supplementary character", async () => {
		const fs = new InMemoryFs();
		await fs.writeFile("/emoji2.txt", "a\u{1F600}b");

		const outcome = await editFile(makeSession(fs), "/emoji2.txt", { oldString: "\u{1F600}", newString: "!" }, MAX);

		expect(outcome).toEqual({ kind: "ok", replacements: 1, size: 3 });
		expect(await fs.readFile("/emoji2.txt", "utf8")).toBe("a!b");
	});

	it("refuses a file already past the limit without reading it", async () => {
		const fs = new InMemoryFs();
		await fs.writeFile("/big.txt", "x".repeat(100));
		let reads = 0;
		const counting = new Proxy(fs, {
			get(target, prop) {
				if (prop === "readFileBuffer") reads += 1;
				const value = Reflect.get(target, prop, target);
				return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
			},
		}) as InMemoryFs;

		const outcome = await editFile(makeSession(counting), "/big.txt", { oldString: "x", newString: "y" }, 50);

		expect(outcome).toEqual({ kind: "too_large" });
		expect(reads).toBe(0);
	});
});

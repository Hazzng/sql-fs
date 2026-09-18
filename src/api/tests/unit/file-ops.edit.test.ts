/**
 * `editFile` byte-level contract: an edit rewrites what it matched and nothing else, and it
 * refuses a result it cannot legally write *before* building it. Both surfaces share this code,
 * so these pin behaviour the HTTP and MCP suites only see through their envelopes.
 */

import { InMemoryFs } from "just-bash";
import { describe, expect, it } from "vitest";
import { editFile } from "../../lib/file-ops.js";
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

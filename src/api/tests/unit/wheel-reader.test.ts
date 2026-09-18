/**
 * Wheel reader — well-formed archives: stored and deflated entries, ZIP64 size
 * fields, mode normalisation, `.data/` subtrees and batch boundaries.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type WheelFile, readWheel } from "../../commands/wheel-reader.js";
import { buildWheel, unixMode } from "./wheel-fixtures.js";

async function collect(wheel: Uint8Array, options = {}): Promise<{ files: WheelFile[]; batches: number }> {
	const files: WheelFile[] = [];
	let batches = 0;
	for await (const batch of readWheel(wheel, options)) {
		batches += 1;
		files.push(...batch);
	}
	return { files, batches };
}

function sha256Hex(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

describe("readWheel — well-formed archives", () => {
	it("yields every stored entry with verified content and hashes", async () => {
		const { files } = await collect(buildWheel({ files: { "demo/mod.py": "print('hi')\n" } }));

		expect(files.map((f) => f.path).sort()).toEqual([
			"demo-1.0.dist-info/METADATA",
			"demo-1.0.dist-info/RECORD",
			"demo-1.0.dist-info/WHEEL",
			"demo/__init__.py",
			"demo/mod.py",
		]);
		const mod = files.find((f) => f.path === "demo/mod.py")!;
		expect(Buffer.from(mod.content).toString("utf8")).toBe("print('hi')\n");
		expect(Buffer.from(mod.sha256).toString("hex")).toBe(sha256Hex("print('hi')\n"));
		expect(mod.size).toBe(12);
	});

	it("inflates deflated entries", async () => {
		const body = "a".repeat(5000);
		const { files } = await collect(buildWheel({ files: { "demo/big.py": body }, method: 8 }));

		const big = files.find((f) => f.path === "demo/big.py")!;
		expect(Buffer.from(big.content).toString("utf8")).toBe(body);
		expect(big.size).toBe(5000);
	});

	it("reads sizes from the ZIP64 extra field", async () => {
		const wheel = buildWheel({
			files: { "demo/z.py": "zip64\n" },
			entryOverrides: { "demo/z.py": { zip64: true, method: 8 } },
		});

		const { files } = await collect(wheel);

		const entry = files.find((f) => f.path === "demo/z.py")!;
		expect(Buffer.from(entry.content).toString("utf8")).toBe("zip64\n");
		expect(entry.size).toBe(6);
	});

	it("normalises modes to 0o644 and 0o755", async () => {
		const wheel = buildWheel({
			files: { "demo/script.sh": "#!/bin/sh\n", "demo/plain.py": "x\n" },
			entryOverrides: {
				"demo/script.sh": { externalAttrs: unixMode(0o100777) },
				"demo/plain.py": { externalAttrs: unixMode(0o100666) },
			},
		});

		const { files } = await collect(wheel);

		expect(files.find((f) => f.path === "demo/script.sh")!.mode).toBe(0o755);
		expect(files.find((f) => f.path === "demo/plain.py")!.mode).toBe(0o644);
	});

	it("keeps .data/ subtrees verbatim", async () => {
		const wheel = buildWheel({ files: { "demo-1.0.data/scripts/demo": "#!/usr/bin/env python\n" } });

		const { files } = await collect(wheel);

		expect(files.map((f) => f.path)).toContain("demo-1.0.data/scripts/demo");
	});

	it("splits output into batches bounded by entry count", async () => {
		const files: Record<string, string> = {};
		for (let i = 0; i < 10; i++) files[`demo/m${i}.py`] = `v = ${i}\n`;

		const result = await collect(buildWheel({ files }), { maxBatchEntries: 4 });

		expect(result.batches).toBe(4);
		expect(result.files.length).toBe(14);
	});

	it("splits output into batches bounded by inflated bytes", async () => {
		const files: Record<string, string> = {};
		for (let i = 0; i < 4; i++) files[`demo/m${i}.py`] = "x".repeat(1000);

		const result = await collect(buildWheel({ files }), { maxBatchBytes: 1500 });

		// Two 1000-byte files per batch, then one final batch of the metadata files.
		expect(result.batches).toBe(3);
	});

	it("returns the archive totals when the generator completes", async () => {
		const iterator = readWheel(buildWheel({ files: { "demo/mod.py": "ab\n" } }));
		let next = await iterator.next();
		while (next.done !== true) next = await iterator.next();

		expect(next.value.distInfoDir).toBe("demo-1.0.dist-info");
		expect(next.value.fileCount).toBe(5);
		expect(next.value.totalBytes).toBeGreaterThan(0);
	});

	it("accepts an empty file", async () => {
		const { files } = await collect(buildWheel({ files: { "demo/empty.py": "" } }));

		const empty = files.find((f) => f.path === "demo/empty.py")!;
		expect(empty.size).toBe(0);
		expect(empty.content.byteLength).toBe(0);
	});

	it("accepts explicit directory entries", async () => {
		const wheel = buildWheel({ extraEntries: [{ name: "demo/sub/", externalAttrs: unixMode(0o040755) }] });

		const { files } = await collect(wheel);

		expect(files.map((f) => f.path)).not.toContain("demo/sub");
	});
});

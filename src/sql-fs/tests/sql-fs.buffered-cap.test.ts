/**
 * #166 — the buffer cap, the fail-closed guards, and the paths deliberately left
 * out of the buffered shape.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createEdriverfault } from "../errors.js";
import { SqlFs } from "../sql-fs.js";
import { type DialectProbe, makeProbeDialect } from "./fixtures/buffered-dialect.js";

async function newFs(probe: DialectProbe, maxOps: number, maxBytes: number): Promise<SqlFs> {
	const fs = new SqlFs({
		dialect: probe.dialect,
		sandboxId: "s-cap",
		scriptTxBuffer: { enabled: true, maxOps, maxBytes },
	});
	await fs.ready();
	probe.windows.length = 0;
	probe.calls.length = 0;
	return fs;
}

describe("buffered script-tx — cap", () => {
	let probe: DialectProbe;

	beforeEach(() => {
		probe = makeProbeDialect();
	});

	it("throws ESCRIPTBUFFER on the operation that crosses the op cap", async () => {
		const fs = await newFs(probe, 2, 1 << 20);
		fs.beginScriptScope();
		await fs.writeFile("/home/user/a.txt", "a");
		await fs.writeFile("/home/user/b.txt", "b");
		await expect(fs.writeFile("/home/user/c.txt", "c")).rejects.toMatchObject({ code: "ESCRIPTBUFFER" });
	});

	it("throws ESCRIPTBUFFER on the byte cap", async () => {
		const fs = await newFs(probe, 1_000_000, 300);
		fs.beginScriptScope();
		await fs.writeFile("/home/user/a.txt", "a");
		await expect(fs.writeFile("/home/user/b.txt", "b")).rejects.toMatchObject({ code: "ESCRIPTBUFFER" });
	});

	it("applies nothing at the cap — no transaction is ever opened", async () => {
		const fs = await newFs(probe, 1, 1 << 20);
		fs.beginScriptScope();
		await fs.writeFile("/home/user/a.txt", "a");
		await expect(fs.writeFile("/home/user/b.txt", "b")).rejects.toMatchObject({ code: "ESCRIPTBUFFER" });

		await expect(fs.endScriptScope()).rejects.toMatchObject({ code: "ESCRIPTBUFFER" });
		expect(probe.dialect.writeFileComposite).not.toHaveBeenCalled();
		expect(fs.getAllPaths()).not.toContain("/home/user/a.txt");
	});

	it("condemns the scope so the truncated prefix cannot be flushed", async () => {
		const fs = await newFs(probe, 1, 1 << 20);
		fs.beginScriptScope();
		await fs.writeFile("/home/user/a.txt", "a");
		await expect(fs.writeFile("/home/user/b.txt", "b")).rejects.toMatchObject({ code: "ESCRIPTBUFFER" });

		// bash swallows a rejected fs call into a nonzero exit and keeps going: every
		// later operation in the scope, read or write, must fail too.
		await expect(fs.writeFile("/home/user/c.txt", "c")).rejects.toMatchObject({ code: "ESCRIPTBUFFER" });
		await expect(fs.readFile("/home/user/file.txt")).rejects.toMatchObject({ code: "ESCRIPTBUFFER" });
		expect(() => fs.getAllPaths()).toThrow(/ESCRIPTBUFFER/);
	});

	it("does not fire below the cap", async () => {
		const fs = await newFs(probe, 3, 1 << 20);
		fs.beginScriptScope();
		await fs.writeFile("/home/user/a.txt", "a");
		await fs.writeFile("/home/user/b.txt", "b");
		await fs.writeFile("/home/user/c.txt", "c");
		await fs.endScriptScope();
		expect(probe.dialect.writeFileComposite).toHaveBeenCalledTimes(3);
	});

	it("resets the budget for the next scope", async () => {
		const fs = await newFs(probe, 2, 1 << 20);
		fs.beginScriptScope();
		await fs.writeFile("/home/user/a.txt", "a");
		await fs.writeFile("/home/user/b.txt", "b");
		await fs.endScriptScope();

		fs.beginScriptScope();
		await fs.writeFile("/home/user/c.txt", "c");
		await fs.writeFile("/home/user/d.txt", "d");
		await expect(fs.endScriptScope()).resolves.toBeUndefined();
	});
});

describe("buffered script-tx — fail-closed guards", () => {
	let probe: DialectProbe;

	beforeEach(() => {
		probe = makeProbeDialect();
	});

	it("discards the buffer and refuses to flush after a driver fault", async () => {
		const fs = await newFs(probe, 1000, 1 << 20);
		fs.beginScriptScope();
		await fs.writeFile("/home/user/a.txt", "a");

		const fault = createEdriverfault(new Error("socket write after close"));
		(probe.dialect.commitBlob as unknown as { mockRejectedValueOnce(e: Error): void }).mockRejectedValueOnce(fault);
		await expect(fs.writeFile("/home/user/b.txt", "b")).rejects.toMatchObject({ code: "EDRIVERFAULT" });

		await expect(fs.endScriptScope()).rejects.toMatchObject({ code: "EDRIVERFAULT" });
		expect(probe.dialect.writeFileComposite).not.toHaveBeenCalled();
	});

	it("refuses bulkIngest inside a buffered scope rather than splitting the script", async () => {
		const fs = await newFs(probe, 1000, 1 << 20);
		fs.beginScriptScope();
		await expect(
			fs.bulkIngest([{ path: "/home/user/x.txt", content: new Uint8Array([1]), mode: 0o644 }]),
		).rejects.toMatchObject({ code: "ENOTSUP" });
		expect(probe.dialect.bulkIngest).not.toHaveBeenCalled();
		await fs.abortScriptScope();
	});

	it("allows bulkIngest outside a scope, where every caller actually uses it", async () => {
		const fs = await newFs(probe, 1000, 1 << 20);
		await fs.bulkIngest([{ path: "/home/user/x.txt", content: new Uint8Array([1]), mode: 0o644 }]);
		expect(probe.dialect.bulkIngest).toHaveBeenCalledTimes(1);
	});
});

/**
 * SqlFs serves `/dev/null` as a virtual device (vercel-labs/just-bash#558): writes
 * vanish, reads are empty, and nothing reaches the journal, the caches or the DB.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { readOnlyContext } from "../../../api/read-only-context.js";
import { SqlFs } from "../../sql-fs.js";
import { BUFFER_ON, type DialectProbe, makeProbeDialect } from "../fixtures/buffered-dialect.js";

describe("SqlFs — virtual /dev/null", () => {
	let probe: DialectProbe;
	let fs: SqlFs;

	beforeEach(async () => {
		probe = makeProbeDialect();
		fs = new SqlFs({ dialect: probe.dialect, sandboxId: "s-devnull", scriptTxBuffer: BUFFER_ON });
		await fs.ready();
		probe.calls.length = 0;
	});

	it("discards writeFile without a dialect call", async () => {
		await fs.writeFile("/dev/null", "data");
		expect(probe.calls).toEqual([]);
		expect(await fs.readFile("/dev/null")).toBe("");
	});

	it("discards appendFile without a dialect call", async () => {
		await fs.appendFile("/dev/null", "data");
		expect(probe.calls).toEqual([]);
		expect(await fs.readFileBuffer("/dev/null")).toEqual(new Uint8Array(0));
	});

	it("leaves a script scope with nothing to flush", async () => {
		probe.windows.length = 0;
		fs.beginScriptScope();
		await fs.writeFile("/dev/null", "data");
		await fs.appendFile("/dev/null", "more");
		await fs.endScriptScope();
		expect(fs.wasDirty()).toBe(false);
		expect(probe.windows).toEqual([]);
		expect(probe.calls).toEqual([]);
	});

	it("accepts writes inside a read-only scope", async () => {
		fs.beginReadOnlyScope();
		const ctx = { violated: false };
		try {
			await readOnlyContext.run(ctx, () => fs.writeFile("/dev/null", "data"));
		} finally {
			fs.endReadOnlyScope();
		}
		expect(ctx.violated).toBe(false);
	});

	it("stats as an empty file", async () => {
		const st = await fs.stat("/dev/null");
		expect({
			isFile: st.isFile,
			isDirectory: st.isDirectory,
			isSymbolicLink: st.isSymbolicLink,
			size: st.size,
		}).toEqual({
			isFile: true,
			isDirectory: false,
			isSymbolicLink: false,
			size: 0,
		});
		expect(await fs.lstat("/dev/null")).toEqual(st);
	});

	it("exists and resolves to itself", async () => {
		expect(await fs.exists("/dev/null")).toBe(true);
		expect(await fs.realpath("/dev/null")).toBe("/dev/null");
	});

	it("is not listed among the sandbox's paths", () => {
		expect(fs.getAllPaths()).not.toContain("/dev/null");
		expect(fs.getAllPaths()).not.toContain("/dev");
	});
});

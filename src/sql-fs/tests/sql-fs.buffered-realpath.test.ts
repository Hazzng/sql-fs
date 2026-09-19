/**
 * #166 — read-your-own-writes for path resolution inside a buffered scope.
 *
 * `realpath` and the symlink branch of the read path resolved through
 * `dialect.resolvePath` and then matched the returned id against the pathCache.
 * Under buffering that is wrong twice over: the database has not seen the
 * script's journaled mutations, and pathCache ids are provisional placeholders
 * that can never equal a database id, so the match would miss even if the
 * lookup succeeded. Both now read the pathCache, which is authoritative for the
 * scope.
 *
 * Asserting only the returned path would be weak — a stale resolver that
 * happened to return the right id would pass. Each test also asserts that
 * `dialect.resolvePath` was never called, which is the actual behaviour change.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { SqlFs } from "../sql-fs.js";
import { BUFFER_ON, type DialectProbe, makeProbeDialect } from "./fixtures/buffered-dialect.js";

async function newFs(probe: DialectProbe, buffered: boolean): Promise<SqlFs> {
	const fs = new SqlFs({
		dialect: probe.dialect,
		sandboxId: "s-166-realpath",
		...(buffered ? { scriptTxBuffer: BUFFER_ON } : {}),
	});
	await fs.ready();
	probe.calls.length = 0;
	return fs;
}

describe("buffered script-tx — realpath reads the pathCache, not the database", () => {
	let probe: DialectProbe;

	beforeEach(() => {
		probe = makeProbeDialect();
	});

	it("resolves a directory created earlier in the same scope", async () => {
		const fs = await newFs(probe, true);
		fs.beginScriptScope();
		await fs.mkdir("/home/user/new", { recursive: true });

		await expect(fs.realpath("/home/user/new")).resolves.toBe("/home/user/new");
		expect(probe.dialect.resolvePath).not.toHaveBeenCalled();

		await fs.endScriptScope();
	});

	it("resolves a file written earlier in the same scope", async () => {
		const fs = await newFs(probe, true);
		fs.beginScriptScope();
		await fs.writeFile("/home/user/f.txt", "x");

		await expect(fs.realpath("/home/user/f.txt")).resolves.toBe("/home/user/f.txt");
		expect(probe.dialect.resolvePath).not.toHaveBeenCalled();

		await fs.endScriptScope();
	});

	it("resolves a path moved earlier in the same scope, and refuses its old name", async () => {
		const fs = await newFs(probe, true);
		fs.beginScriptScope();
		await fs.writeFile("/home/user/before.txt", "x");
		await fs.mv("/home/user/before.txt", "/home/user/after.txt");

		await expect(fs.realpath("/home/user/after.txt")).resolves.toBe("/home/user/after.txt");
		await expect(fs.realpath("/home/user/before.txt")).rejects.toMatchObject({ code: "ENOENT" });
		expect(probe.dialect.resolvePath).not.toHaveBeenCalled();

		await fs.endScriptScope();
	});

	it("still refuses a path that was never created", async () => {
		const fs = await newFs(probe, true);
		fs.beginScriptScope();

		await expect(fs.realpath("/home/user/absent")).rejects.toMatchObject({ code: "ENOENT" });
		expect(probe.dialect.resolvePath).not.toHaveBeenCalled();

		await fs.endScriptScope();
	});

	// Negative guard, not a fix-prover: outside a scope the database IS current, so
	// the dialect remains the right resolver and must still be consulted.
	it("outside a scope it still resolves through the dialect", async () => {
		const fs = await newFs(probe, true);
		await fs.writeFile("/home/user/outside.txt", "x");
		probe.calls.length = 0;

		await fs.realpath("/home/user/outside.txt").catch(() => undefined);
		expect(probe.dialect.resolvePath).toHaveBeenCalled();
	});
});

/**
 * #166 — provisional inode ids: minting, cross-op resolution, and the post-flush sweep.
 *
 * A buffered script needs inode ids before the flush creates them. These assert the
 * ids the script sees are replaced by the real ones and that a negative id can never
 * survive a scope — it would key a contentCache entry no inode owns and would be
 * published into the Redis path snapshot.
 */

import { beforeEach, describe, expect, it, type vi } from "vitest";
import { SqlFs } from "../sql-fs.js";
import { BUFFER_ON, type DialectProbe, makeProbeDialect } from "./fixtures/buffered-dialect.js";

async function newFs(probe: DialectProbe): Promise<SqlFs> {
	const fs = new SqlFs({ dialect: probe.dialect, sandboxId: "s-ids", scriptTxBuffer: BUFFER_ON });
	await fs.ready();
	probe.windows.length = 0;
	probe.calls.length = 0;
	probe.createdIds.length = 0;
	probe.compositeParents.length = 0;
	return fs;
}

/** pathCache inode id for a path, via the internal accessor the snapshot writer uses. */
function inodeOf(fs: SqlFs, path: string): bigint | undefined {
	return fs._getPathCache().get(path)?.inodeId;
}

describe("buffered script-tx — provisional inode ids", () => {
	let probe: DialectProbe;

	beforeEach(() => {
		probe = makeProbeDialect();
	});

	it("hands the script a negative id and replaces it with the real one at flush", async () => {
		const fs = await newFs(probe);
		fs.beginScriptScope();
		await fs.writeFile("/home/user/a.txt", "a");

		const provisional = inodeOf(fs, "/home/user/a.txt")!;
		expect(provisional).toBeLessThan(0n);

		await fs.endScriptScope();
		expect(inodeOf(fs, "/home/user/a.txt")).toBe(probe.createdIds[0]);
		expect(inodeOf(fs, "/home/user/a.txt")).toBeGreaterThan(0n);
	});

	it("resolves a parent created earlier in the same script to its real id", async () => {
		const fs = await newFs(probe);
		fs.beginScriptScope();
		await fs.mkdir("/home/user/d");
		const dirProvisional = inodeOf(fs, "/home/user/d")!;
		await fs.writeFile("/home/user/d/a.txt", "a");
		await fs.endScriptScope();

		const realDirId = probe.createdIds[0]!;
		expect(dirProvisional).toBeLessThan(0n);
		// The composite must have been handed the id the mkdir replay produced, not
		// the placeholder the script was given.
		expect(probe.compositeParents).toEqual([3n, realDirId]);
		expect(inodeOf(fs, "/home/user/d")).toBe(realDirId);
	});

	it("moves the content cache onto the real id so a later read still hits", async () => {
		const fs = await newFs(probe);
		fs.beginScriptScope();
		await fs.writeFile("/home/user/a.txt", "cached");
		// Mid-script the bytes are keyed by the placeholder — that is what the flush
		// has to move, and asserting it here is what makes this test fail if nothing
		// is being buffered at all.
		const provisional = inodeOf(fs, "/home/user/a.txt")!;
		expect(provisional).toBeLessThan(0n);
		expect(fs._getContentCache().get(provisional)).toEqual(new TextEncoder().encode("cached"));
		await fs.endScriptScope();

		const realId = probe.createdIds[0]!;
		expect(fs._getContentCache().get(provisional)).toBeUndefined();
		expect(fs._getContentCache().get(realId)).toEqual(new TextEncoder().encode("cached"));
		expect([...fs._getContentCache().keys()].every((k) => k > 0n)).toBe(true);
		expect(await fs.readFile("/home/user/a.txt")).toBe("cached");
		expect(probe.dialect.getBlobNoTx).not.toHaveBeenCalled();
	});

	it("leaves no negative id anywhere in the caches after a scope", async () => {
		const fs = new SqlFs({
			dialect: probe.dialect,
			sandboxId: "s-ids",
			scriptTxBuffer: BUFFER_ON,
			allowSymlinks: true,
		});
		await fs.ready();
		fs.beginScriptScope();
		await fs.mkdir("/home/user/d");
		await fs.writeFile("/home/user/d/a.txt", "a");
		await fs.cp("/home/user/d", "/home/user/d2", { recursive: true });
		await fs.symlink("/home/user/d/a.txt", "/home/user/link");

		// There has to be something to sweep, or the sweep proves nothing: every path
		// this script created must be on a placeholder id right now.
		const created = ["/home/user/d", "/home/user/d/a.txt", "/home/user/d2", "/home/user/d2/a.txt", "/home/user/link"];
		for (const path of created) {
			expect(inodeOf(fs, path), `${path} was not buffered`).toBeLessThan(0n);
		}

		await fs.endScriptScope();

		for (const [path, entry] of fs._getPathCache()) {
			expect(entry.inodeId, `${path} kept a provisional id`).toBeGreaterThan(0n);
		}
	});

	it("fails the request rather than publishing a path the replay produced no row for", async () => {
		const fs = await newFs(probe);
		// Divergence: the composite reports success but returns no id, so the path the
		// cache claims exists has no inode behind it.
		(probe.dialect.writeFileComposite as ReturnType<typeof vi.fn>).mockImplementation(async () => undefined);

		fs.beginScriptScope();
		await fs.writeFile("/home/user/ghost.txt", "a");
		await expect(fs.endScriptScope()).rejects.toMatchObject({ code: "ECOHERENCE" });

		// The recovery reload ran, so the phantom path is gone rather than left behind
		// on a negative id.
		expect(fs.getAllPaths()).not.toContain("/home/user/ghost.txt");
	});

	it("never reuses a provisional id across scopes", async () => {
		const fs = await newFs(probe);
		fs.beginScriptScope();
		await fs.writeFile("/home/user/a.txt", "a");
		const first = inodeOf(fs, "/home/user/a.txt")!;
		await fs.abortScriptScope();

		fs.beginScriptScope();
		await fs.writeFile("/home/user/b.txt", "b");
		const second = inodeOf(fs, "/home/user/b.txt")!;
		await fs.endScriptScope();

		expect(first).toBeLessThan(0n);
		expect(second).toBeLessThan(first);
	});

	it("keeps hardlink siblings pointing at the same real inode", async () => {
		const fs = await newFs(probe);
		fs.beginScriptScope();
		await fs.writeFile("/home/user/a.txt", "a");
		await fs.link("/home/user/a.txt", "/home/user/b.txt");
		const provisional = inodeOf(fs, "/home/user/a.txt")!;
		expect(provisional).toBeLessThan(0n);
		expect(inodeOf(fs, "/home/user/b.txt")).toBe(provisional);
		await fs.endScriptScope();

		const real = probe.createdIds[0]!;
		expect(inodeOf(fs, "/home/user/a.txt")).toBe(real);
		expect(inodeOf(fs, "/home/user/b.txt")).toBe(real);
	});

	it("rewrites a moved subtree onto the ids the flush created", async () => {
		const fs = await newFs(probe);
		fs.beginScriptScope();
		await fs.mkdir("/home/user/src");
		await fs.writeFile("/home/user/src/a.txt", "a");
		await fs.mkdir("/home/user/dst");
		await fs.mv("/home/user/src", "/home/user/dst/src");
		// The subtree carries placeholder ids through the move; the flush has to rewrite
		// them at their NEW paths.
		expect(inodeOf(fs, "/home/user/dst/src")).toBeLessThan(0n);
		expect(inodeOf(fs, "/home/user/dst/src/a.txt")).toBeLessThan(0n);
		await fs.endScriptScope();

		expect(inodeOf(fs, "/home/user/dst/src")).toBe(probe.createdIds[0]);
		expect(inodeOf(fs, "/home/user/dst/src/a.txt")).toBe(probe.createdIds[1]);
	});
});

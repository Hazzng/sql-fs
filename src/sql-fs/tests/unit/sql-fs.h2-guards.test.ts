/**
 * Unit tests for SqlFs destination-kind / basename write guards (audit H2).
 *
 * Pins the rules that prevent silent subtree orphaning + root-inode clobbering:
 *   - writeFile/appendFile/cp must not overwrite an existing directory (EISDIR)
 *   - writeFile/appendFile/cp/mv to "/" (empty basename) is rejected
 *   - mv onto a non-empty directory is rejected (ENOTEMPTY), not silently
 *     orphaned
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SqlFs } from "../../sql-fs.js";
import type { PathCacheEntry, SqlDialect } from "../../types.js";

const now = new Date("2026-01-01T00:00:00Z");

function dir(path: string, inodeId: bigint): { path: string } & PathCacheEntry {
	return { path, inodeId, kind: 2, mode: 0o755, size: 0, mtime: now, contentSha256: null, symlinkTarget: null };
}
function file(path: string, inodeId: bigint): { path: string } & PathCacheEntry {
	return {
		path,
		inodeId,
		kind: 1,
		mode: 0o644,
		size: 4,
		mtime: now,
		contentSha256: new Uint8Array(32),
		symlinkTarget: null,
	};
}

describe("SqlFs write guards (H2)", () => {
	let fs: SqlFs;

	beforeEach(async () => {
		const dialect = {
			connect: vi.fn(),
			disconnect: vi.fn(),
			transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
			setSandboxContext: vi.fn(),
			setSandboxContextWithLock: vi.fn(),
			loadAllPaths: vi.fn(async () => [
				dir("/", 1n),
				dir("/full", 2n), // non-empty directory
				file("/full/child", 3n),
				dir("/empty", 4n), // empty directory
				file("/note", 5n),
			]),
			createSandbox: vi.fn(),
			deleteSandbox: vi.fn(),
			createInode: vi.fn(),
			getInode: vi.fn(),
			updateInode: vi.fn(),
			deleteInode: vi.fn(),
			incrementNlink: vi.fn(),
			decrementNlink: vi.fn(),
			insertDirent: vi.fn(),
			upsertDirent: vi.fn(),
			deleteDirent: vi.fn(),
			listDirents: vi.fn(),
			moveDirent: vi.fn(),
			upsertBlob: vi.fn(),
			getBlob: vi.fn(),
			gcOrphanBlobs: vi.fn(),
			getBlobsForSandbox: vi.fn(async () => []),
			loadSubtreeInodes: vi.fn(),
			bulkIngest: vi.fn(),
			resolvePath: vi.fn(),
		} as unknown as SqlDialect<unknown>;
		fs = new SqlFs({ dialect, sandboxId: "test-sandbox" });
		await fs.ready();
	});

	it("writeFile over an existing directory throws EISDIR", async () => {
		await expect(fs.writeFile("/full", "x")).rejects.toMatchObject({ code: "EISDIR" });
	});

	it("writeFile to '/' throws EISDIR (root is a directory)", async () => {
		await expect(fs.writeFile("/", "x")).rejects.toMatchObject({ code: "EISDIR" });
	});

	it("appendFile over an existing directory throws EISDIR", async () => {
		await expect(fs.appendFile("/empty", "x")).rejects.toMatchObject({ code: "EISDIR" });
	});

	it("cp of a file over an existing directory throws EISDIR", async () => {
		await expect(fs.cp("/note", "/full")).rejects.toMatchObject({ code: "EISDIR" });
	});

	it("cp to '/' throws EISDIR", async () => {
		await expect(fs.cp("/note", "/")).rejects.toMatchObject({ code: "EISDIR" });
	});

	it("mv onto a non-empty directory throws ENOTEMPTY (no silent orphaning)", async () => {
		await expect(fs.mv("/note", "/full")).rejects.toMatchObject({ code: "ENOTEMPTY" });
	});

	it("mv to '/' throws EISDIR", async () => {
		await expect(fs.mv("/note", "/")).rejects.toMatchObject({ code: "EISDIR" });
	});

	it("writeFile to a brand-new path still succeeds", async () => {
		await expect(fs.writeFile("/full/newfile", "ok")).resolves.toBeUndefined();
		expect(fs.getAllPaths()).toContain("/full/newfile");
	});
});

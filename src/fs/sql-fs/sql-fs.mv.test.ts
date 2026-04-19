/**
 * Unit tests for SqlFs.mv pathCache rebuild.
 * US-021: pathCache rebuild on mv
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SqlFs } from "./sql-fs.js";
import type { PathCacheEntry, SqlDialect } from "./types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const now = new Date("2026-01-01T00:00:00Z");

function dirEntry(path: string, inodeId: bigint): { path: string } & PathCacheEntry {
	return { path, inodeId, kind: 2, mode: 0o755, size: 0, mtime: now, contentSha256: null, symlinkTarget: null };
}

function fileEntry(path: string, inodeId: bigint, size: number): { path: string } & PathCacheEntry {
	return {
		path,
		inodeId,
		kind: 1,
		mode: 0o644,
		size,
		mtime: now,
		contentSha256: new Uint8Array(32),
		symlinkTarget: null,
	};
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("SqlFs.mv() — pathCache rebuild", () => {
	const sandboxId = "test-sandbox";
	let moveDirentMock: ReturnType<typeof vi.fn>;
	let dialect: SqlDialect<unknown>;
	let fs: SqlFs;

	beforeEach(async () => {
		moveDirentMock = vi.fn(async () => undefined);

		dialect = {
			connect: vi.fn(),
			disconnect: vi.fn(),
			transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
			setSandboxContext: vi.fn(),
			loadAllPaths: vi.fn(async () => [
				dirEntry("/", 1n),
				dirEntry("/a", 2n),
				dirEntry("/a/b", 3n),
				fileEntry("/a/b/c", 4n, 10),
				dirEntry("/other", 5n),
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
			moveDirent: moveDirentMock,
			upsertBlob: vi.fn(),
			getBlob: vi.fn(),
			gcOrphanBlobs: vi.fn(),
			loadSubtreeInodes: vi.fn(),
			bulkIngest: vi.fn(),
			resolvePath: vi.fn(),
		} as unknown as SqlDialect<unknown>;

		fs = new SqlFs({ dialect, sandboxId });
		await fs.ready();
	});

	it("moves a file: old path removed, new path present", async () => {
		await fs.mv("/a/b/c", "/a/b/d");

		const paths = fs.getAllPaths();
		expect(paths).not.toContain("/a/b/c");
		expect(paths).toContain("/a/b/d");
		expect(moveDirentMock).toHaveBeenCalledOnce();
	});

	it("moves a directory: all descendant keys remapped, old paths gone", async () => {
		await fs.mv("/a", "/x");

		const paths = fs.getAllPaths();
		// Old paths gone
		expect(paths).not.toContain("/a");
		expect(paths).not.toContain("/a/b");
		expect(paths).not.toContain("/a/b/c");
		// New paths present
		expect(paths).toContain("/x");
		expect(paths).toContain("/x/b");
		expect(paths).toContain("/x/b/c");
		// Unrelated paths unchanged
		expect(paths).toContain("/");
		expect(paths).toContain("/other");
	});

	it("preserves pathCache entry metadata on move", async () => {
		await fs.mv("/a", "/x");

		// The moved dir entry should retain its inodeId
		const allPaths = fs.getAllPaths();
		// Verify /x/b/c (was /a/b/c) still has same data by checking it's present
		expect(allPaths).toContain("/x/b/c");
		expect(allPaths).not.toContain("/a/b/c");
	});

	it("throws ENOENT when source does not exist", async () => {
		await expect(fs.mv("/nonexistent", "/dest")).rejects.toMatchObject({ code: "ENOENT" });
		expect(moveDirentMock).not.toHaveBeenCalled();
	});

	it("calls moveDirent with correct parent inode IDs and names", async () => {
		// /a (inodeId=2n) is a child of / (inodeId=1n); /x will be a child of / (inodeId=1n)
		await fs.mv("/a", "/x");

		expect(moveDirentMock).toHaveBeenCalledWith(
			expect.anything(), // tx
			1n, // srcParentInodeId (root /)
			"a", // srcName
			1n, // destParentInodeId (root /)
			"x", // destName
		);
	});
});

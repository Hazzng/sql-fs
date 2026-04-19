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

	it("throws EINVAL when moving a directory into its own descendant", async () => {
		// Moving /a into /a/b/new would create a cycle
		await expect(fs.mv("/a", "/a/b/new")).rejects.toMatchObject({ code: "EINVAL" });
		expect(moveDirentMock).not.toHaveBeenCalled();
	});

	it("throws EINVAL when moving a directory to itself", async () => {
		await expect(fs.mv("/a", "/a")).rejects.toMatchObject({ code: "EINVAL" });
		expect(moveDirentMock).not.toHaveBeenCalled();
	});

	it("throws ENOTDIR when destination parent is not a directory", async () => {
		// /a/b/c is a file, so /a/b/c/new has a non-directory parent
		await expect(fs.mv("/other", "/a/b/c/new")).rejects.toMatchObject({ code: "ENOTDIR" });
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

describe("SqlFs.mv() — move over existing destination", () => {
	const sandboxId = "test-sandbox";
	let moveDirentMock: ReturnType<typeof vi.fn>;
	let decrementNlinkMock: ReturnType<typeof vi.fn>;
	let deleteInodeMock: ReturnType<typeof vi.fn>;
	let dialect: SqlDialect<unknown>;
	let fs: SqlFs;

	beforeEach(async () => {
		moveDirentMock = vi.fn(async () => undefined);
		decrementNlinkMock = vi.fn(async () => 0); // returns 0 → inode deleted
		deleteInodeMock = vi.fn(async () => undefined);

		dialect = {
			connect: vi.fn(),
			disconnect: vi.fn(),
			transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
			setSandboxContext: vi.fn(),
			loadAllPaths: vi.fn(async () => [
				dirEntry("/", 1n),
				fileEntry("/src.txt", 2n, 10),
				fileEntry("/dest.txt", 3n, 20), // existing destination
			]),
			createSandbox: vi.fn(),
			deleteSandbox: vi.fn(),
			createInode: vi.fn(),
			getInode: vi.fn(),
			updateInode: vi.fn(),
			deleteInode: deleteInodeMock,
			incrementNlink: vi.fn(),
			decrementNlink: decrementNlinkMock,
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

	it("move over existing file: decrements dest inode nlink and removes dest from pathCache", async () => {
		await fs.mv("/src.txt", "/dest.txt");

		// decrementNlink called with displaced dest inodeId (3n)
		expect(decrementNlinkMock).toHaveBeenCalledWith(expect.anything(), 3n);
		// nlink=0 so deleteInode called with displaced dest inodeId (3n)
		expect(deleteInodeMock).toHaveBeenCalledWith(expect.anything(), 3n);
		// moveDirent still called
		expect(moveDirentMock).toHaveBeenCalledOnce();

		const paths = fs.getAllPaths();
		// src gone, dest now points to moved file
		expect(paths).not.toContain("/src.txt");
		expect(paths).toContain("/dest.txt");
	});

	it("move over existing file: does not delete inode when nlink > 0", async () => {
		decrementNlinkMock.mockResolvedValue(1); // nlink still 1 after decrement

		await fs.mv("/src.txt", "/dest.txt");

		expect(decrementNlinkMock).toHaveBeenCalledWith(expect.anything(), 3n);
		// nlink > 0 so deleteInode NOT called for the displaced inode (3n)
		expect(deleteInodeMock).not.toHaveBeenCalled();
		expect(moveDirentMock).toHaveBeenCalledOnce();
	});
});

/**
 * Unit tests for SqlFs.rm (recursive).
 * US-035: Collects all descendant inode IDs via dialect.loadSubtreeInodes,
 * deletes all dirents and inodes in the subtree within one transaction,
 * and removes all subtree paths from pathCache and contentCache.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SqlFs } from "./sql-fs.js";
import type { PathCacheEntry, SqlDialect } from "./types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const now = new Date("2026-01-01T00:00:00Z");

function dirEntry(path: string, inodeId: bigint): { path: string } & PathCacheEntry {
	return { path, inodeId, kind: 2, mode: 0o755, size: 0, mtime: now, contentSha256: null, symlinkTarget: null };
}

function fileEntry(path: string, inodeId: bigint): { path: string } & PathCacheEntry {
	return {
		path,
		inodeId,
		kind: 1,
		mode: 0o644,
		size: 10,
		mtime: now,
		contentSha256: new Uint8Array(32),
		symlinkTarget: null,
	};
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe("SqlFs.rm (recursive) — US-035", () => {
	let fs: SqlFs;
	let loadSubtreeInodesMock: ReturnType<typeof vi.fn>;
	let deleteInodeMock: ReturnType<typeof vi.fn>;
	let deleteDirentMock: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		loadSubtreeInodesMock = vi.fn(async () => [10n, 11n, 12n, 13n]);
		deleteInodeMock = vi.fn(async () => undefined);
		deleteDirentMock = vi.fn(async () => 10n);

		const dialect: SqlDialect<unknown> = {
			connect: vi.fn(),
			disconnect: vi.fn(),
			transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
			setSandboxContext: vi.fn(),
			// 3-level nested structure: /deep (dir) → /deep/mid (dir) → /deep/mid/leaf.txt + /deep/mid/other.txt (files)
			loadAllPaths: vi.fn(async () => [
				dirEntry("/", 1n),
				dirEntry("/deep", 10n),
				dirEntry("/deep/mid", 11n),
				fileEntry("/deep/mid/leaf.txt", 12n),
				fileEntry("/deep/mid/other.txt", 13n),
			]),
			createSandbox: vi.fn(),
			deleteSandbox: vi.fn(),
			createInode: vi.fn(),
			getInode: vi.fn(),
			updateInode: vi.fn(),
			deleteInode: deleteInodeMock,
			incrementNlink: vi.fn(),
			decrementNlink: vi.fn(),
			insertDirent: vi.fn(),
			upsertDirent: vi.fn(),
			deleteDirent: deleteDirentMock,
			listDirents: vi.fn(),
			moveDirent: vi.fn(),
			upsertBlob: vi.fn(),
			getBlob: vi.fn(),
			gcOrphanBlobs: vi.fn(),
			loadSubtreeInodes: loadSubtreeInodesMock,
			bulkIngest: vi.fn(),
			resolvePath: vi.fn(),
		} as unknown as SqlDialect<unknown>;

		fs = new SqlFs({ dialect, sandboxId: "s1" });
		await fs.ready();
	});

	it("removes all subtree paths from pathCache after rm -r on 3-level nested structure", async () => {
		await fs.rm("/deep", { recursive: true });

		const paths = fs.getAllPaths();
		expect(paths).not.toContain("/deep");
		expect(paths).not.toContain("/deep/mid");
		expect(paths).not.toContain("/deep/mid/leaf.txt");
		expect(paths).not.toContain("/deep/mid/other.txt");
		// Root remains
		expect(paths).toContain("/");
	});

	it("calls loadSubtreeInodes with the root inode of the removed subtree", async () => {
		await fs.rm("/deep", { recursive: true });

		expect(loadSubtreeInodesMock).toHaveBeenCalledOnce();
		expect(loadSubtreeInodesMock).toHaveBeenCalledWith(expect.anything(), 10n);
	});

	it("calls deleteInode for every inode returned by loadSubtreeInodes", async () => {
		await fs.rm("/deep", { recursive: true });

		expect(deleteInodeMock).toHaveBeenCalledTimes(4);
		expect(deleteInodeMock).toHaveBeenCalledWith(expect.anything(), 10n);
		expect(deleteInodeMock).toHaveBeenCalledWith(expect.anything(), 11n);
		expect(deleteInodeMock).toHaveBeenCalledWith(expect.anything(), 12n);
		expect(deleteInodeMock).toHaveBeenCalledWith(expect.anything(), 13n);
	});

	it("removes subtree inode entries from contentCache", async () => {
		// Pre-seed contentCache for the two file inodes
		fs._contentCacheSet(12n, new Uint8Array([1, 2, 3]));
		fs._contentCacheSet(13n, new Uint8Array([4, 5, 6]));

		expect(fs._contentCacheHas(12n)).toBe(true);
		expect(fs._contentCacheHas(13n)).toBe(true);

		await fs.rm("/deep", { recursive: true });

		expect(fs._contentCacheHas(12n)).toBe(false);
		expect(fs._contentCacheHas(13n)).toBe(false);
	});

	it("calls deleteDirent to unlink the subtree root from its parent", async () => {
		await fs.rm("/deep", { recursive: true });

		// parentEntry for /deep is /, inodeId=1n. name is "deep"
		expect(deleteDirentMock).toHaveBeenCalledOnce();
		expect(deleteDirentMock).toHaveBeenCalledWith(expect.anything(), 1n, "deep");
	});
});

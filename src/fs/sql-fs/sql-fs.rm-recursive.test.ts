/**
 * Unit tests for SqlFs.rm (recursive) — hardlink-safe post-order deletion.
 * US-042b: rm -r decrements nlink per dirent, only deletes inodes when nlink=0,
 * preserving files still referenced by hardlinks outside the subtree.
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

// ── Standard recursive rm ─────────────────────────────────────────────────────

describe("SqlFs.rm (recursive) — post-order hardlink-safe deletion", () => {
	let fs: SqlFs;
	let decrementNlinkMock: ReturnType<typeof vi.fn>;
	let deleteInodeMock: ReturnType<typeof vi.fn>;
	let deleteDirentMock: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		decrementNlinkMock = vi.fn(async () => 0); // nlink reaches 0 → inode deleted
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
			decrementNlink: decrementNlinkMock,
			insertDirent: vi.fn(),
			upsertDirent: vi.fn(),
			deleteDirent: deleteDirentMock,
			listDirents: vi.fn(),
			moveDirent: vi.fn(),
			upsertBlob: vi.fn(),
			getBlob: vi.fn(),
			gcOrphanBlobs: vi.fn(),
			loadSubtreeInodes: vi.fn(),
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

	it("removes subtree inode entries from contentCache", async () => {
		fs._contentCacheSet(12n, new Uint8Array([1, 2, 3]));
		fs._contentCacheSet(13n, new Uint8Array([4, 5, 6]));

		expect(fs._contentCacheHas(12n)).toBe(true);
		expect(fs._contentCacheHas(13n)).toBe(true);

		await fs.rm("/deep", { recursive: true });

		expect(fs._contentCacheHas(12n)).toBe(false);
		expect(fs._contentCacheHas(13n)).toBe(false);
	});

	it("calls deleteDirent to unlink root from parent and each child from its subtree parent", async () => {
		await fs.rm("/deep", { recursive: true });

		// 4 deleteDirent calls: root unlink + one per non-root entry
		// root unlink: (parentOf /deep = /) inodeId=1n, name="deep"
		expect(deleteDirentMock).toHaveBeenCalledWith(expect.anything(), 1n, "deep");
		// leaf.txt: parent is /deep/mid (inodeId=11n)
		expect(deleteDirentMock).toHaveBeenCalledWith(expect.anything(), 11n, "leaf.txt");
		// other.txt: parent is /deep/mid (inodeId=11n)
		expect(deleteDirentMock).toHaveBeenCalledWith(expect.anything(), 11n, "other.txt");
		// mid: parent is /deep (inodeId=10n)
		expect(deleteDirentMock).toHaveBeenCalledWith(expect.anything(), 10n, "mid");
		expect(deleteDirentMock).toHaveBeenCalledTimes(4);
	});

	it("calls decrementNlink once per entry in the subtree", async () => {
		await fs.rm("/deep", { recursive: true });

		expect(decrementNlinkMock).toHaveBeenCalledTimes(4);
		expect(decrementNlinkMock).toHaveBeenCalledWith(expect.anything(), 10n);
		expect(decrementNlinkMock).toHaveBeenCalledWith(expect.anything(), 11n);
		expect(decrementNlinkMock).toHaveBeenCalledWith(expect.anything(), 12n);
		expect(decrementNlinkMock).toHaveBeenCalledWith(expect.anything(), 13n);
	});

	it("deletes all inodes when nlink reaches zero", async () => {
		await fs.rm("/deep", { recursive: true });

		expect(deleteInodeMock).toHaveBeenCalledTimes(4);
		expect(deleteInodeMock).toHaveBeenCalledWith(expect.anything(), 10n);
		expect(deleteInodeMock).toHaveBeenCalledWith(expect.anything(), 11n);
		expect(deleteInodeMock).toHaveBeenCalledWith(expect.anything(), 12n);
		expect(deleteInodeMock).toHaveBeenCalledWith(expect.anything(), 13n);
	});
});

// ── Hardlink safety ───────────────────────────────────────────────────────────

describe("SqlFs.rm (recursive) — hardlink preservation", () => {
	let fs: SqlFs;
	let decrementNlinkMock: ReturnType<typeof vi.fn>;
	let deleteInodeMock: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		// file_b (inodeId=12n) has nlink=2: one dirent inside subtree, one outside
		decrementNlinkMock = vi.fn(async (_tx: unknown, inodeId: bigint) => {
			// Simulate: inodeId=12n has an external hardlink → nlink goes 2→1 (not 0)
			if (inodeId === 12n) return 1;
			return 0;
		});
		deleteInodeMock = vi.fn(async () => undefined);

		const dialect: SqlDialect<unknown> = {
			connect: vi.fn(),
			disconnect: vi.fn(),
			transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
			setSandboxContext: vi.fn(),
			loadAllPaths: vi.fn(async () => [
				dirEntry("/", 1n),
				dirEntry("/dir", 10n),
				fileEntry("/dir/file_a.txt", 11n), // nlink=1, only inside subtree
				fileEntry("/dir/file_b.txt", 12n), // nlink=2, also linked from /external.txt
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
			deleteDirent: vi.fn(async () => 11n),
			listDirents: vi.fn(),
			moveDirent: vi.fn(),
			upsertBlob: vi.fn(),
			getBlob: vi.fn(),
			gcOrphanBlobs: vi.fn(),
			loadSubtreeInodes: vi.fn(),
			bulkIngest: vi.fn(),
			resolvePath: vi.fn(),
		} as unknown as SqlDialect<unknown>;

		fs = new SqlFs({ dialect, sandboxId: "s1" });
		await fs.ready();
	});

	it("does NOT delete inode still referenced by external hardlink (nlink > 0)", async () => {
		await fs.rm("/dir", { recursive: true });

		// file_a (nlink→0): deleteInode MUST be called
		expect(deleteInodeMock).toHaveBeenCalledWith(expect.anything(), 11n);
		// file_b (nlink→1): deleteInode must NOT be called
		expect(deleteInodeMock).not.toHaveBeenCalledWith(expect.anything(), 12n);
	});

	it("removes subtree paths from pathCache even when inode is preserved", async () => {
		await fs.rm("/dir", { recursive: true });

		const paths = fs.getAllPaths();
		expect(paths).not.toContain("/dir");
		expect(paths).not.toContain("/dir/file_a.txt");
		expect(paths).not.toContain("/dir/file_b.txt");
	});
});

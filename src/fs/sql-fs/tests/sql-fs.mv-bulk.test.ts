import { beforeEach, describe, expect, it, vi } from "vitest";
import { SqlFs } from "../sql-fs.js";
import type { PathCacheEntry, SqlDialect } from "../types.js";

const now = new Date("2026-01-01T00:00:00Z");

function dirEntry(path: string, inodeId: bigint): { path: string } & PathCacheEntry {
	return { path, inodeId, kind: 2, mode: 0o755, size: 0, mtime: now, contentSha256: null, symlinkTarget: null };
}

function fileEntry(path: string, inodeId: bigint, size = 10): { path: string } & PathCacheEntry {
	return {
		path,
		inodeId,
		kind: 1,
		mode: 0o644,
		size,
		mtime: now,
		contentSha256: new Uint8Array(32).fill(0xab),
		symlinkTarget: null,
	};
}

describe("SqlFs.mvBulk()", () => {
	let moveDirentMock: ReturnType<typeof vi.fn>;
	let decrementNlinkMock: ReturnType<typeof vi.fn>;
	let deleteInodeMock: ReturnType<typeof vi.fn>;
	let transactionMock: ReturnType<typeof vi.fn>;
	let dialect: SqlDialect<unknown>;
	let fs: SqlFs;

	beforeEach(async () => {
		moveDirentMock = vi.fn(async () => undefined);
		decrementNlinkMock = vi.fn(async () => 0);
		deleteInodeMock = vi.fn(async () => undefined);
		transactionMock = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({}));

		dialect = {
			connect: vi.fn(),
			disconnect: vi.fn(),
			transaction: transactionMock,
			setSandboxContext: vi.fn(),
			setSandboxContextWithLock: vi.fn(),
			loadAllPaths: vi.fn(async () => [
				dirEntry("/", 1n),
				dirEntry("/a", 2n),
				dirEntry("/a/sub", 3n),
				fileEntry("/a/sub/f1.txt", 4n),
				fileEntry("/b.txt", 5n),
				fileEntry("/c.txt", 6n),
				fileEntry("/d.txt", 7n),
				dirEntry("/dest", 8n),
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
			getBlobsForSandbox: vi.fn(async () => []),
			loadSubtreeInodes: vi.fn(),
			bulkIngest: vi.fn(),
			resolvePath: vi.fn(),
		} as unknown as SqlDialect<unknown>;

		fs = new SqlFs({ dialect, sandboxId: "s1" });
		await fs.ready();
		transactionMock.mockClear();
	});

	it("empty array returns immediately, no transaction", async () => {
		await fs.mvBulk([]);
		expect(transactionMock).not.toHaveBeenCalled();
	});

	it("single pair delegates to mv()", async () => {
		await fs.mvBulk([{ src: "/b.txt", dest: "/dest/b.txt" }]);

		expect(moveDirentMock).toHaveBeenCalledOnce();
		expect(fs.getAllPaths()).toContain("/dest/b.txt");
		expect(fs.getAllPaths()).not.toContain("/b.txt");
	});

	it("moves 3 files in one transaction", async () => {
		await fs.mvBulk([
			{ src: "/b.txt", dest: "/dest/b.txt" },
			{ src: "/c.txt", dest: "/dest/c.txt" },
			{ src: "/d.txt", dest: "/dest/d.txt" },
		]);

		expect(transactionMock).toHaveBeenCalledOnce();
		expect(moveDirentMock).toHaveBeenCalledTimes(3);

		const paths = fs.getAllPaths();
		expect(paths).toContain("/dest/b.txt");
		expect(paths).toContain("/dest/c.txt");
		expect(paths).toContain("/dest/d.txt");
		expect(paths).not.toContain("/b.txt");
		expect(paths).not.toContain("/c.txt");
		expect(paths).not.toContain("/d.txt");
	});

	it("pathCache updated correctly for all 3 moves", async () => {
		await fs.mvBulk([
			{ src: "/b.txt", dest: "/dest/b.txt" },
			{ src: "/c.txt", dest: "/dest/c.txt" },
			{ src: "/d.txt", dest: "/dest/d.txt" },
		]);

		const paths = fs.getAllPaths();
		expect(paths).toContain("/");
		expect(paths).toContain("/a");
		expect(paths).toContain("/a/sub");
		expect(paths).toContain("/a/sub/f1.txt");
		expect(paths).toContain("/dest");
		expect(paths).toContain("/dest/b.txt");
		expect(paths).toContain("/dest/c.txt");
		expect(paths).toContain("/dest/d.txt");
	});

	it("directory move with descendants: subtree remapped", async () => {
		await fs.mvBulk([
			{ src: "/a", dest: "/dest/a" },
			{ src: "/b.txt", dest: "/dest/b.txt" },
		]);

		const paths = fs.getAllPaths();
		expect(paths).toContain("/dest/a");
		expect(paths).toContain("/dest/a/sub");
		expect(paths).toContain("/dest/a/sub/f1.txt");
		expect(paths).not.toContain("/a");
		expect(paths).not.toContain("/a/sub");
		expect(paths).not.toContain("/a/sub/f1.txt");
		expect(paths).toContain("/dest/b.txt");
	});

	it("error in pair 2: pathCache restored from snapshot", async () => {
		moveDirentMock.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("db error"));

		await expect(
			fs.mvBulk([
				{ src: "/b.txt", dest: "/dest/b.txt" },
				{ src: "/c.txt", dest: "/dest/c.txt" },
			]),
		).rejects.toThrow("db error");

		const paths = fs.getAllPaths();
		expect(paths).toContain("/b.txt");
		expect(paths).toContain("/c.txt");
		expect(paths).not.toContain("/dest/b.txt");
		expect(paths).not.toContain("/dest/c.txt");
	});

	it("error in pair 2: dirty remains false", async () => {
		moveDirentMock.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("db error"));

		await expect(
			fs.mvBulk([
				{ src: "/b.txt", dest: "/dest/b.txt" },
				{ src: "/c.txt", dest: "/dest/c.txt" },
			]),
		).rejects.toThrow();

		expect(fs.wasDirty()).toBe(false);
	});

	it("destination collision: displaced inode decremented/deleted", async () => {
		await fs.mvBulk([
			{ src: "/b.txt", dest: "/c.txt" },
			{ src: "/d.txt", dest: "/dest/d.txt" },
		]);

		expect(decrementNlinkMock).toHaveBeenCalledWith(expect.anything(), 6n);
		expect(deleteInodeMock).toHaveBeenCalledWith(expect.anything(), 6n);
	});

	it("ENOENT on missing source — cache restored", async () => {
		await expect(
			fs.mvBulk([
				{ src: "/b.txt", dest: "/dest/b.txt" },
				{ src: "/nonexistent", dest: "/dest/x.txt" },
			]),
		).rejects.toMatchObject({ code: "ENOENT" });

		expect(fs.getAllPaths()).toContain("/b.txt");
	});

	it("EINVAL on move-into-own-descendant — cache restored", async () => {
		await expect(
			fs.mvBulk([
				{ src: "/b.txt", dest: "/dest/b.txt" },
				{ src: "/a", dest: "/a/sub/nested" },
			]),
		).rejects.toMatchObject({ code: "EINVAL" });

		expect(fs.getAllPaths()).toContain("/b.txt");
		expect(fs.getAllPaths()).toContain("/a");
	});

	it("sets dirty = true on success", async () => {
		fs.clearDirty();
		await fs.mvBulk([
			{ src: "/b.txt", dest: "/dest/b.txt" },
			{ src: "/c.txt", dest: "/dest/c.txt" },
		]);
		expect(fs.wasDirty()).toBe(true);
	});

	it("inside active script scope: reuses tx", async () => {
		fs.beginScriptScope();
		await fs.writeFile("/tmp.txt", "x");
		transactionMock.mockClear();

		await fs.mvBulk([
			{ src: "/b.txt", dest: "/dest/b.txt" },
			{ src: "/c.txt", dest: "/dest/c.txt" },
		]);

		expect(transactionMock).not.toHaveBeenCalled();
		await fs.endScriptScope();
	});

	it("later pair sees earlier pair's cache changes", async () => {
		await fs.mvBulk([
			{ src: "/b.txt", dest: "/dest/b.txt" },
			{ src: "/dest/b.txt", dest: "/a/moved.txt" },
		]);

		const paths = fs.getAllPaths();
		expect(paths).not.toContain("/b.txt");
		expect(paths).not.toContain("/dest/b.txt");
		expect(paths).toContain("/a/moved.txt");
	});
});

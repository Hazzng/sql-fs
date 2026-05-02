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

describe("SqlFs.rmBulk()", () => {
	let deleteDirentMock: ReturnType<typeof vi.fn>;
	let decrementNlinkMock: ReturnType<typeof vi.fn>;
	let deleteInodeMock: ReturnType<typeof vi.fn>;
	let transactionMock: ReturnType<typeof vi.fn>;
	let dialect: SqlDialect<unknown>;
	let fs: SqlFs;

	beforeEach(async () => {
		deleteDirentMock = vi.fn(async () => 10n);
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
				fileEntry("/a.txt", 2n),
				fileEntry("/b.txt", 3n),
				fileEntry("/c.txt", 4n),
				dirEntry("/dir", 5n),
				fileEntry("/dir/nested.txt", 6n),
				dirEntry("/emptydir", 7n),
				dirEntry("/nonempty", 8n),
				fileEntry("/nonempty/child.txt", 9n),
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
		await fs.rmBulk([]);
		expect(transactionMock).not.toHaveBeenCalled();
	});

	it("single path delegates to rm()", async () => {
		await fs.rmBulk(["/a.txt"]);

		expect(fs.getAllPaths()).not.toContain("/a.txt");
	});

	it("removes 3 files in one transaction", async () => {
		await fs.rmBulk(["/a.txt", "/b.txt", "/c.txt"]);

		expect(transactionMock).toHaveBeenCalledOnce();

		const paths = fs.getAllPaths();
		expect(paths).not.toContain("/a.txt");
		expect(paths).not.toContain("/b.txt");
		expect(paths).not.toContain("/c.txt");
		expect(paths).toContain("/");
	});

	it("pathCache and contentCache cleared for all paths", async () => {
		await fs.rmBulk(["/a.txt", "/b.txt", "/c.txt"]);

		expect(decrementNlinkMock).toHaveBeenCalledTimes(3);
		expect(deleteInodeMock).toHaveBeenCalledTimes(3);
	});

	it("recursive: subtree removed correctly", async () => {
		await fs.rmBulk(["/dir"], { recursive: true });

		const paths = fs.getAllPaths();
		expect(paths).not.toContain("/dir");
		expect(paths).not.toContain("/dir/nested.txt");
		expect(paths).toContain("/");
	});

	it("non-recursive on non-empty dir throws ENOTEMPTY — cache restored", async () => {
		await expect(fs.rmBulk(["/a.txt", "/nonempty"])).rejects.toMatchObject({ code: "ENOTEMPTY" });

		const paths = fs.getAllPaths();
		expect(paths).toContain("/a.txt");
		expect(paths).toContain("/nonempty");
		expect(paths).toContain("/nonempty/child.txt");
	});

	it("force: missing paths silently skipped", async () => {
		await fs.rmBulk(["/a.txt", "/nonexistent", "/b.txt"], { force: true });

		const paths = fs.getAllPaths();
		expect(paths).not.toContain("/a.txt");
		expect(paths).not.toContain("/b.txt");
		expect(paths).toContain("/c.txt");
	});

	it("without force: missing path throws ENOENT — cache restored", async () => {
		await expect(fs.rmBulk(["/a.txt", "/nonexistent"])).rejects.toMatchObject({ code: "ENOENT" });

		expect(fs.getAllPaths()).toContain("/a.txt");
	});

	it("error mid-batch: pathCache restored from snapshot", async () => {
		deleteDirentMock.mockResolvedValueOnce(10n).mockRejectedValueOnce(new Error("db error"));

		await expect(fs.rmBulk(["/a.txt", "/b.txt"])).rejects.toThrow("db error");

		const paths = fs.getAllPaths();
		expect(paths).toContain("/a.txt");
		expect(paths).toContain("/b.txt");
	});

	it("sets dirty = true on success", async () => {
		fs.clearDirty();
		await fs.rmBulk(["/a.txt", "/b.txt"]);
		expect(fs.wasDirty()).toBe(true);
	});

	it("dirty remains false on error", async () => {
		fs.clearDirty();
		deleteDirentMock.mockRejectedValueOnce(new Error("fail"));

		await expect(fs.rmBulk(["/a.txt", "/b.txt"])).rejects.toThrow();
		expect(fs.wasDirty()).toBe(false);
	});

	it("inside active script scope: reuses tx", async () => {
		fs.beginScriptScope();
		await fs.writeFile("/tmp.txt", "x");
		transactionMock.mockClear();

		await fs.rmBulk(["/a.txt", "/b.txt"]);

		expect(transactionMock).not.toHaveBeenCalled();
		await fs.endScriptScope();
	});

	it("recursive rm of multiple dirs in one call", async () => {
		await fs.rmBulk(["/dir", "/emptydir"], { recursive: true });

		const paths = fs.getAllPaths();
		expect(paths).not.toContain("/dir");
		expect(paths).not.toContain("/dir/nested.txt");
		expect(paths).not.toContain("/emptydir");
		expect(paths).toContain("/");
	});
});

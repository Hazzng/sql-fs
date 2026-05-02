import { beforeEach, describe, expect, it, vi } from "vitest";
import { SqlFs } from "../sql-fs.js";
import type { PathCacheEntry, SqlDialect } from "../types.js";

const now = new Date("2026-01-01T00:00:00Z");
const sha256a = new Uint8Array(32).fill(0xaa);
const sha256b = new Uint8Array(32).fill(0xbb);
const sha256c = new Uint8Array(32).fill(0xcc);

function dirEntry(path: string, inodeId: bigint): { path: string } & PathCacheEntry {
	return { path, inodeId, kind: 2, mode: 0o755, size: 0, mtime: now, contentSha256: null, symlinkTarget: null };
}

function fileEntry(
	path: string,
	inodeId: bigint,
	size = 10,
	contentSha256 = sha256a,
): { path: string } & PathCacheEntry {
	return { path, inodeId, kind: 1, mode: 0o644, size, mtime: now, contentSha256, symlinkTarget: null };
}

describe("SqlFs.cpBulk() — single file copies", () => {
	let createInodeMock: ReturnType<typeof vi.fn>;
	let upsertDirentMock: ReturnType<typeof vi.fn>;
	let decrementNlinkMock: ReturnType<typeof vi.fn>;
	let deleteInodeMock: ReturnType<typeof vi.fn>;
	let transactionMock: ReturnType<typeof vi.fn>;
	let dialect: SqlDialect<unknown>;
	let fs: SqlFs;

	beforeEach(async () => {
		let nextId = 100n;
		createInodeMock = vi.fn(async () => nextId++);
		upsertDirentMock = vi.fn(async () => null);
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
				dirEntry("/src", 2n),
				fileEntry("/src/a.txt", 3n, 10, sha256a),
				fileEntry("/src/b.txt", 4n, 20, sha256b),
				fileEntry("/src/c.txt", 5n, 30, sha256c),
				dirEntry("/dest", 6n),
				fileEntry("/dest/existing.txt", 7n, 5, sha256a),
			]),
			createSandbox: vi.fn(),
			deleteSandbox: vi.fn(),
			createInode: createInodeMock,
			getInode: vi.fn(),
			updateInode: vi.fn(),
			deleteInode: deleteInodeMock,
			incrementNlink: vi.fn(),
			decrementNlink: decrementNlinkMock,
			insertDirent: vi.fn(),
			upsertDirent: upsertDirentMock,
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

		fs = new SqlFs({ dialect, sandboxId: "s1" });
		await fs.ready();
		transactionMock.mockClear();
	});

	it("empty array returns immediately, no transaction", async () => {
		await fs.cpBulk([]);
		expect(transactionMock).not.toHaveBeenCalled();
	});

	it("single pair delegates to cp()", async () => {
		await fs.cpBulk([{ src: "/src/a.txt", dest: "/dest/a.txt" }]);

		expect(fs.getAllPaths()).toContain("/dest/a.txt");
		expect(fs.getAllPaths()).toContain("/src/a.txt");
	});

	it("copies 3 files in one transaction", async () => {
		await fs.cpBulk([
			{ src: "/src/a.txt", dest: "/dest/a.txt" },
			{ src: "/src/b.txt", dest: "/dest/b.txt" },
			{ src: "/src/c.txt", dest: "/dest/c.txt" },
		]);

		expect(transactionMock).toHaveBeenCalledOnce();
		expect(createInodeMock).toHaveBeenCalledTimes(3);

		const paths = fs.getAllPaths();
		expect(paths).toContain("/dest/a.txt");
		expect(paths).toContain("/dest/b.txt");
		expect(paths).toContain("/dest/c.txt");
	});

	it("pathCache updated with new inodeIds, original entries unchanged", async () => {
		await fs.cpBulk([
			{ src: "/src/a.txt", dest: "/dest/a.txt" },
			{ src: "/src/b.txt", dest: "/dest/b.txt" },
		]);

		const paths = fs.getAllPaths();
		expect(paths).toContain("/src/a.txt");
		expect(paths).toContain("/src/b.txt");
		expect(paths).toContain("/dest/a.txt");
		expect(paths).toContain("/dest/b.txt");
	});

	it("CAS dedup: createInode called with src contentSha256 (no blob upload)", async () => {
		await fs.cpBulk([
			{ src: "/src/a.txt", dest: "/dest/a.txt" },
			{ src: "/src/b.txt", dest: "/dest/b.txt" },
		]);

		expect(createInodeMock).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ contentSha256: sha256a }),
		);
		expect(createInodeMock).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ contentSha256: sha256b }),
		);
	});

	it("destination collision: old inode cleaned up", async () => {
		upsertDirentMock.mockResolvedValueOnce(99n);

		await fs.cpBulk([
			{ src: "/src/a.txt", dest: "/dest/existing.txt" },
			{ src: "/src/b.txt", dest: "/dest/b.txt" },
		]);

		expect(decrementNlinkMock).toHaveBeenCalledWith(expect.anything(), 99n);
		expect(deleteInodeMock).toHaveBeenCalledWith(expect.anything(), 99n);
	});

	it("ENOENT on missing source — cache restored", async () => {
		await expect(
			fs.cpBulk([
				{ src: "/src/a.txt", dest: "/dest/a.txt" },
				{ src: "/nonexistent", dest: "/dest/x.txt" },
			]),
		).rejects.toMatchObject({ code: "ENOENT" });

		expect(fs.getAllPaths()).not.toContain("/dest/a.txt");
		expect(fs.getAllPaths()).toContain("/src/a.txt");
	});

	it("EISDIR when recursive not set — cache restored", async () => {
		await expect(
			fs.cpBulk([
				{ src: "/src/a.txt", dest: "/dest/a.txt" },
				{ src: "/src", dest: "/dest/src-copy" },
			]),
		).rejects.toMatchObject({ code: "EISDIR" });

		expect(fs.getAllPaths()).not.toContain("/dest/a.txt");
	});

	it("error mid-batch: pathCache restored from snapshot", async () => {
		createInodeMock.mockResolvedValueOnce(100n).mockRejectedValueOnce(new Error("db error"));

		await expect(
			fs.cpBulk([
				{ src: "/src/a.txt", dest: "/dest/a.txt" },
				{ src: "/src/b.txt", dest: "/dest/b.txt" },
			]),
		).rejects.toThrow("db error");

		const paths = fs.getAllPaths();
		expect(paths).not.toContain("/dest/a.txt");
		expect(paths).not.toContain("/dest/b.txt");
		expect(paths).toContain("/src/a.txt");
		expect(paths).toContain("/src/b.txt");
	});

	it("sets dirty = true on success", async () => {
		fs.clearDirty();
		await fs.cpBulk([
			{ src: "/src/a.txt", dest: "/dest/a.txt" },
			{ src: "/src/b.txt", dest: "/dest/b.txt" },
		]);
		expect(fs.wasDirty()).toBe(true);
	});

	it("dirty remains false on error", async () => {
		fs.clearDirty();
		createInodeMock.mockRejectedValueOnce(new Error("fail"));

		await expect(
			fs.cpBulk([
				{ src: "/src/a.txt", dest: "/dest/a.txt" },
				{ src: "/src/b.txt", dest: "/dest/b.txt" },
			]),
		).rejects.toThrow();

		expect(fs.wasDirty()).toBe(false);
	});

	it("inside active script scope: reuses tx", async () => {
		fs.beginScriptScope();
		await fs.writeFile("/tmp.txt", "x");
		transactionMock.mockClear();

		await fs.cpBulk([
			{ src: "/src/a.txt", dest: "/dest/a.txt" },
			{ src: "/src/b.txt", dest: "/dest/b.txt" },
		]);

		expect(transactionMock).not.toHaveBeenCalled();
		await fs.endScriptScope();
	});
});

describe("SqlFs.cpBulk() — recursive directory copy", () => {
	let createInodeMock: ReturnType<typeof vi.fn>;
	let insertDirentMock: ReturnType<typeof vi.fn>;
	let transactionMock: ReturnType<typeof vi.fn>;
	let dialect: SqlDialect<unknown>;
	let fs: SqlFs;

	beforeEach(async () => {
		let nextId = 100n;
		createInodeMock = vi.fn(async () => nextId++);
		insertDirentMock = vi.fn(async () => undefined);
		transactionMock = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({}));

		dialect = {
			connect: vi.fn(),
			disconnect: vi.fn(),
			transaction: transactionMock,
			setSandboxContext: vi.fn(),
			setSandboxContextWithLock: vi.fn(),
			loadAllPaths: vi.fn(async () => [
				dirEntry("/", 1n),
				dirEntry("/srcDir", 2n),
				fileEntry("/srcDir/f1.txt", 3n, 10, sha256a),
				dirEntry("/srcDir/sub", 4n),
				fileEntry("/srcDir/sub/f2.txt", 5n, 20, sha256b),
				dirEntry("/destParent", 6n),
			]),
			createSandbox: vi.fn(),
			deleteSandbox: vi.fn(),
			createInode: createInodeMock,
			getInode: vi.fn(),
			updateInode: vi.fn(),
			deleteInode: vi.fn(),
			incrementNlink: vi.fn(),
			decrementNlink: vi.fn(),
			insertDirent: insertDirentMock,
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

		fs = new SqlFs({ dialect, sandboxId: "s1" });
		await fs.ready();
		transactionMock.mockClear();
	});

	it("recursive directory copy creates full subtree in one tx", async () => {
		await fs.cpBulk([{ src: "/srcDir", dest: "/destParent/copy" }], { recursive: true });

		const paths = fs.getAllPaths();
		expect(paths).toContain("/destParent/copy");
		expect(paths).toContain("/destParent/copy/f1.txt");
		expect(paths).toContain("/destParent/copy/sub");
		expect(paths).toContain("/destParent/copy/sub/f2.txt");
	});

	it("recursive copy: src paths remain intact", async () => {
		await fs.cpBulk([{ src: "/srcDir", dest: "/destParent/copy" }], { recursive: true });

		const paths = fs.getAllPaths();
		expect(paths).toContain("/srcDir");
		expect(paths).toContain("/srcDir/f1.txt");
		expect(paths).toContain("/srcDir/sub");
		expect(paths).toContain("/srcDir/sub/f2.txt");
	});

	it("recursive copy error: pathCache restored from snapshot", async () => {
		createInodeMock
			.mockResolvedValueOnce(100n)
			.mockResolvedValueOnce(101n)
			.mockRejectedValueOnce(new Error("db error"));

		await expect(fs.cpBulk([{ src: "/srcDir", dest: "/destParent/copy" }], { recursive: true })).rejects.toThrow(
			"db error",
		);

		const paths = fs.getAllPaths();
		expect(paths).not.toContain("/destParent/copy");
		expect(paths).toContain("/srcDir");
	});
});

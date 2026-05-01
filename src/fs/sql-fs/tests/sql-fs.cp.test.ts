/**
 * Unit tests for SqlFs.cp (single file and recursive directory).
 * US-037: SqlFs.cp (single file)
 * US-038: SqlFs.cp (recursive directory)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SqlFs } from "../sql-fs.js";
import type { PathCacheEntry, SqlDialect } from "../types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const now = new Date("2026-01-01T00:00:00Z");
const sha256 = new Uint8Array(32).fill(0xab);

function dirEntry(path: string, inodeId: bigint): { path: string } & PathCacheEntry {
	return { path, inodeId, kind: 2, mode: 0o755, size: 0, mtime: now, contentSha256: null, symlinkTarget: null };
}

function fileEntry(
	path: string,
	inodeId: bigint,
	size = 10,
	contentSha256 = sha256,
): { path: string } & PathCacheEntry {
	return { path, inodeId, kind: 1, mode: 0o644, size, mtime: now, contentSha256, symlinkTarget: null };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("SqlFs.cp() — single file", () => {
	const sandboxId = "test-sandbox";
	let createInodeMock: ReturnType<typeof vi.fn>;
	let upsertDirentMock: ReturnType<typeof vi.fn>;
	let decrementNlinkMock: ReturnType<typeof vi.fn>;
	let deleteInodeMock: ReturnType<typeof vi.fn>;
	let upsertBlobMock: ReturnType<typeof vi.fn>;
	let dialect: SqlDialect<unknown>;
	let fs: SqlFs;

	beforeEach(async () => {
		createInodeMock = vi.fn(async () => 10n); // new inode id
		upsertDirentMock = vi.fn(async () => null); // no old inode displaced
		decrementNlinkMock = vi.fn(async () => 0);
		deleteInodeMock = vi.fn(async () => undefined);
		upsertBlobMock = vi.fn(async () => undefined);

		dialect = {
			connect: vi.fn(),
			disconnect: vi.fn(),
			transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
			setSandboxContext: vi.fn(),
			setSandboxContextWithLock: vi.fn(),
			loadAllPaths: vi.fn(async () => [
				dirEntry("/", 1n),
				dirEntry("/home", 2n),
				fileEntry("/home/src.txt", 3n, 10, sha256),
				dirEntry("/dest", 4n),
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
			upsertBlob: upsertBlobMock,
			getBlob: vi.fn(),
			gcOrphanBlobs: vi.fn(),
			getBlobsForSandbox: vi.fn(async () => []),
			loadSubtreeInodes: vi.fn(),
			bulkIngest: vi.fn(),
			resolvePath: vi.fn(),
		} as unknown as SqlDialect<unknown>;

		fs = new SqlFs({ dialect, sandboxId });
		await fs.ready();
	});

	it("cp file: dest path is added to pathCache", async () => {
		await fs.cp("/home/src.txt", "/dest/copy.txt");

		expect(fs.getAllPaths()).toContain("/dest/copy.txt");
	});

	it("cp file: dest pathCache entry shares same contentSha256 as src (blob not duplicated)", async () => {
		await fs.cp("/home/src.txt", "/dest/copy.txt");

		// Verify that upsertBlob was NOT called (no blob upload — CAS dedup means blob already exists)
		expect(upsertBlobMock).not.toHaveBeenCalled();

		// Verify createInode was called with the src's contentSha256
		expect(createInodeMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ contentSha256: sha256 }));
	});

	it("cp file: createInode called with src mode and size", async () => {
		await fs.cp("/home/src.txt", "/dest/copy.txt");

		expect(createInodeMock).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ kind: 1, mode: 0o644, size: 10 }),
		);
	});

	it("cp file: upsertDirent called with dest parent inodeId and dest name", async () => {
		await fs.cp("/home/src.txt", "/dest/copy.txt");

		// dest parent is /dest with inodeId=4n
		expect(upsertDirentMock).toHaveBeenCalledWith(
			expect.anything(),
			4n,
			"copy.txt",
			10n, // new inode id returned by createInodeMock
		);
	});

	it("cp file: src path remains in pathCache (copy not move)", async () => {
		await fs.cp("/home/src.txt", "/dest/copy.txt");

		expect(fs.getAllPaths()).toContain("/home/src.txt");
	});

	it("cp non-existent src throws ENOENT", async () => {
		await expect(fs.cp("/nonexistent.txt", "/dest/copy.txt")).rejects.toMatchObject({ code: "ENOENT" });
		expect(createInodeMock).not.toHaveBeenCalled();
	});

	it("cp directory without recursive option throws EISDIR", async () => {
		await expect(fs.cp("/home", "/dest/home-copy")).rejects.toMatchObject({ code: "EISDIR" });
		expect(createInodeMock).not.toHaveBeenCalled();
	});

	it("cp over existing dest: decrements old dest inode nlink, deletes inode if nlink=0", async () => {
		// Add an existing dest file
		upsertDirentMock.mockResolvedValue(99n); // old displaced inode id
		decrementNlinkMock.mockResolvedValue(0); // nlink drops to 0

		await fs.cp("/home/src.txt", "/dest/copy.txt");

		expect(decrementNlinkMock).toHaveBeenCalledWith(expect.anything(), 99n);
		expect(deleteInodeMock).toHaveBeenCalledWith(expect.anything(), 99n);
	});
});

// ── Recursive directory copy ───────────────────────────────────────────────────

describe("SqlFs.cp() — recursive directory", () => {
	const sandboxId = "test-sandbox";
	const sha256a = new Uint8Array(32).fill(0xaa);
	const sha256b = new Uint8Array(32).fill(0xbb);

	let createInodeMock: ReturnType<typeof vi.fn>;
	let insertDirentMock: ReturnType<typeof vi.fn>;
	let upsertBlobMock: ReturnType<typeof vi.fn>;
	let dialect: SqlDialect<unknown>;
	let fs: SqlFs;

	// Inode IDs used in the initial tree
	// 1n=root, 2n=/destParent, 3n=/srcDir, 4n=/srcDir/file.txt, 5n=/srcDir/subdir, 6n=/srcDir/subdir/deep.txt
	// New copies: 10n, 11n, 12n, 13n (returned in order by createInodeMock)

	beforeEach(async () => {
		let nextId = 10n;
		createInodeMock = vi.fn(async () => nextId++);
		insertDirentMock = vi.fn(async () => undefined);
		upsertBlobMock = vi.fn(async () => undefined);

		function makeEntry(
			path: string,
			inodeId: bigint,
			kind: 1 | 2 | 3,
			contentSha256: Uint8Array | null = null,
		): { path: string } & PathCacheEntry {
			return {
				path,
				inodeId,
				kind,
				mode: kind === 2 ? 0o755 : 0o644,
				size: kind === 1 ? 20 : 0,
				mtime: now,
				contentSha256,
				symlinkTarget: null,
			};
		}

		dialect = {
			connect: vi.fn(),
			disconnect: vi.fn(),
			transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
			setSandboxContext: vi.fn(),
			setSandboxContextWithLock: vi.fn(),
			loadAllPaths: vi.fn(async () => [
				makeEntry("/", 1n, 2),
				makeEntry("/destParent", 2n, 2),
				makeEntry("/srcDir", 3n, 2),
				makeEntry("/srcDir/file.txt", 4n, 1, sha256a),
				makeEntry("/srcDir/subdir", 5n, 2),
				makeEntry("/srcDir/subdir/deep.txt", 6n, 1, sha256b),
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
			upsertBlob: upsertBlobMock,
			getBlob: vi.fn(),
			gcOrphanBlobs: vi.fn(),
			getBlobsForSandbox: vi.fn(async () => []),
			loadSubtreeInodes: vi.fn(),
			bulkIngest: vi.fn(),
			resolvePath: vi.fn(),
		} as unknown as SqlDialect<unknown>;

		fs = new SqlFs({ dialect, sandboxId });
		await fs.ready();
	});

	it("cp -r adds all dest paths to pathCache", async () => {
		await fs.cp("/srcDir", "/destParent/copy", { recursive: true });

		const paths = fs.getAllPaths();
		expect(paths).toContain("/destParent/copy");
		expect(paths).toContain("/destParent/copy/file.txt");
		expect(paths).toContain("/destParent/copy/subdir");
		expect(paths).toContain("/destParent/copy/subdir/deep.txt");
	});

	it("cp -r leaves src paths intact in pathCache", async () => {
		await fs.cp("/srcDir", "/destParent/copy", { recursive: true });

		const paths = fs.getAllPaths();
		expect(paths).toContain("/srcDir");
		expect(paths).toContain("/srcDir/file.txt");
		expect(paths).toContain("/srcDir/subdir");
		expect(paths).toContain("/srcDir/subdir/deep.txt");
	});

	it("cp -r dest file entries share contentSha256 with src (blobs not duplicated)", async () => {
		await fs.cp("/srcDir", "/destParent/copy", { recursive: true });

		// Verify upsertBlob was never called (no blob re-upload)
		expect(upsertBlobMock).not.toHaveBeenCalled();

		// Verify createInode for the files was called with the correct sha256
		expect(createInodeMock).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ kind: 1, contentSha256: sha256a }),
		);
		expect(createInodeMock).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ kind: 1, contentSha256: sha256b }),
		);
	});

	it("cp -r creates an inode for every entry in the subtree (dir + all children)", async () => {
		await fs.cp("/srcDir", "/destParent/copy", { recursive: true });

		// 4 entries: /srcDir itself + file.txt + subdir + subdir/deep.txt
		expect(createInodeMock).toHaveBeenCalledTimes(4);
	});

	it("cp -r inserts dirents with correct parent inodeIds (depth ordering)", async () => {
		await fs.cp("/srcDir", "/destParent/copy", { recursive: true });

		// insertDirent called once per entry
		expect(insertDirentMock).toHaveBeenCalledTimes(4);

		// Root of copy (/destParent/copy) must be inserted under destParent's inodeId (2n)
		expect(insertDirentMock).toHaveBeenCalledWith(expect.anything(), 2n, "copy", 10n);
	});

	it("cp -r without recursive option throws EISDIR", async () => {
		await expect(fs.cp("/srcDir", "/destParent/copy")).rejects.toMatchObject({ code: "EISDIR" });
		expect(createInodeMock).not.toHaveBeenCalled();
	});

	it("cp -r non-existent src throws ENOENT", async () => {
		await expect(fs.cp("/nonexistent", "/destParent/copy", { recursive: true })).rejects.toMatchObject({
			code: "ENOENT",
		});
		expect(createInodeMock).not.toHaveBeenCalled();
	});
});

/**
 * Unit tests for SqlFs.cp (single file).
 * US-037: SqlFs.cp (single file)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SqlFs } from "./sql-fs.js";
import type { PathCacheEntry, SqlDialect } from "./types.js";

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

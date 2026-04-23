/**
 * Unit tests for SqlFs.link (hardlink).
 * US-039: SqlFs.link (hardlink)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SqlFs } from "./sql-fs.js";
import type { PathCacheEntry, SqlDialect } from "./types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const now = new Date("2026-01-01T00:00:00Z");
const sha256 = new Uint8Array(32).fill(1);

function dirEntry(path: string, inodeId: bigint): { path: string } & PathCacheEntry {
	return { path, inodeId, kind: 2, mode: 0o755, size: 0, mtime: now, contentSha256: null, symlinkTarget: null };
}

function fileEntry(path: string, inodeId: bigint): { path: string } & PathCacheEntry {
	return { path, inodeId, kind: 1, mode: 0o644, size: 10, mtime: now, contentSha256: sha256, symlinkTarget: null };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("SqlFs.link() — hardlink creation", () => {
	const sandboxId = "test-sandbox";
	let insertDirentMock: ReturnType<typeof vi.fn>;
	let incrementNlinkMock: ReturnType<typeof vi.fn>;
	let dialect: SqlDialect<unknown>;
	let fs: SqlFs;

	beforeEach(async () => {
		insertDirentMock = vi.fn(async () => undefined);
		incrementNlinkMock = vi.fn(async () => undefined);

		dialect = {
			connect: vi.fn(),
			disconnect: vi.fn(),
			transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
			setSandboxContext: vi.fn(),
			setSandboxContextWithLock: vi.fn(),
			loadAllPaths: vi.fn(async () => [dirEntry("/", 1n), dirEntry("/home", 2n), fileEntry("/home/file.txt", 3n)]),
			createSandbox: vi.fn(),
			deleteSandbox: vi.fn(),
			createInode: vi.fn(),
			getInode: vi.fn(),
			updateInode: vi.fn(),
			deleteInode: vi.fn(),
			incrementNlink: incrementNlinkMock,
			decrementNlink: vi.fn(),
			insertDirent: insertDirentMock,
			upsertDirent: vi.fn(),
			deleteDirent: vi.fn(),
			listDirents: vi.fn(),
			moveDirent: vi.fn(),
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

	it("adds new path to pathCache with same inodeId as source", async () => {
		await fs.link("/home/file.txt", "/home/link.txt");

		expect(fs.getAllPaths()).toContain("/home/link.txt");
	});

	it("both source and dest resolve to the same inodeId", async () => {
		await fs.link("/home/file.txt", "/home/link.txt");

		// Source must still exist
		expect(fs.getAllPaths()).toContain("/home/file.txt");
		expect(fs.getAllPaths()).toContain("/home/link.txt");
	});

	it("calls insertDirent with dest parent inodeId, name, and src inodeId", async () => {
		await fs.link("/home/file.txt", "/home/link.txt");

		expect(insertDirentMock).toHaveBeenCalledWith(
			expect.anything(), // tx
			2n, // destParentInodeId (/home)
			"link.txt", // destName
			3n, // srcInodeId
		);
	});

	it("calls incrementNlink with src inodeId", async () => {
		await fs.link("/home/file.txt", "/home/link.txt");

		expect(incrementNlinkMock).toHaveBeenCalledWith(
			expect.anything(), // tx
			3n, // srcInodeId
		);
	});

	it("throws ENOENT when source does not exist", async () => {
		await expect(fs.link("/nonexistent", "/home/link.txt")).rejects.toMatchObject({ code: "ENOENT" });
		expect(insertDirentMock).not.toHaveBeenCalled();
		expect(incrementNlinkMock).not.toHaveBeenCalled();
	});

	it("throws EPERM when source is a directory", async () => {
		await expect(fs.link("/home", "/home-link")).rejects.toMatchObject({ code: "EPERM" });
		expect(insertDirentMock).not.toHaveBeenCalled();
		expect(incrementNlinkMock).not.toHaveBeenCalled();
	});

	it("throws EEXIST when destination already exists", async () => {
		await expect(fs.link("/home/file.txt", "/home")).rejects.toMatchObject({ code: "EEXIST" });
		expect(insertDirentMock).not.toHaveBeenCalled();
		expect(incrementNlinkMock).not.toHaveBeenCalled();
	});

	it("throws ENOENT when destination parent does not exist", async () => {
		await expect(fs.link("/home/file.txt", "/missing/link.txt")).rejects.toMatchObject({ code: "ENOENT" });
		expect(insertDirentMock).not.toHaveBeenCalled();
	});
});

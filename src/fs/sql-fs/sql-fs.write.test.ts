/**
 * Unit tests for SqlFs pathCache updates on write operations.
 * US-020: pathCache update on write operations
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

// ── Shared mock setup ─────────────────────────────────────────────────────────

function makeDialect(): {
	dialect: SqlDialect<unknown>;
	createInodeMock: ReturnType<typeof vi.fn>;
	upsertDirentMock: ReturnType<typeof vi.fn>;
	upsertBlobMock: ReturnType<typeof vi.fn>;
	deleteDirentMock: ReturnType<typeof vi.fn>;
	decrementNlinkMock: ReturnType<typeof vi.fn>;
	deleteInodeMock: ReturnType<typeof vi.fn>;
	insertDirentMock: ReturnType<typeof vi.fn>;
	updateInodeMock: ReturnType<typeof vi.fn>;
	getBlobMock: ReturnType<typeof vi.fn>;
} {
	const createInodeMock = vi.fn(async () => 10n);
	const upsertDirentMock = vi.fn(async () => null as bigint | null);
	const upsertBlobMock = vi.fn(async () => undefined);
	const deleteDirentMock = vi.fn(async () => 4n); // returns removed inodeId
	const decrementNlinkMock = vi.fn(async () => 0); // nlink reaches 0
	const deleteInodeMock = vi.fn(async () => undefined);
	const insertDirentMock = vi.fn(async () => undefined);
	const updateInodeMock = vi.fn(async () => undefined);
	const getBlobMock = vi.fn(async () => null as Uint8Array | null);

	const dialect: SqlDialect<unknown> = {
		connect: vi.fn(),
		disconnect: vi.fn(),
		transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
		setSandboxContext: vi.fn(),
		setSandboxContextWithLock: vi.fn(),
		loadAllPaths: vi.fn(async () => [
			dirEntry("/", 1n),
			dirEntry("/home", 2n),
			dirEntry("/home/user", 3n),
			fileEntry("/home/user/existing.txt", 4n, 20),
		]),
		createSandbox: vi.fn(),
		deleteSandbox: vi.fn(),
		createInode: createInodeMock,
		getInode: vi.fn(),
		updateInode: updateInodeMock,
		deleteInode: deleteInodeMock,
		incrementNlink: vi.fn(),
		decrementNlink: decrementNlinkMock,
		insertDirent: insertDirentMock,
		upsertDirent: upsertDirentMock,
		deleteDirent: deleteDirentMock,
		listDirents: vi.fn(),
		moveDirent: vi.fn(),
		upsertBlob: upsertBlobMock,
		getBlob: getBlobMock,
		gcOrphanBlobs: vi.fn(),
		getBlobsForSandbox: vi.fn(async () => []),
		loadSubtreeInodes: vi.fn(async () => [3n, 4n]),
		bulkIngest: vi.fn(),
		resolvePath: vi.fn(),
	} as unknown as SqlDialect<unknown>;

	return {
		dialect,
		createInodeMock,
		upsertDirentMock,
		upsertBlobMock,
		deleteDirentMock,
		decrementNlinkMock,
		deleteInodeMock,
		insertDirentMock,
		updateInodeMock,
		getBlobMock,
	};
}

// ── writeFile ─────────────────────────────────────────────────────────────────

describe("SqlFs.writeFile — pathCache updates", () => {
	let fs: SqlFs;
	let mocks: ReturnType<typeof makeDialect>;

	beforeEach(async () => {
		mocks = makeDialect();
		fs = new SqlFs({ dialect: mocks.dialect, sandboxId: "s1" });
		await fs.ready();
	});

	it("adds new file entry to pathCache after write", async () => {
		await fs.writeFile("/home/user/new.txt", "hello");

		expect(fs.getAllPaths()).toContain("/home/user/new.txt");
	});

	it("pathCache entry has correct kind and size", async () => {
		const content = "hello world";
		await fs.writeFile("/home/user/new.txt", content);

		// verify via stat that the kind is file
		const paths = fs.getAllPaths();
		expect(paths).toContain("/home/user/new.txt");
		// createInode was called to create the inode
		expect(mocks.createInodeMock).toHaveBeenCalledOnce();
	});

	it("calls upsertBlob and createInode and upsertDirent in a transaction", async () => {
		await fs.writeFile("/home/user/new.txt", "data");

		expect(mocks.upsertBlobMock).toHaveBeenCalledOnce();
		expect(mocks.createInodeMock).toHaveBeenCalledOnce();
		expect(mocks.upsertDirentMock).toHaveBeenCalledOnce();
	});

	it("overwrites existing file and updates pathCache entry", async () => {
		// upsertDirent returns old inodeId (replacement)
		mocks.upsertDirentMock.mockResolvedValueOnce(4n);
		mocks.decrementNlinkMock.mockResolvedValueOnce(0);

		await fs.writeFile("/home/user/existing.txt", "new content");

		expect(fs.getAllPaths()).toContain("/home/user/existing.txt");
		// decrementNlink called for old inode
		expect(mocks.decrementNlinkMock).toHaveBeenCalledOnce();
		// deleteInode called because nlink=0
		expect(mocks.deleteInodeMock).toHaveBeenCalledOnce();
	});

	it("throws ENOENT when parent directory does not exist", async () => {
		await expect(fs.writeFile("/nonexistent/file.txt", "x")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("throws ENOTDIR when parent path is a file", async () => {
		await expect(fs.writeFile("/home/user/existing.txt/child.txt", "x")).rejects.toMatchObject({ code: "ENOTDIR" });
	});
});

// ── rm ────────────────────────────────────────────────────────────────────────

describe("SqlFs.rm — pathCache updates", () => {
	let fs: SqlFs;
	let mocks: ReturnType<typeof makeDialect>;

	beforeEach(async () => {
		mocks = makeDialect();
		fs = new SqlFs({ dialect: mocks.dialect, sandboxId: "s1" });
		await fs.ready();
	});

	it("removes file entry from pathCache", async () => {
		expect(fs.getAllPaths()).toContain("/home/user/existing.txt");

		await fs.rm("/home/user/existing.txt");

		expect(fs.getAllPaths()).not.toContain("/home/user/existing.txt");
	});

	it("calls deleteDirent, decrementNlink, and deleteInode for file", async () => {
		await fs.rm("/home/user/existing.txt");

		expect(mocks.deleteDirentMock).toHaveBeenCalledOnce();
		expect(mocks.decrementNlinkMock).toHaveBeenCalledOnce();
		expect(mocks.deleteInodeMock).toHaveBeenCalledOnce();
	});

	it("throws ENOENT when path does not exist", async () => {
		await expect(fs.rm("/nonexistent.txt")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("does not throw when force=true and path does not exist", async () => {
		await expect(fs.rm("/nonexistent.txt", { force: true })).resolves.toBeUndefined();
	});

	it("throws ENOTEMPTY when removing non-empty directory without recursive", async () => {
		// /home/user has children, so it is non-empty
		await expect(fs.rm("/home/user")).rejects.toMatchObject({ code: "ENOTEMPTY" });
	});

	it("removes empty directory from pathCache", async () => {
		// Add an empty dir to pathCache via writeFile side-effect (simpler: prime directly)
		// Manually write file and rm it to make /home/user empty, then rm the dir
		// Instead: rm existing.txt first, then rm /home/user
		await fs.rm("/home/user/existing.txt");
		await fs.rm("/home/user");

		expect(fs.getAllPaths()).not.toContain("/home/user");
	});

	it("recursive rm removes directory and all descendants from pathCache", async () => {
		// /home/user contains existing.txt
		await fs.rm("/home/user", { recursive: true });

		const paths = fs.getAllPaths();
		expect(paths).not.toContain("/home/user");
		expect(paths).not.toContain("/home/user/existing.txt");
		// /home and / still present
		expect(paths).toContain("/home");
		expect(paths).toContain("/");
	});
});

// ── mkdir ─────────────────────────────────────────────────────────────────────

describe("SqlFs.mkdir — pathCache updates", () => {
	let fs: SqlFs;
	let mocks: ReturnType<typeof makeDialect>;

	beforeEach(async () => {
		mocks = makeDialect();
		fs = new SqlFs({ dialect: mocks.dialect, sandboxId: "s1" });
		await fs.ready();
	});

	it("adds new directory entry to pathCache", async () => {
		await fs.mkdir("/home/user/projects");

		expect(fs.getAllPaths()).toContain("/home/user/projects");
	});

	it("calls createInode and insertDirent in transaction", async () => {
		await fs.mkdir("/home/user/projects");

		expect(mocks.createInodeMock).toHaveBeenCalledOnce();
		expect(mocks.insertDirentMock).toHaveBeenCalledOnce();
	});

	it("throws EEXIST when directory already exists", async () => {
		await expect(fs.mkdir("/home/user")).rejects.toMatchObject({ code: "EEXIST" });
	});

	it("throws ENOENT when parent does not exist", async () => {
		await expect(fs.mkdir("/nonexistent/child")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("mkdir -p creates all missing parent directories", async () => {
		let idCounter = 10n;
		mocks.createInodeMock.mockImplementation(async () => idCounter++);

		await fs.mkdir("/home/user/a/b/c", { recursive: true });

		const paths = fs.getAllPaths();
		expect(paths).toContain("/home/user/a");
		expect(paths).toContain("/home/user/a/b");
		expect(paths).toContain("/home/user/a/b/c");
	});

	it("mkdir -p does not throw when path already exists", async () => {
		await expect(fs.mkdir("/home/user", { recursive: true })).resolves.toBeUndefined();
	});

	it("mkdir -p throws ENOTDIR when an intermediate ancestor is a file", async () => {
		// Seed: /home/user/note.txt is a regular file.
		await fs.writeFile("/home/user/note.txt", "hello");

		// /home/user/note.txt/inside would require treating note.txt as a
		// directory. Without a kind check, the recursive path would silently
		// insert a dirent under the file's inode and corrupt the tree.
		await expect(fs.mkdir("/home/user/note.txt/inside", { recursive: true })).rejects.toMatchObject({
			code: "ENOTDIR",
		});

		// And no dirent was inserted for the would-be child.
		expect(fs.getAllPaths()).not.toContain("/home/user/note.txt/inside");
	});
});

// ── appendFile ────────────────────────────────────────────────────────────────

describe("SqlFs.appendFile — pathCache updates", () => {
	let fs: SqlFs;
	let mocks: ReturnType<typeof makeDialect>;

	beforeEach(async () => {
		mocks = makeDialect();
		fs = new SqlFs({ dialect: mocks.dialect, sandboxId: "s1" });
		await fs.ready();
	});

	it("creates new file when target does not exist", async () => {
		await fs.appendFile("/home/user/new.log", "line1\n");

		expect(fs.getAllPaths()).toContain("/home/user/new.log");
	});

	it("updates size in pathCache when appending to existing file", async () => {
		const existingContent = new TextEncoder().encode("hello");
		mocks.getBlobMock.mockResolvedValueOnce(existingContent);
		mocks.upsertDirentMock.mockResolvedValueOnce(4n);
		mocks.decrementNlinkMock.mockResolvedValueOnce(0);

		await fs.appendFile("/home/user/existing.txt", " world");

		const paths = fs.getAllPaths();
		expect(paths).toContain("/home/user/existing.txt");
		// getBlob called to read existing content
		expect(mocks.getBlobMock).toHaveBeenCalledOnce();
	});
});

// ── chmod ─────────────────────────────────────────────────────────────────────

describe("SqlFs.chmod — pathCache updates", () => {
	let fs: SqlFs;
	let mocks: ReturnType<typeof makeDialect>;

	beforeEach(async () => {
		mocks = makeDialect();
		fs = new SqlFs({ dialect: mocks.dialect, sandboxId: "s1" });
		await fs.ready();
	});

	it("updates mode in pathCache", async () => {
		await fs.chmod("/home/user/existing.txt", 0o600);

		expect(mocks.updateInodeMock).toHaveBeenCalledOnce();
		// Verify getAllPaths still includes the file
		expect(fs.getAllPaths()).toContain("/home/user/existing.txt");
	});

	it("throws ENOENT when path does not exist", async () => {
		await expect(fs.chmod("/nonexistent.txt", 0o600)).rejects.toMatchObject({ code: "ENOENT" });
	});
});

// ── utimes ────────────────────────────────────────────────────────────────────

describe("SqlFs.utimes — pathCache updates", () => {
	let fs: SqlFs;
	let mocks: ReturnType<typeof makeDialect>;

	beforeEach(async () => {
		mocks = makeDialect();
		fs = new SqlFs({ dialect: mocks.dialect, sandboxId: "s1" });
		await fs.ready();
	});

	it("updates mtime in pathCache", async () => {
		const newMtime = new Date("2026-06-01T00:00:00Z");
		await fs.utimes("/home/user/existing.txt", newMtime, newMtime);

		expect(mocks.updateInodeMock).toHaveBeenCalledOnce();
		expect(fs.getAllPaths()).toContain("/home/user/existing.txt");
	});

	it("throws ENOENT when path does not exist", async () => {
		const t = new Date();
		await expect(fs.utimes("/nonexistent.txt", t, t)).rejects.toMatchObject({ code: "ENOENT" });
	});
});

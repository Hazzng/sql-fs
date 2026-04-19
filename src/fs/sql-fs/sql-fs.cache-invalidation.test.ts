/**
 * Unit tests for SqlFs content cache invalidation on write/delete.
 * US-024: Content cache invalidation on write/delete
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SqlFs } from "./sql-fs.js";
import type { PathCacheEntry, SqlDialect } from "./types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const now = new Date("2026-01-01T00:00:00Z");

function dirEntry(path: string, inodeId: bigint): { path: string } & PathCacheEntry {
	return { path, inodeId, kind: 2, mode: 0o755, size: 0, mtime: now, contentSha256: null, symlinkTarget: null };
}

function fileEntry(path: string, inodeId: bigint, size = 5): { path: string } & PathCacheEntry {
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

function makeDialect(): {
	dialect: SqlDialect<unknown>;
	createInodeMock: ReturnType<typeof vi.fn>;
	upsertDirentMock: ReturnType<typeof vi.fn>;
	upsertBlobMock: ReturnType<typeof vi.fn>;
	deleteDirentMock: ReturnType<typeof vi.fn>;
	decrementNlinkMock: ReturnType<typeof vi.fn>;
	deleteInodeMock: ReturnType<typeof vi.fn>;
	getBlobMock: ReturnType<typeof vi.fn>;
	moveDirentMock: ReturnType<typeof vi.fn>;
} {
	const createInodeMock = vi.fn(async () => 10n);
	const upsertDirentMock = vi.fn(async () => null as bigint | null);
	const upsertBlobMock = vi.fn(async () => undefined);
	const deleteDirentMock = vi.fn(async () => 4n);
	const decrementNlinkMock = vi.fn(async () => 0);
	const deleteInodeMock = vi.fn(async () => undefined);
	const getBlobMock = vi.fn(async () => null as Uint8Array | null);
	const moveDirentMock = vi.fn(async () => undefined);

	const dialect: SqlDialect<unknown> = {
		connect: vi.fn(),
		disconnect: vi.fn(),
		transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
		setSandboxContext: vi.fn(),
		loadAllPaths: vi.fn(async () => [
			dirEntry("/", 1n),
			dirEntry("/home", 2n),
			dirEntry("/home/user", 3n),
			fileEntry("/home/user/file.txt", 4n),
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
		deleteDirent: deleteDirentMock,
		listDirents: vi.fn(),
		moveDirent: moveDirentMock,
		upsertBlob: upsertBlobMock,
		getBlob: getBlobMock,
		gcOrphanBlobs: vi.fn(),
		loadSubtreeInodes: vi.fn(),
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
		getBlobMock,
		moveDirentMock,
	};
}

// ── writeFile: sets new content in contentCache ───────────────────────────────

describe("SqlFs.writeFile — content cache population", () => {
	let fs: SqlFs;
	let mocks: ReturnType<typeof makeDialect>;

	beforeEach(async () => {
		mocks = makeDialect();
		fs = new SqlFs({ dialect: mocks.dialect, sandboxId: "s1" });
		await fs.ready();
	});

	it("sets new file content in contentCache after write", async () => {
		const content = "hello world";
		const bytes = new TextEncoder().encode(content);

		await fs.writeFile("/home/user/new.txt", content);

		// contentCache should have the new inode (10n from mock)
		expect(fs._contentCacheHas(10n)).toBe(true);
		expect(fs._contentCacheGet(10n)).toEqual(bytes);
	});

	it("second readFile after writeFile does not call getBlob (served from cache)", async () => {
		await fs.writeFile("/home/user/new.txt", "hello");

		// readFile should hit contentCache, not call getBlob
		const result = await fs.readFile("/home/user/new.txt");

		expect(mocks.getBlobMock).not.toHaveBeenCalled();
		expect(result).toBe("hello");
	});

	it("overwrite: read returns new content, not stale cached content", async () => {
		// First write: inodeId=10n with "original"
		await fs.writeFile("/home/user/new.txt", "original");
		expect(fs._contentCacheHas(10n)).toBe(true);

		// Second write: inodeId=11n with "updated" (simulate upsert replacing the entry)
		let callCount = 0;
		mocks.createInodeMock.mockImplementation(async () => {
			callCount++;
			return callCount === 1 ? 11n : 12n;
		});
		mocks.upsertDirentMock.mockResolvedValueOnce(10n); // replaced old inodeId=10n
		mocks.decrementNlinkMock.mockResolvedValueOnce(0);

		await fs.writeFile("/home/user/new.txt", "updated");

		// Should not call getBlob — new content should be in cache under new inodeId
		const result = await fs.readFile("/home/user/new.txt");
		expect(mocks.getBlobMock).not.toHaveBeenCalled();
		expect(result).toBe("updated");
	});
});

// ── rm: deletes from contentCache ────────────────────────────────────────────

describe("SqlFs.rm — content cache invalidation", () => {
	let fs: SqlFs;
	let mocks: ReturnType<typeof makeDialect>;

	beforeEach(async () => {
		mocks = makeDialect();
		fs = new SqlFs({ dialect: mocks.dialect, sandboxId: "s1" });
		await fs.ready();
	});

	it("removes file inode from contentCache when file is deleted", async () => {
		// Pre-populate contentCache for the file at inodeId=4n
		fs._contentCacheSet(4n, new TextEncoder().encode("some content"));
		expect(fs._contentCacheHas(4n)).toBe(true);

		await fs.rm("/home/user/file.txt");

		expect(fs._contentCacheHas(4n)).toBe(false);
	});

	it("recursive rm removes all subtree inodes from contentCache", async () => {
		// file.txt (inodeId=4n) is under /home/user (inodeId=3n)
		fs._contentCacheSet(4n, new TextEncoder().encode("file content"));
		fs._contentCacheSet(3n, new Uint8Array(1)); // simulating a cached dir-inode entry

		await fs.rm("/home/user", { recursive: true });

		expect(fs._contentCacheHas(4n)).toBe(false);
		expect(fs._contentCacheHas(3n)).toBe(false);
	});

	it("contentCache of unrelated inodes is unaffected by rm", async () => {
		fs._contentCacheSet(2n, new Uint8Array(4)); // /home inode
		fs._contentCacheSet(4n, new TextEncoder().encode("file content"));

		await fs.rm("/home/user/file.txt");

		// /home inode should still be cached
		expect(fs._contentCacheHas(2n)).toBe(true);
	});
});

// ── appendFile: invalidates old contentCache entry ───────────────────────────

describe("SqlFs.appendFile — content cache invalidation", () => {
	let fs: SqlFs;
	let mocks: ReturnType<typeof makeDialect>;

	beforeEach(async () => {
		mocks = makeDialect();
		fs = new SqlFs({ dialect: mocks.dialect, sandboxId: "s1" });
		await fs.ready();
	});

	it("invalidates old inode contentCache entry when appending to existing file", async () => {
		// file.txt (inodeId=4n) has stale content in cache
		const stale = new TextEncoder().encode("stale");
		fs._contentCacheSet(4n, stale);
		expect(fs._contentCacheHas(4n)).toBe(true);

		// getBlob returns existing content for merge
		const existing = new TextEncoder().encode("hello");
		mocks.getBlobMock.mockResolvedValueOnce(existing);
		// upsertDirent replaces old dirent pointing at 4n
		mocks.upsertDirentMock.mockResolvedValueOnce(4n);
		mocks.decrementNlinkMock.mockResolvedValueOnce(0);

		await fs.appendFile("/home/user/file.txt", " world");

		// Old inodeId=4n should be evicted from contentCache
		expect(fs._contentCacheHas(4n)).toBe(false);
	});

	it("sets new inode content in contentCache after append", async () => {
		const existing = new TextEncoder().encode("hello");
		mocks.getBlobMock.mockResolvedValueOnce(existing);
		mocks.upsertDirentMock.mockResolvedValueOnce(4n);
		mocks.decrementNlinkMock.mockResolvedValueOnce(0);

		await fs.appendFile("/home/user/file.txt", " world");

		// New inodeId=10n should be in contentCache with merged content
		expect(fs._contentCacheHas(10n)).toBe(true);
		const cached = fs._contentCacheGet(10n);
		expect(new TextDecoder().decode(cached)).toBe("hello world");
	});
});

// ── mv: does NOT invalidate contentCache ─────────────────────────────────────

describe("SqlFs.mv — content cache preservation", () => {
	let fs: SqlFs;
	let mocks: ReturnType<typeof makeDialect>;

	beforeEach(async () => {
		mocks = makeDialect();
		fs = new SqlFs({ dialect: mocks.dialect, sandboxId: "s1" });
		await fs.ready();
	});

	it("mv does not invalidate contentCache (same inodeId, same content)", async () => {
		// Cache the file content before mv
		const content = new TextEncoder().encode("unchanged content");
		fs._contentCacheSet(4n, content);
		expect(fs._contentCacheHas(4n)).toBe(true);

		await fs.mv("/home/user/file.txt", "/home/user/renamed.txt");

		// contentCache entry for inodeId=4n should still be there
		expect(fs._contentCacheHas(4n)).toBe(true);
		expect(fs._contentCacheGet(4n)).toEqual(content);
	});
});

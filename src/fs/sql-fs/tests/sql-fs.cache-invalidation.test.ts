/**
 * Unit tests for SqlFs content cache invalidation on write/delete.
 * US-024: Content cache invalidation on write/delete
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SqlFs } from "../sql-fs.js";
import type { PathCacheEntry, SqlDialect } from "../types.js";

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
	getBlobNoTxMock: ReturnType<typeof vi.fn>;
	moveDirentMock: ReturnType<typeof vi.fn>;
} {
	const createInodeMock = vi.fn(async () => 10n);
	const upsertDirentMock = vi.fn(async () => null as bigint | null);
	const upsertBlobMock = vi.fn(async () => undefined);
	const deleteDirentMock = vi.fn(async () => 4n);
	const decrementNlinkMock = vi.fn(async () => 0);
	const deleteInodeMock = vi.fn(async () => undefined);
	const getBlobMock = vi.fn(async () => null as Uint8Array | null);
	const getBlobNoTxMock = vi.fn(async () => new TextEncoder().encode("file content"));
	const moveDirentMock = vi.fn(async () => undefined);

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
		getBlobNoTx: getBlobNoTxMock,
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
		getBlobMock,
		getBlobNoTxMock,
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

	it("readFile after writeFile is served from cache (no getBlob call)", async () => {
		await fs.writeFile("/home/user/new.txt", "hello");

		// readFile must hit contentCache — getBlobMock (tx-based getBlob) must not be called.
		// getBlobNoTx would throw if called since it's not needed here (cache hit).
		const result = await fs.readFile("/home/user/new.txt");

		expect(mocks.getBlobMock).not.toHaveBeenCalled();
		expect(result).toBe("hello");
	});

	it("overwrite: read returns new content, not stale cached content", async () => {
		// First write: inodeId=10n with "original"
		await fs.writeFile("/home/user/new.txt", "original");

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

// ── appendFile: new inode content is in cache ────────────────────────────────

describe("SqlFs.appendFile — content cache population", () => {
	let fs: SqlFs;
	let mocks: ReturnType<typeof makeDialect>;

	beforeEach(async () => {
		mocks = makeDialect();
		fs = new SqlFs({ dialect: mocks.dialect, sandboxId: "s1" });
		await fs.ready();
	});

	it("readFile after appendFile is served from cache (merged content, no extra DB call)", async () => {
		const existing = new TextEncoder().encode("hello");
		mocks.getBlobMock.mockResolvedValueOnce(existing); // getBlob used during append for existing bytes
		mocks.upsertDirentMock.mockResolvedValueOnce(4n);
		mocks.decrementNlinkMock.mockResolvedValueOnce(0);

		await fs.appendFile("/home/user/file.txt", " world");

		// readFile on the updated path should hit contentCache (new inode 10n was seeded)
		// getBlobMock was already called during appendFile to fetch existing content — clear it.
		mocks.getBlobMock.mockClear();
		const result = await fs.readFile("/home/user/file.txt");
		expect(result).toBe("hello world");
		expect(mocks.getBlobMock).not.toHaveBeenCalled();
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
		// Populate cache for file.txt (inodeId=4n) via readFile
		await fs.readFile("/home/user/file.txt");
		mocks.getBlobNoTxMock.mockClear();

		await fs.mv("/home/user/file.txt", "/home/user/renamed.txt");

		// Reading via the new path should hit the cache (inodeId=4n unchanged)
		const result = await fs.readFile("/home/user/renamed.txt");
		expect(mocks.getBlobNoTxMock).not.toHaveBeenCalled();
		expect(result).toBe("file content");
	});
});

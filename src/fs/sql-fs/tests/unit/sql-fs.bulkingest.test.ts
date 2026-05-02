/**
 * Unit tests for the SqlFs.bulkIngest cache-coherence wrapper.
 *
 * The wrapper validates/normalizes input paths, delegates to `dialect.bulkIngest`
 * inside a write transaction (advisory lock + RLS), merges the returned
 * PathCacheEntry map into `#pathCache` (evicting overwritten inodes from
 * contentCache), and marks the FS dirty.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SqlFs } from "../../sql-fs.js";
import type { BulkIngestFile, PathCacheEntry, SqlDialect } from "../../types.js";

const now = new Date("2026-01-01T00:00:00Z");

function dirEntry(path: string, inodeId: bigint): { path: string } & PathCacheEntry {
	return { path, inodeId, kind: 2, mode: 0o755, size: 0, mtime: now, contentSha256: null, symlinkTarget: null };
}

function cacheEntry(inodeId: bigint, size: number): PathCacheEntry {
	const sha = new Uint8Array(32).fill(0xcd);
	return { inodeId, kind: 1, mode: 0o644, size, mtime: now, contentSha256: sha, symlinkTarget: null };
}

function dirCacheEntry(inodeId: bigint): PathCacheEntry {
	return { inodeId, kind: 2, mode: 0o755, size: 0, mtime: now, contentSha256: null, symlinkTarget: null };
}

function makeDialect(): {
	dialect: SqlDialect<unknown>;
	bulkIngestMock: ReturnType<typeof vi.fn>;
	loadAllPathsMock: ReturnType<typeof vi.fn>;
	transactionMock: ReturnType<typeof vi.fn>;
	setSandboxContextWithLockMock: ReturnType<typeof vi.fn>;
} {
	const transactionMock = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({}));
	const bulkIngestMock = vi.fn(async () => new Map<string, PathCacheEntry>());
	const loadAllPathsMock = vi.fn(async () => [] as Array<{ path: string } & PathCacheEntry>);
	const setSandboxContextWithLockMock = vi.fn();
	const dialect: SqlDialect<unknown> = {
		connect: vi.fn(),
		disconnect: vi.fn(),
		transaction: transactionMock,
		setSandboxContext: vi.fn(),
		setSandboxContextWithLock: setSandboxContextWithLockMock,
		loadAllPaths: loadAllPathsMock,
		createSandbox: vi.fn(),
		deleteSandbox: vi.fn(),
		sandboxExists: vi.fn(),
		getSandboxMeta: vi.fn(),
		updateSandboxMeta: vi.fn(),
		createInode: vi.fn(),
		getInode: vi.fn(),
		updateInode: vi.fn(),
		deleteInode: vi.fn(),
		incrementNlink: vi.fn(),
		decrementNlink: vi.fn(),
		insertDirent: vi.fn(),
		upsertDirent: vi.fn(),
		deleteDirent: vi.fn(),
		listDirents: vi.fn(),
		moveDirent: vi.fn(),
		upsertBlob: vi.fn(),
		getBlob: vi.fn(),
		getBlobNoTx: vi.fn(),
		gcOrphanBlobs: vi.fn(),
		getBlobsForSandbox: vi.fn(async () => []),
		loadSubtreeInodes: vi.fn(),
		bulkIngest: bulkIngestMock,
		resolvePath: vi.fn(),
	} as unknown as SqlDialect<unknown>;
	return { dialect, bulkIngestMock, loadAllPathsMock, transactionMock, setSandboxContextWithLockMock };
}

describe("SqlFs.bulkIngest", () => {
	let bulkIngestMock: ReturnType<typeof vi.fn>;
	let loadAllPathsMock: ReturnType<typeof vi.fn>;
	let transactionMock: ReturnType<typeof vi.fn>;
	let setSandboxContextWithLockMock: ReturnType<typeof vi.fn>;
	let fs: SqlFs;

	beforeEach(async () => {
		const m = makeDialect();
		bulkIngestMock = m.bulkIngestMock;
		loadAllPathsMock = m.loadAllPathsMock;
		transactionMock = m.transactionMock;
		setSandboxContextWithLockMock = m.setSandboxContextWithLockMock;

		loadAllPathsMock.mockResolvedValueOnce([dirEntry("/", 1n)]);
		fs = new SqlFs({ dialect: m.dialect, sandboxId: "s1" });
		await fs.ready();
	});

	it("is a no-op for an empty file list — no transaction, no dirty flip", async () => {
		const txCallsBefore = transactionMock.mock.calls.length;

		await fs.bulkIngest([]);

		expect(bulkIngestMock).not.toHaveBeenCalled();
		expect(transactionMock.mock.calls.length).toBe(txCallsBefore);
		expect(fs.wasDirty()).toBe(false);
	});

	it("opens one write tx (with advisory lock), invokes dialect.bulkIngest, merges cache, sets dirty", async () => {
		const lockCallsBefore = setSandboxContextWithLockMock.mock.calls.length;
		const loadCallsBefore = loadAllPathsMock.mock.calls.length;

		const files: BulkIngestFile[] = [{ path: "/a.txt", content: new TextEncoder().encode("a"), mode: 0o644 }];

		bulkIngestMock.mockResolvedValueOnce(new Map([["/a.txt", cacheEntry(2n, 1)]]));

		await fs.bulkIngest(files);

		expect(bulkIngestMock).toHaveBeenCalledOnce();
		expect(bulkIngestMock.mock.calls[0]?.[1]).toEqual(files);
		expect(setSandboxContextWithLockMock.mock.calls.length).toBeGreaterThan(lockCallsBefore);
		// No reload() — loadAllPaths should NOT be called after the mutation
		expect(loadAllPathsMock.mock.calls.length).toBe(loadCallsBefore);
		expect(fs.wasDirty()).toBe(true);
	});

	it("after bulkIngest, stat() returns entries from the merged cache (no reload needed)", async () => {
		const files: BulkIngestFile[] = [{ path: "/home/user/x.txt", content: new TextEncoder().encode("x"), mode: 0o644 }];

		bulkIngestMock.mockResolvedValueOnce(
			new Map<string, PathCacheEntry>([
				["/home", dirCacheEntry(10n)],
				["/home/user", dirCacheEntry(11n)],
				["/home/user/x.txt", cacheEntry(20n, 1)],
			]),
		);

		await fs.bulkIngest(files);

		const stat = await fs.stat("/home/user/x.txt");
		expect(stat.isFile).toBe(true);
		expect(stat.size).toBe(1);
	});

	it("propagates dialect.bulkIngest errors without modifying cache", async () => {
		const loadCallsBefore = loadAllPathsMock.mock.calls.length;
		bulkIngestMock.mockRejectedValueOnce(Object.assign(new Error("boom"), { code: "EINVAL" }));

		const files: BulkIngestFile[] = [{ path: "/a.txt", content: new TextEncoder().encode("a"), mode: 0o644 }];

		await expect(fs.bulkIngest(files)).rejects.toMatchObject({ code: "EINVAL" });
		expect(loadAllPathsMock.mock.calls.length).toBe(loadCallsBefore);
		expect(fs.wasDirty()).toBe(false);
	});

	it("normalizes paths through validatePath before forwarding to the dialect", async () => {
		bulkIngestMock.mockResolvedValueOnce(new Map<string, PathCacheEntry>());

		await fs.bulkIngest([
			{ path: "/home/user/./a.txt", content: new TextEncoder().encode("a"), mode: 0o644 },
			{ path: "/home/user/sub/../b.txt", content: new TextEncoder().encode("b"), mode: 0o644 },
		]);

		expect(bulkIngestMock).toHaveBeenCalledOnce();
		const forwarded = bulkIngestMock.mock.calls[0]?.[1] as BulkIngestFile[];
		expect(forwarded.map((f) => f.path)).toEqual(["/home/user/a.txt", "/home/user/b.txt"]);
	});

	it("rejects EINVAL on null byte in path before opening a transaction", async () => {
		const txCallsBefore = transactionMock.mock.calls.length;

		await expect(
			fs.bulkIngest([{ path: "/home/user/\0bad.txt", content: new Uint8Array(0), mode: 0o644 }]),
		).rejects.toMatchObject({ code: "EINVAL" });

		expect(bulkIngestMock).not.toHaveBeenCalled();
		expect(transactionMock.mock.calls.length).toBe(txCallsBefore);
	});

	it("rejects EEXIST when two inputs normalize to the same path, before opening a transaction", async () => {
		const txCallsBefore = transactionMock.mock.calls.length;

		await expect(
			fs.bulkIngest([
				{ path: "/home/user/a.txt", content: new TextEncoder().encode("first"), mode: 0o644 },
				{ path: "/home/user/./a.txt", content: new TextEncoder().encode("second"), mode: 0o644 },
			]),
		).rejects.toMatchObject({ code: "EEXIST" });

		expect(bulkIngestMock).not.toHaveBeenCalled();
		expect(transactionMock.mock.calls.length).toBe(txCallsBefore);
	});

	it("serves new content from cache after overwrite (old inode evicted, new inode seeded)", async () => {
		// First ingest: /a.txt → inode 5n, content "old" — bulkIngest seeds cache for 5n
		bulkIngestMock.mockResolvedValueOnce(new Map([["/a.txt", cacheEntry(5n, 3)]]));
		await fs.bulkIngest([{ path: "/a.txt", content: new TextEncoder().encode("old"), mode: 0o644 }]);

		// Second ingest: /a.txt → inode 6n, content "new" — evicts 5n, seeds 6n
		bulkIngestMock.mockResolvedValueOnce(new Map([["/a.txt", cacheEntry(6n, 3)]]));
		await fs.bulkIngest([{ path: "/a.txt", content: new TextEncoder().encode("new"), mode: 0o644 }]);

		// Reading must return new content from cache — getBlobNoTx (vi.fn → undefined) would produce
		// an empty buffer, so the correct result here proves a cache hit with the seeded bytes.
		const result = await fs.readFileBuffer("/a.txt");
		expect(result).toEqual(new TextEncoder().encode("new"));
	});
});

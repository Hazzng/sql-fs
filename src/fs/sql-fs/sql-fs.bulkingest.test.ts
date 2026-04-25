/**
 * Unit tests for the SqlFs.bulkIngest cache-coherence wrapper.
 *
 * The wrapper is what differentiates the public API method from the dialect
 * primitive: it must run inside `#withTx` (acquires advisory lock + RLS),
 * mark the FS dirty so multi-replica version bookkeeping fires, and refresh
 * `pathCache` via `reload()` so subsequent reads see the new entries.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SqlFs } from "./sql-fs.js";
import type { BulkIngestFile, PathCacheEntry, SqlDialect } from "./types.js";

const now = new Date("2026-01-01T00:00:00Z");

function dirEntry(path: string, inodeId: bigint): { path: string } & PathCacheEntry {
	return { path, inodeId, kind: 2, mode: 0o755, size: 0, mtime: now, contentSha256: null, symlinkTarget: null };
}

function fileEntry(path: string, inodeId: bigint, size: number): { path: string } & PathCacheEntry {
	const sha = new Uint8Array(32).fill(0xcd);
	return { path, inodeId, kind: 1, mode: 0o644, size, mtime: now, contentSha256: sha, symlinkTarget: null };
}

function makeDialect(): {
	dialect: SqlDialect<unknown>;
	bulkIngestMock: ReturnType<typeof vi.fn>;
	loadAllPathsMock: ReturnType<typeof vi.fn>;
	transactionMock: ReturnType<typeof vi.fn>;
	setSandboxContextWithLockMock: ReturnType<typeof vi.fn>;
} {
	const transactionMock = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({}));
	const bulkIngestMock = vi.fn();
	const loadAllPathsMock = vi.fn(async () => [] as Array<{ path: string } & PathCacheEntry>);
	const setSandboxContextWithLockMock = vi.fn();
	// `as unknown as SqlDialect<unknown>` (not `satisfies`) is required here because
	// `SqlDialect.transaction` is a generic method `<T>(fn) => Promise<T>`, and a
	// `vi.fn(...)` mock collapses the type parameter so it cannot structurally
	// match the variance. Same pattern used by the other dialect-mock tests in
	// this directory (sql-fs.read.test.ts etc.).
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
		gcOrphanBlobs: vi.fn(),
		loadSubtreeInodes: vi.fn(),
		bulkIngest: bulkIngestMock,
		resolvePath: vi.fn(),
	} as unknown as SqlDialect<unknown>;
	return { dialect, bulkIngestMock, loadAllPathsMock, transactionMock, setSandboxContextWithLockMock };
}

describe("SqlFs.bulkIngest", () => {
	let dialect: SqlDialect<unknown>;
	let bulkIngestMock: ReturnType<typeof vi.fn>;
	let loadAllPathsMock: ReturnType<typeof vi.fn>;
	let transactionMock: ReturnType<typeof vi.fn>;
	let setSandboxContextWithLockMock: ReturnType<typeof vi.fn>;
	let fs: SqlFs;

	beforeEach(async () => {
		const m = makeDialect();
		dialect = m.dialect;
		bulkIngestMock = m.bulkIngestMock;
		loadAllPathsMock = m.loadAllPathsMock;
		transactionMock = m.transactionMock;
		setSandboxContextWithLockMock = m.setSandboxContextWithLockMock;

		// Initial pathCache: just /
		loadAllPathsMock.mockResolvedValueOnce([dirEntry("/", 1n)]);
		fs = new SqlFs({ dialect, sandboxId: "s1" });
		await fs.ready();
	});

	it("is a no-op for an empty file list — no transaction, no reload, no dirty flip", async () => {
		const txCallsBefore = transactionMock.mock.calls.length;
		const loadCallsBefore = loadAllPathsMock.mock.calls.length;

		await fs.bulkIngest([]);

		expect(bulkIngestMock).not.toHaveBeenCalled();
		expect(transactionMock.mock.calls.length).toBe(txCallsBefore);
		expect(loadAllPathsMock.mock.calls.length).toBe(loadCallsBefore);
		expect(fs.wasDirty()).toBe(false);
	});

	it("opens one write tx (with advisory lock), invokes dialect.bulkIngest, sets dirty, then reloads", async () => {
		const lockCallsBefore = setSandboxContextWithLockMock.mock.calls.length;
		const loadCallsBefore = loadAllPathsMock.mock.calls.length;

		const files: BulkIngestFile[] = [{ path: "/a.txt", content: new TextEncoder().encode("a"), mode: 0o644 }];

		// Reload after bulkIngest will call loadAllPaths once more.
		loadAllPathsMock.mockResolvedValueOnce([dirEntry("/", 1n), fileEntry("/a.txt", 2n, 1)]);

		await fs.bulkIngest(files);

		expect(bulkIngestMock).toHaveBeenCalledOnce();
		// bulkIngest forwards a normalized copy (paths run through validatePath),
		// not the caller's array — assert by value, not by reference.
		expect(bulkIngestMock.mock.calls[0]?.[1]).toEqual(files);
		// Advisory lock must be acquired (write path), not the read-only setSandboxContext.
		expect(setSandboxContextWithLockMock.mock.calls.length).toBeGreaterThan(lockCallsBefore);
		// reload() ran loadAllPaths exactly once more after the mutation.
		expect(loadAllPathsMock.mock.calls.length).toBe(loadCallsBefore + 1);
		// dirty must be set AFTER reload() so publishVersionIfDirty sees the
		// mutation and bumps the cross-replica version counter.
		expect(fs.wasDirty()).toBe(true);
	});

	it("after bulkIngest + reload, stat() returns the new entry from the refreshed pathCache", async () => {
		const files: BulkIngestFile[] = [{ path: "/home/user/x.txt", content: new TextEncoder().encode("x"), mode: 0o644 }];

		// Stub loadAllPaths to return the post-ingest tree on reload.
		loadAllPathsMock.mockResolvedValueOnce([
			dirEntry("/", 1n),
			dirEntry("/home", 10n),
			dirEntry("/home/user", 11n),
			fileEntry("/home/user/x.txt", 20n, 1),
		]);

		await fs.bulkIngest(files);

		const stat = await fs.stat("/home/user/x.txt");
		expect(stat.isFile).toBe(true);
		expect(stat.size).toBe(1);
	});

	it("propagates dialect.bulkIngest errors and does NOT call reload()", async () => {
		const loadCallsBefore = loadAllPathsMock.mock.calls.length;
		bulkIngestMock.mockRejectedValueOnce(Object.assign(new Error("boom"), { code: "EINVAL" }));

		const files: BulkIngestFile[] = [{ path: "/a.txt", content: new TextEncoder().encode("a"), mode: 0o644 }];

		await expect(fs.bulkIngest(files)).rejects.toMatchObject({ code: "EINVAL" });
		expect(loadAllPathsMock.mock.calls.length).toBe(loadCallsBefore);
	});

	it("normalizes paths through validatePath before forwarding to the dialect", async () => {
		loadAllPathsMock.mockResolvedValueOnce([dirEntry("/", 1n)]);

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
});

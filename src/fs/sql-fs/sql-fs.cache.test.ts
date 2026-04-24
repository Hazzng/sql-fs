/**
 * Unit tests for SqlFs pathCache initialization.
 * US-019: pathCache initialization from loadAllPaths
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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("SqlFs.ready() — pathCache initialization", () => {
	const sandboxId = "test-sandbox";

	const mockEntries = [
		dirEntry("/", 1n),
		dirEntry("/home", 2n),
		dirEntry("/home/user", 3n),
		fileEntry("/home/user/hello.txt", 4n, 13),
	];

	// Keep a reference to the mock so we can change its behaviour per test
	let loadAllPathsMock: ReturnType<typeof vi.fn>;
	let setSandboxContextMock: ReturnType<typeof vi.fn>;
	let transactionMock: ReturnType<typeof vi.fn>;
	let dialect: SqlDialect<unknown>;
	let fs: SqlFs;

	beforeEach(() => {
		loadAllPathsMock = vi.fn(async () => mockEntries);
		setSandboxContextMock = vi.fn();
		transactionMock = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({}));

		// Cast via unknown: vi.fn() loses the generic <T> on transaction<T>
		dialect = {
			connect: vi.fn(),
			disconnect: vi.fn(),
			transaction: transactionMock,
			setSandboxContext: setSandboxContextMock,
			setSandboxContextWithLock: vi.fn(),
			loadAllPaths: loadAllPathsMock,
			createSandbox: vi.fn(),
			deleteSandbox: vi.fn(),
			sandboxExists: vi.fn(),
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
			bulkIngest: vi.fn(),
			resolvePath: vi.fn(),
		} as unknown as SqlDialect<unknown>;

		fs = new SqlFs({ dialect, sandboxId });
	});

	it("calls setSandboxContext then loadAllPaths inside a transaction", async () => {
		await fs.ready();

		expect(transactionMock).toHaveBeenCalledOnce();
		expect(setSandboxContextMock).toHaveBeenCalledOnce();
		expect(loadAllPathsMock).toHaveBeenCalledOnce();

		// setSandboxContext must be called with the correct sandboxId
		expect(setSandboxContextMock).toHaveBeenCalledWith(expect.anything(), sandboxId);
	});

	it("getAllPaths() returns all paths loaded into the cache", async () => {
		await fs.ready();

		const paths = fs.getAllPaths();
		expect(paths).toHaveLength(4);
		expect(paths).toContain("/");
		expect(paths).toContain("/home");
		expect(paths).toContain("/home/user");
		expect(paths).toContain("/home/user/hello.txt");
	});

	it("getAllPaths() returns empty array before ready() is called", () => {
		const paths = fs.getAllPaths();
		expect(paths).toEqual([]);
	});

	it("ready() clears stale cache on re-initialisation", async () => {
		// Populate with the initial 4-entry set
		await fs.ready();
		expect(fs.getAllPaths()).toHaveLength(4);

		// Override: next call to loadAllPaths returns only the root
		loadAllPathsMock.mockResolvedValueOnce([dirEntry("/", 1n)]);

		await fs.ready();
		expect(fs.getAllPaths()).toHaveLength(1);
		expect(fs.getAllPaths()).toContain("/");
	});
});

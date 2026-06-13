/**
 * Unit tests for F9a (issue #138): SqlFs.writeFile must evict the displaced
 * inode's bytes from #contentCache on overwrite. inode ids are never reused
 * (BIGSERIAL), so a non-evicted old entry is dead LRU weight. The empty-file
 * overwrite case is the critical one: the seeding `set` is guarded by
 * `byteLength > 0`, so without an explicit evict the old entry is never
 * displaced by an overwriting `set`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SqlFs } from "../../sql-fs.js";
import type { PathCacheEntry, SqlDialect } from "../../types.js";

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

function makeDialect(): {
	dialect: SqlDialect<unknown>;
	createInodeMock: ReturnType<typeof vi.fn>;
	upsertDirentMock: ReturnType<typeof vi.fn>;
	decrementNlinkMock: ReturnType<typeof vi.fn>;
} {
	// Sequential (non-composite) write path: each createInode hands out a fresh id.
	let nextInode = 11n;
	const createInodeMock = vi.fn(async () => nextInode++);
	const upsertDirentMock = vi.fn(async () => 4n as bigint | null); // existing.txt currently maps to inode 4n
	const decrementNlinkMock = vi.fn(async () => 0);

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
		updateInode: vi.fn(),
		deleteInode: vi.fn(async () => undefined),
		incrementNlink: vi.fn(),
		decrementNlink: decrementNlinkMock,
		insertDirent: vi.fn(),
		upsertDirent: upsertDirentMock,
		deleteDirent: vi.fn(),
		listDirents: vi.fn(),
		moveDirent: vi.fn(),
		upsertBlob: vi.fn(async () => undefined),
		getBlob: vi.fn(async () => null as Uint8Array | null),
		getBlobNoTx: vi.fn(async () => null as Uint8Array | null),
		gcOrphanBlobs: vi.fn(),
		getBlobsForSandbox: vi.fn(async () => []),
		loadSubtreeInodes: vi.fn(async () => []),
		bulkIngest: vi.fn(),
		resolvePath: vi.fn(),
	} as unknown as SqlDialect<unknown>;

	return { dialect, createInodeMock, upsertDirentMock, decrementNlinkMock };
}

describe("SqlFs.writeFile — contentCache eviction on overwrite (F9a)", () => {
	let fs: SqlFs;
	let mocks: ReturnType<typeof makeDialect>;

	beforeEach(async () => {
		mocks = makeDialect();
		fs = new SqlFs({ dialect: mocks.dialect, sandboxId: "s1" });
		await fs.ready();
	});

	it("evicts the displaced inode when overwriting a cached non-empty file with non-empty content", async () => {
		// First write: existing.txt → inode 11n (seeded in contentCache).
		await fs.writeFile("/home/user/existing.txt", "version one");
		const firstInode = mocks.createInodeMock.mock.results[0]!.value as bigint;
		expect(fs._getContentCache().has(await firstInode)).toBe(true);

		// Overwrite: existing.txt → inode 12n; old inode 11n must be evicted.
		await fs.writeFile("/home/user/existing.txt", "version two");
		const secondInode = mocks.createInodeMock.mock.results[1]!.value as bigint;

		expect(fs._getContentCache().has(await firstInode)).toBe(false);
		expect(fs._getContentCache().has(await secondInode)).toBe(true);
		// New content is served from cache (no DB read).
		expect(await fs.readFile("/home/user/existing.txt")).toBe("version two");
	});

	it("evicts the displaced inode when overwriting a cached non-empty file with an EMPTY file", async () => {
		// First write: existing.txt → inode 11n (seeded in contentCache).
		await fs.writeFile("/home/user/existing.txt", "version one");
		const firstInode = mocks.createInodeMock.mock.results[0]!.value as bigint;
		const byteCountBefore = fs._getContentCache().calculatedSize;
		expect(fs._getContentCache().has(await firstInode)).toBe(true);
		expect(byteCountBefore).toBeGreaterThan(0);

		// Overwrite with empty content: there is no seeding `set` (guarded by
		// byteLength > 0), so the old entry must be evicted explicitly.
		await fs.writeFile("/home/user/existing.txt", "");
		const secondInode = mocks.createInodeMock.mock.results[1]!.value as bigint;

		expect(fs._getContentCache().has(await firstInode)).toBe(false);
		expect(fs._getContentCache().has(await secondInode)).toBe(false); // empty file not cached
		// LRU byte count drops back to zero — no orphaned weight.
		expect(fs._getContentCache().calculatedSize).toBe(0);
	});

	it("does not evict when the path is new (no displaced inode)", async () => {
		await fs.writeFile("/home/user/brand-new.txt", "fresh");
		const inode = mocks.createInodeMock.mock.results[0]!.value as bigint;

		expect(fs._getContentCache().has(await inode)).toBe(true);
		expect(await fs.readFile("/home/user/brand-new.txt")).toBe("fresh");
	});
});

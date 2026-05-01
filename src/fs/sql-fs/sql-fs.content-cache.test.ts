/**
 * Unit tests for SqlFs contentCache (LRU).
 * US-022: LRU content cache setup
 *
 * Cache behaviour is verified through the public API: a readFileBuffer miss
 * calls getBlobNoTx; a hit does not. LRU eviction and promotion are verified
 * by observing which subsequent reads hit the DB.
 */

import { describe, expect, it, vi } from "vitest";
import { SqlFs } from "./sql-fs.js";
import type { PathCacheEntry, SqlDialect } from "./types.js";
import { INODE_KIND } from "./types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const now = new Date("2026-01-01T00:00:00Z");

function fileEntry(path: string, inodeId: bigint, size: number): { path: string } & PathCacheEntry {
	return {
		path,
		inodeId,
		kind: INODE_KIND.FILE,
		mode: 0o644,
		size,
		mtime: now,
		contentSha256: new Uint8Array(32).fill(Number(inodeId)),
		symlinkTarget: null,
	};
}

function makeBytes(size: number): Uint8Array {
	return new Uint8Array(size).fill(1);
}

function makeDialect(
	paths: Array<{ path: string } & PathCacheEntry>,
	blobsByInodeId: Map<bigint, Uint8Array>,
): { dialect: SqlDialect<unknown>; getBlobNoTxMock: ReturnType<typeof vi.fn> } {
	const getBlobNoTxMock = vi.fn(async (sha256: Uint8Array) => {
		for (const [inodeId, data] of blobsByInodeId) {
			const expected = new Uint8Array(32).fill(Number(inodeId));
			if (sha256.every((b, i) => b === expected[i])) return data;
		}
		return null;
	});

	const dialect: SqlDialect<unknown> = {
		connect: vi.fn(),
		disconnect: vi.fn(),
		transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
		setSandboxContext: vi.fn(),
		setSandboxContextWithLock: vi.fn(),
		loadAllPaths: vi.fn(async () => paths),
		createSandbox: vi.fn(),
		deleteSandbox: vi.fn(),
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
		getBlobNoTx: getBlobNoTxMock,
		gcOrphanBlobs: vi.fn(),
		getBlobsForSandbox: vi.fn(async () => []),
		loadSubtreeInodes: vi.fn(),
		bulkIngest: vi.fn(),
		resolvePath: vi.fn(),
	} as unknown as SqlDialect<unknown>;

	return { dialect, getBlobNoTxMock };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("SqlFs contentCache — LRU setup", () => {
	it("serves readFileBuffer from cache on second read (no getBlobNoTx on cache hit)", async () => {
		const data = makeBytes(10);
		const blobs = new Map([[1n, data]]);
		const { dialect, getBlobNoTxMock } = makeDialect([fileEntry("/f.txt", 1n, 10)], blobs);
		const fs = new SqlFs({ dialect, sandboxId: "s1" });
		await fs.ready();

		await fs.readFileBuffer("/f.txt"); // miss → getBlobNoTx called
		expect(getBlobNoTxMock).toHaveBeenCalledOnce();

		await fs.readFileBuffer("/f.txt"); // hit → no getBlobNoTx call
		expect(getBlobNoTxMock).toHaveBeenCalledOnce(); // still once
	});

	it("cache miss calls getBlobNoTx on every new read", async () => {
		const blobs = new Map([
			[1n, makeBytes(5)],
			[2n, makeBytes(5)],
		]);
		const { dialect, getBlobNoTxMock } = makeDialect([fileEntry("/f1.txt", 1n, 5), fileEntry("/f2.txt", 2n, 5)], blobs);
		const fs = new SqlFs({ dialect, sandboxId: "s1" });
		await fs.ready();

		await fs.readFileBuffer("/f1.txt");
		await fs.readFileBuffer("/f2.txt");
		expect(getBlobNoTxMock).toHaveBeenCalledTimes(2);
	});

	it("evicts oldest-accessed entry when byte budget is exceeded", async () => {
		// Budget: 25 bytes. Three 10-byte files → adding file3 evicts file1 (LRU).
		const blobs = new Map([
			[1n, makeBytes(10)],
			[2n, makeBytes(10)],
			[3n, makeBytes(10)],
		]);
		const { dialect, getBlobNoTxMock } = makeDialect(
			[fileEntry("/f1.txt", 1n, 10), fileEntry("/f2.txt", 2n, 10), fileEntry("/f3.txt", 3n, 10)],
			blobs,
		);
		const fs = new SqlFs({ dialect, sandboxId: "s1", contentCacheMaxBytes: 25 });
		await fs.ready();

		await fs.readFileBuffer("/f1.txt"); // oldest
		await fs.readFileBuffer("/f2.txt");
		await fs.readFileBuffer("/f3.txt"); // newest; adding this should evict f1 (LRU)
		getBlobNoTxMock.mockClear();

		// f2 and f3 are still in cache — must be hits (no DB calls)
		await fs.readFileBuffer("/f2.txt");
		await fs.readFileBuffer("/f3.txt");
		expect(getBlobNoTxMock).not.toHaveBeenCalled();

		// f1 was evicted — must be a miss
		await fs.readFileBuffer("/f1.txt");
		expect(getBlobNoTxMock).toHaveBeenCalledOnce();
	});

	it("promotes accessed entry so it is not evicted first", async () => {
		// Budget: 20 bytes. Read f1, f2 (fills budget), re-read f1 (promotes), read f3 (evicts f2).
		const blobs = new Map([
			[1n, makeBytes(10)],
			[2n, makeBytes(10)],
			[3n, makeBytes(10)],
		]);
		const { dialect, getBlobNoTxMock } = makeDialect(
			[fileEntry("/f1.txt", 1n, 10), fileEntry("/f2.txt", 2n, 10), fileEntry("/f3.txt", 3n, 10)],
			blobs,
		);
		const fs = new SqlFs({ dialect, sandboxId: "s1", contentCacheMaxBytes: 20 });
		await fs.ready();

		await fs.readFileBuffer("/f1.txt"); // miss
		await fs.readFileBuffer("/f2.txt"); // miss, budget full
		await fs.readFileBuffer("/f1.txt"); // hit, promotes f1 to MRU
		await fs.readFileBuffer("/f3.txt"); // miss, evicts f2 (LRU, not f1)
		getBlobNoTxMock.mockClear();

		await fs.readFileBuffer("/f1.txt"); // still cached
		await fs.readFileBuffer("/f3.txt"); // still cached
		expect(getBlobNoTxMock).not.toHaveBeenCalled();

		await fs.readFileBuffer("/f2.txt"); // evicted → DB call
		expect(getBlobNoTxMock).toHaveBeenCalledOnce();
	});

	it("respects contentCacheMaxBytes option (default 50 MB)", async () => {
		const blobs = new Map<bigint, Uint8Array>();
		const paths: Array<{ path: string } & PathCacheEntry> = [];
		for (let i = 1n; i <= 100n; i++) {
			blobs.set(i, makeBytes(1));
			paths.push(fileEntry(`/f${i}.txt`, i, 1));
		}
		const { dialect, getBlobNoTxMock } = makeDialect(paths, blobs);
		const fs = new SqlFs({ dialect, sandboxId: "s1" });
		await fs.ready();

		// First pass: all 100 misses (100 bytes << 50 MB budget)
		for (let i = 1n; i <= 100n; i++) {
			await fs.readFileBuffer(`/f${i}.txt`);
		}
		expect(getBlobNoTxMock).toHaveBeenCalledTimes(100);
		getBlobNoTxMock.mockClear();

		// Second pass: all should be cache hits
		for (let i = 1n; i <= 100n; i++) {
			await fs.readFileBuffer(`/f${i}.txt`);
		}
		expect(getBlobNoTxMock).not.toHaveBeenCalled();
	});
});

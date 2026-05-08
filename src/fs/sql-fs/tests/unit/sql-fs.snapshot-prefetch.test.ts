/**
 * Unit tests for SqlFs synchronous blob pre-fetch on snapshot hit.
 *
 * Verifies ACs from GitHub issue #55:
 *  - On snapshot hit, mget pre-populates contentCache before ready() returns
 *  - Partial Redis hits populate only the hit inodes; misses fall through
 *  - No pre-fetch when blobCache is absent (undefined)
 *  - No pre-fetch on snapshot miss (falls through to loadAllPaths)
 *  - Background prewarm still fires regardless (no regression)
 *  - reload() is unaffected (no prefetch; background prewarm fires as usual)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RedisBlobCache } from "../../redis-blob-cache.js";
import type { RedisPathSnapshot } from "../../redis-path-snapshot.js";
import { SqlFs } from "../../sql-fs.js";
import type { PathCacheEntry, SqlDialect } from "../../types.js";
import { INODE_KIND } from "../../types.js";

// ── Shared fixtures ───────────────────────────────────────────────────────────

const now = new Date("2026-01-01T00:00:00Z");
const SANDBOX_ID = "sb-prefetch";
const TENANT_ID = "tenant-a";
const VERSION = 3;

function sha(byte: number): Uint8Array {
	return new Uint8Array(32).fill(byte);
}

function makeBytes(size: number, fill = 0xab): Uint8Array {
	return new Uint8Array(size).fill(fill);
}

function fileEntry(path: string, inodeId: bigint, shaFill: number, size = 10): PathCacheEntry & { path: string } {
	return {
		path,
		inodeId,
		kind: INODE_KIND.FILE,
		mode: 0o644,
		size,
		mtime: now,
		contentSha256: sha(shaFill),
		symlinkTarget: null,
	};
}

function dirEntry(path: string, inodeId: bigint): PathCacheEntry & { path: string } {
	return {
		path,
		inodeId,
		kind: INODE_KIND.DIRECTORY,
		mode: 0o755,
		size: 0,
		mtime: now,
		contentSha256: null,
		symlinkTarget: null,
	};
}

// ── Stub factories ────────────────────────────────────────────────────────────

function makeDialect(pathEntries: Array<PathCacheEntry & { path: string }> = []): {
	dialect: SqlDialect<unknown>;
	getBlobsForSandboxMock: ReturnType<typeof vi.fn>;
	getBlobNoTxMock: ReturnType<typeof vi.fn>;
} {
	const getBlobsForSandboxMock = vi.fn(async () => []);
	const getBlobNoTxMock = vi.fn(async () => new Uint8Array([0xff]));
	const dialect: SqlDialect<unknown> = {
		connect: vi.fn(),
		disconnect: vi.fn(),
		transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
		setSandboxContext: vi.fn(),
		setSandboxContextWithLock: vi.fn(),
		loadAllPaths: vi.fn(async () => pathEntries),
		createSandbox: vi.fn(),
		deleteSandbox: vi.fn(),
		sandboxExists: vi.fn(),
		getSandboxMeta: vi.fn(),
		updateSandboxMeta: vi.fn(),
		listSandboxes: vi.fn(),
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
		getBlobsForSandbox: getBlobsForSandboxMock,
		gcOrphanBlobs: vi.fn(),
		loadSubtreeInodes: vi.fn(),
		bulkIngest: vi.fn(),
		resolvePath: vi.fn(),
	} as unknown as SqlDialect<unknown>;
	return { dialect, getBlobsForSandboxMock, getBlobNoTxMock };
}

/**
 * Builds a fake Redis client that returns VERSION for the version counter key
 * and null for everything else. Pass `versionOverride` to simulate a mismatch.
 */
function makeRedis(versionOverride: number | null = VERSION) {
	return {
		get: vi.fn(async (_key: string) => (versionOverride === null ? null : String(versionOverride))),
	} as unknown as import("ioredis").Redis;
}

/**
 * Builds a RedisPathSnapshot stub that returns a snapshot with the given
 * entries at VERSION. Pass `snapVersion` to simulate a stale snapshot.
 */
function makeSnapshot(snapEntries: Array<PathCacheEntry & { path: string }>, snapVersion = VERSION): RedisPathSnapshot {
	const entries = new Map<string, PathCacheEntry>();
	for (const { path, ...rest } of snapEntries) {
		entries.set(path, rest);
	}
	return {
		read: vi.fn(async () => ({ version: snapVersion, entries })),
		write: vi.fn(),
		delete: vi.fn(),
	} as unknown as RedisPathSnapshot;
}

/**
 * Builds a RedisBlobCache stub. `hitMap` maps sha-fill-byte → blob data.
 * sha256s whose fill byte is not in the map return null (Redis miss).
 */
function makeBlobCache(hitMap: Map<number, Uint8Array>): {
	blobCache: RedisBlobCache;
	mgetMock: ReturnType<typeof vi.fn>;
} {
	const mgetMock = vi.fn(async (sha256s: ReadonlyArray<Uint8Array>) => {
		return sha256s.map((s) => {
			const fill = s[0] ?? 0;
			return hitMap.get(fill) ?? null;
		});
	});
	const blobCache = { mget: mgetMock } as unknown as RedisBlobCache;
	return { blobCache, mgetMock };
}

// ── Helpers for prewarm settlement ───────────────────────────────────────────

/** Drains the microtask queue enough for background tasks to settle. */
async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

// ── Test suites ───────────────────────────────────────────────────────────────

describe("SqlFs snapshot blob pre-fetch — full hit", () => {
	let logSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("ready() returns with contentCache already warm; readFile does not hit Postgres", async () => {
		const f1 = fileEntry("/a.txt", 1n, 0x01);
		const f2 = fileEntry("/b.txt", 2n, 0x02);
		const hitMap = new Map([
			[0x01, makeBytes(8, 0x11)],
			[0x02, makeBytes(8, 0x22)],
		]);

		const { dialect, getBlobNoTxMock } = makeDialect();
		const redis = makeRedis();
		const snapshot = makeSnapshot([f1, f2]);
		const { blobCache, mgetMock } = makeBlobCache(hitMap);

		const fs = new SqlFs({
			dialect,
			sandboxId: SANDBOX_ID,
			tenantId: TENANT_ID,
			redis,
			pathSnapshot: snapshot,
			blobCache,
		});
		await fs.ready();

		// mget was called once with both sha256s
		expect(mgetMock).toHaveBeenCalledOnce();
		const [sha256Args] = mgetMock.mock.calls[0] as [Uint8Array[]];
		expect(sha256Args).toHaveLength(2);

		// Both files are now warm — subsequent reads must not hit Postgres
		const r1 = await fs.readFileBuffer("/a.txt");
		const r2 = await fs.readFileBuffer("/b.txt");
		expect(getBlobNoTxMock).not.toHaveBeenCalled();
		expect(r1).toEqual(hitMap.get(0x01));
		expect(r2).toEqual(hitMap.get(0x02));
	});

	it("logs snapshot_blob_prefetch_ok with correct counts", async () => {
		const f1 = fileEntry("/x.txt", 1n, 0x01);
		const hitMap = new Map([[0x01, makeBytes(4, 0xaa)]]);

		const { dialect } = makeDialect();
		const redis = makeRedis();
		const snapshot = makeSnapshot([f1]);
		const { blobCache } = makeBlobCache(hitMap);

		const fs = new SqlFs({
			dialect,
			sandboxId: SANDBOX_ID,
			tenantId: TENANT_ID,
			redis,
			pathSnapshot: snapshot,
			blobCache,
		});
		await fs.ready();

		const logCalls = logSpy.mock.calls.map((c) => c[0] as string);
		const prefetchLog = logCalls.map((s) => JSON.parse(s)).find((o) => o.event === "snapshot_blob_prefetch_ok");
		expect(prefetchLog).toBeDefined();
		expect(prefetchLog.requested).toBe(1);
		expect(prefetchLog.hits).toBe(1);
	});

	it("directories and symlinks are excluded from the mget (they have no sha256)", async () => {
		const d = dirEntry("/", 1n);
		const f = fileEntry("/file.txt", 2n, 0x02);
		const hitMap = new Map([[0x02, makeBytes(5, 0xbb)]]);

		const { dialect } = makeDialect();
		const redis = makeRedis();
		const snapshot = makeSnapshot([d, f]);
		const { blobCache, mgetMock } = makeBlobCache(hitMap);

		const fs = new SqlFs({
			dialect,
			sandboxId: SANDBOX_ID,
			tenantId: TENANT_ID,
			redis,
			pathSnapshot: snapshot,
			blobCache,
		});
		await fs.ready();

		// Only the file inode should appear in the mget call
		expect(mgetMock).toHaveBeenCalledOnce();
		const [sha256Args] = mgetMock.mock.calls[0] as [Uint8Array[]];
		expect(sha256Args).toHaveLength(1);
	});
});

describe("SqlFs snapshot blob pre-fetch — partial hit", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("hit inodes are cached; miss inodes fall through to getBlobNoTx", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});

		const f1 = fileEntry("/hit.txt", 1n, 0x01);
		const f2 = fileEntry("/miss.txt", 2n, 0x02);
		const hitData = makeBytes(6, 0xcc);
		const missData = makeBytes(6, 0xdd);

		// Only f1 is in Redis
		const hitMap = new Map([[0x01, hitData]]);
		const { dialect, getBlobNoTxMock } = makeDialect();
		getBlobNoTxMock.mockResolvedValue(missData);

		const redis = makeRedis();
		const snapshot = makeSnapshot([f1, f2]);
		const { blobCache } = makeBlobCache(hitMap);

		const fs = new SqlFs({
			dialect,
			sandboxId: SANDBOX_ID,
			tenantId: TENANT_ID,
			redis,
			pathSnapshot: snapshot,
			blobCache,
		});
		await fs.ready();
		await flushMicrotasks();

		// hit.txt is in cache — no Postgres call
		const r1 = await fs.readFileBuffer("/hit.txt");
		expect(r1).toEqual(hitData);
		expect(getBlobNoTxMock).not.toHaveBeenCalled();

		// miss.txt is not in cache — falls through to getBlobNoTx
		const r2 = await fs.readFileBuffer("/miss.txt");
		expect(r2).toEqual(missData);
		expect(getBlobNoTxMock).toHaveBeenCalledOnce();
	});

	it("logs partial hit counts correctly", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});

		const f1 = fileEntry("/a.txt", 1n, 0x01);
		const f2 = fileEntry("/b.txt", 2n, 0x02);
		const f3 = fileEntry("/c.txt", 3n, 0x03);
		// Only f1 and f3 hit Redis
		const hitMap = new Map([
			[0x01, makeBytes(4)],
			[0x03, makeBytes(4)],
		]);

		const { dialect } = makeDialect();
		const redis = makeRedis();
		const snapshot = makeSnapshot([f1, f2, f3]);
		const { blobCache } = makeBlobCache(hitMap);

		const fs = new SqlFs({
			dialect,
			sandboxId: SANDBOX_ID,
			tenantId: TENANT_ID,
			redis,
			pathSnapshot: snapshot,
			blobCache,
		});
		await fs.ready();

		const prefetchLog = logSpy.mock.calls
			.map((c) => JSON.parse(c[0] as string))
			.find((o) => o.event === "snapshot_blob_prefetch_ok");
		expect(prefetchLog?.requested).toBe(3);
		expect(prefetchLog?.hits).toBe(2);
	});
});

describe("SqlFs snapshot blob pre-fetch — no blobCache", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("ready() completes without mget when blobCache is not configured", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});

		const f = fileEntry("/file.txt", 1n, 0x01);
		const { dialect } = makeDialect();
		const redis = makeRedis();
		const snapshot = makeSnapshot([f]);

		// No blobCache passed
		const fs = new SqlFs({ dialect, sandboxId: SANDBOX_ID, tenantId: TENANT_ID, redis, pathSnapshot: snapshot });
		await expect(fs.ready()).resolves.toBeUndefined();
	});
});

describe("SqlFs snapshot blob pre-fetch — snapshot miss", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("no prefetch when snapshot version is stale (falls through to loadAllPaths)", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});

		const f = fileEntry("/file.txt", 1n, 0x01);
		const { dialect } = makeDialect([f]);

		const redis = makeRedis(VERSION);
		// Snapshot reports a different version → stale → miss
		const snapshot = makeSnapshot([f], VERSION + 99);
		const hitMap = new Map([[0x01, makeBytes(8)]]);
		const { blobCache, mgetMock } = makeBlobCache(hitMap);

		const fs = new SqlFs({
			dialect,
			sandboxId: SANDBOX_ID,
			tenantId: TENANT_ID,
			redis,
			pathSnapshot: snapshot,
			blobCache,
		});
		await fs.ready();
		await flushMicrotasks();

		// mget must NOT be called — it was a snapshot miss
		expect(mgetMock).not.toHaveBeenCalled();
		// loadAllPaths was called as the fallback
		expect(dialect.loadAllPaths).toHaveBeenCalledOnce();
	});

	it("no prefetch when snapshot returns null (no key in Redis)", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});

		const f = fileEntry("/file.txt", 1n, 0x01);
		const { dialect } = makeDialect([f]);
		const redis = makeRedis(VERSION);

		// Snapshot read returns null — simulates no key stored
		const snapshot = { read: vi.fn(async () => null), write: vi.fn(), delete: vi.fn() } as unknown as RedisPathSnapshot;
		const { blobCache, mgetMock } = makeBlobCache(new Map([[0x01, makeBytes(8)]]));

		const fs = new SqlFs({
			dialect,
			sandboxId: SANDBOX_ID,
			tenantId: TENANT_ID,
			redis,
			pathSnapshot: snapshot,
			blobCache,
		});
		await fs.ready();
		await flushMicrotasks();

		expect(mgetMock).not.toHaveBeenCalled();
		expect(dialect.loadAllPaths).toHaveBeenCalledOnce();
	});
});

describe("SqlFs snapshot blob pre-fetch — background prewarm not regressed", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("getBlobsForSandbox is still called even when pre-fetch runs (Postgres fallback preserved)", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});

		const f = fileEntry("/file.txt", 1n, 0x01);
		const { dialect, getBlobsForSandboxMock } = makeDialect();
		const redis = makeRedis();
		const snapshot = makeSnapshot([f]);
		const { blobCache } = makeBlobCache(new Map([[0x01, makeBytes(4)]]));

		const fs = new SqlFs({
			dialect,
			sandboxId: SANDBOX_ID,
			tenantId: TENANT_ID,
			redis,
			pathSnapshot: snapshot,
			blobCache,
		});
		await fs.ready();
		await flushMicrotasks();

		// Background prewarm must still fire
		expect(getBlobsForSandboxMock).toHaveBeenCalledOnce();
	});

	it("snapshot miss path: getBlobsForSandbox fires and populates cache", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});

		const blobData = makeBytes(8, 0xee);
		const f = fileEntry("/file.txt", 1n, 0x01);
		// Snapshot returns stale version → fall through to loadAllPaths
		const { dialect, getBlobsForSandboxMock, getBlobNoTxMock } = makeDialect([f]);
		getBlobsForSandboxMock.mockResolvedValueOnce([{ inodeId: 1n, data: blobData }]);
		getBlobNoTxMock.mockResolvedValue(blobData);

		const redis = makeRedis(VERSION);
		const snapshot = makeSnapshot([f], VERSION + 1); // stale
		const { blobCache } = makeBlobCache(new Map());

		const fs = new SqlFs({
			dialect,
			sandboxId: SANDBOX_ID,
			tenantId: TENANT_ID,
			redis,
			pathSnapshot: snapshot,
			blobCache,
		});
		await fs.ready();
		// Let the background prewarm settle
		await vi.waitFor(() => expect(getBlobsForSandboxMock).toHaveBeenCalledOnce());

		const result = await fs.readFileBuffer("/file.txt");
		expect(result).toEqual(blobData);
		// After prewarm, it should be a cache hit (no getBlobNoTx)
		expect(getBlobNoTxMock).not.toHaveBeenCalled();
	});
});

describe("SqlFs reload() — no prefetch regression", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("reload() still works with snapshot configured; background prewarm fires", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});

		const f = fileEntry("/file.txt", 1n, 0x01);
		const { dialect, getBlobsForSandboxMock } = makeDialect([f]);
		const redis = makeRedis();
		const snapshot = makeSnapshot([f]);
		const { blobCache } = makeBlobCache(new Map([[0x01, makeBytes(4)]]));

		const fs = new SqlFs({
			dialect,
			sandboxId: SANDBOX_ID,
			tenantId: TENANT_ID,
			redis,
			pathSnapshot: snapshot,
			blobCache,
		});
		await fs.ready();
		await flushMicrotasks();

		const callsAfterReady = getBlobsForSandboxMock.mock.calls.length;

		await fs.reload();
		await flushMicrotasks();

		// reload() must trigger a new background prewarm
		expect(getBlobsForSandboxMock.mock.calls.length).toBeGreaterThan(callsAfterReady);
	});

	it("reload() without snapshot: loadAllPaths is called, prewarm fires", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});

		const f = fileEntry("/file.txt", 1n, 0x01);
		const { dialect, getBlobsForSandboxMock } = makeDialect([f]);

		// No redis/snapshot — classic path
		const fs = new SqlFs({ dialect, sandboxId: SANDBOX_ID });
		await fs.ready();
		await flushMicrotasks();

		await fs.reload();
		await flushMicrotasks();

		expect(getBlobsForSandboxMock.mock.calls.length).toBeGreaterThanOrEqual(2);
		expect(dialect.loadAllPaths).toHaveBeenCalledTimes(2);
	});
});

describe("SqlFs snapshot blob pre-fetch — empty sandbox", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("no mget call when snapshot has no file inodes", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});

		// Snapshot has only a directory — no files
		const d = dirEntry("/", 1n);
		const { dialect } = makeDialect();
		const redis = makeRedis();
		const snapshot = makeSnapshot([d]);
		const { blobCache, mgetMock } = makeBlobCache(new Map());

		const fs = new SqlFs({
			dialect,
			sandboxId: SANDBOX_ID,
			tenantId: TENANT_ID,
			redis,
			pathSnapshot: snapshot,
			blobCache,
		});
		await fs.ready();

		expect(mgetMock).not.toHaveBeenCalled();
	});
});

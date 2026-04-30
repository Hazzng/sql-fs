/**
 * Unit tests for SqlFs contentCache (LRU).
 * US-022: LRU content cache setup
 */

import { describe, expect, it, vi } from "vitest";
import { SqlFs } from "./sql-fs.js";
import type { SqlDialect } from "./types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDialect(): SqlDialect<unknown> {
	return {
		connect: vi.fn(),
		disconnect: vi.fn(),
		transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
		setSandboxContext: vi.fn(),
		setSandboxContextWithLock: vi.fn(),
		loadAllPaths: vi.fn(async () => []),
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
		getBlobNoTx: vi.fn(),
		gcOrphanBlobs: vi.fn(),
		loadSubtreeInodes: vi.fn(),
		bulkIngest: vi.fn(),
		resolvePath: vi.fn(),
	} as unknown as SqlDialect<unknown>;
}

function makeBytes(size: number): Uint8Array {
	return new Uint8Array(size).fill(1);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("SqlFs contentCache — LRU setup", () => {
	it("stores and retrieves entries by inodeId", () => {
		const fs = new SqlFs({ dialect: makeDialect(), sandboxId: "s1" });
		const data = makeBytes(10);

		fs._contentCacheSet(42n, data);

		expect(fs._contentCacheHas(42n)).toBe(true);
		expect(fs._contentCacheGet(42n)).toEqual(data);
	});

	it("returns undefined for entries not in cache", () => {
		const fs = new SqlFs({ dialect: makeDialect(), sandboxId: "s1" });

		expect(fs._contentCacheHas(99n)).toBe(false);
		expect(fs._contentCacheGet(99n)).toBeUndefined();
	});

	it("evicts oldest-accessed entry when byte budget is exceeded", () => {
		// Budget: 25 bytes. Three entries of 10 bytes each — third insert exceeds budget; evicts 1n.
		const fs = new SqlFs({ dialect: makeDialect(), sandboxId: "s1", contentCacheMaxBytes: 25 });

		fs._contentCacheSet(1n, makeBytes(10)); // oldest
		fs._contentCacheSet(2n, makeBytes(10));
		fs._contentCacheSet(3n, makeBytes(10)); // newest; adding this should evict 1n (LRU)

		expect(fs._contentCacheHas(1n)).toBe(false); // evicted
		expect(fs._contentCacheHas(2n)).toBe(true);
		expect(fs._contentCacheHas(3n)).toBe(true);
	});

	it("promotes accessed entry so it is not evicted first", () => {
		// Budget: 20 bytes. Insert 1n and 2n (fills budget), access 1n, then insert 3n — 2n is evicted.
		const fs = new SqlFs({ dialect: makeDialect(), sandboxId: "s1", contentCacheMaxBytes: 20 });

		fs._contentCacheSet(1n, makeBytes(10));
		fs._contentCacheSet(2n, makeBytes(10));

		// Access 1n to make it recently used
		fs._contentCacheGet(1n);

		// Now insert 3n — budget exceeded, 2n is LRU and should be evicted
		fs._contentCacheSet(3n, makeBytes(10));

		expect(fs._contentCacheHas(1n)).toBe(true); // accessed recently — kept
		expect(fs._contentCacheHas(2n)).toBe(false); // LRU — evicted
		expect(fs._contentCacheHas(3n)).toBe(true);
	});

	it("respects contentCacheMaxBytes option (default 50 MB)", () => {
		// Default instance should accept a large number of small entries without eviction
		const fs = new SqlFs({ dialect: makeDialect(), sandboxId: "s1" });

		for (let i = 0n; i < 100n; i++) {
			fs._contentCacheSet(i, makeBytes(1));
		}

		// All 100 entries (100 bytes total) should survive in a 50 MB cache
		for (let i = 0n; i < 100n; i++) {
			expect(fs._contentCacheHas(i)).toBe(true);
		}
	});
});

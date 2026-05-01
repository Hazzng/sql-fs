/**
 * Edge-case tests for SqlFs.bulkIngest addressing three Codex review issues:
 *
 * 1. Nested directory creation across multiple depth levels
 * 2. File overwrite semantics — cache correctness when inodes change
 * 3. ENOTDIR when a non-directory is encountered on an ancestor path
 *
 * These are unit tests against the SqlFs wrapper (mock dialect).
 * Integration tests for the actual SQL queries are in integration/.
 */

import { describe, expect, it, vi } from "vitest";
import { SqlFs } from "./sql-fs.js";
import type { BulkIngestFile, PathCacheEntry, SqlDialect } from "./types.js";

const now = new Date("2026-01-01T00:00:00Z");

function dirEntry(path: string, inodeId: bigint): { path: string } & PathCacheEntry {
	return { path, inodeId, kind: 2, mode: 0o755, size: 0, mtime: now, contentSha256: null, symlinkTarget: null };
}

function fileEntry(path: string, inodeId: bigint, size: number): { path: string } & PathCacheEntry {
	const sha = new Uint8Array(32).fill(0xab);
	return { path, inodeId, kind: 1, mode: 0o644, size, mtime: now, contentSha256: sha, symlinkTarget: null };
}

function cacheEntry(inodeId: bigint, size: number, sha?: Uint8Array): PathCacheEntry {
	return {
		inodeId,
		kind: 1,
		mode: 0o644,
		size,
		mtime: now,
		contentSha256: sha ?? new Uint8Array(32).fill(0xab),
		symlinkTarget: null,
	};
}

function dirCacheEntry(inodeId: bigint): PathCacheEntry {
	return { inodeId, kind: 2, mode: 0o755, size: 0, mtime: now, contentSha256: null, symlinkTarget: null };
}

function makeDialect(overrides?: Partial<{ bulkIngestImpl: SqlDialect<unknown>["bulkIngest"] }>): {
	dialect: SqlDialect<unknown>;
	bulkIngestMock: ReturnType<typeof vi.fn>;
	loadAllPathsMock: ReturnType<typeof vi.fn>;
	getBlobNoTxMock: ReturnType<typeof vi.fn>;
} {
	const transactionMock = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({}));
	const bulkIngestMock = overrides?.bulkIngestImpl
		? vi.fn(overrides.bulkIngestImpl)
		: vi.fn(async () => new Map<string, PathCacheEntry>());
	const loadAllPathsMock = vi.fn(async () => [] as Array<{ path: string } & PathCacheEntry>);
	const getBlobNoTxMock = vi.fn(async () => new Uint8Array(0));
	const dialect: SqlDialect<unknown> = {
		connect: vi.fn(),
		disconnect: vi.fn(),
		transaction: transactionMock,
		setSandboxContext: vi.fn(),
		setSandboxContextWithLock: vi.fn(),
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
		getBlobNoTx: getBlobNoTxMock,
		gcOrphanBlobs: vi.fn(),
		getBlobsForSandbox: vi.fn(async () => []),
		loadSubtreeInodes: vi.fn(),
		bulkIngest: bulkIngestMock,
		resolvePath: vi.fn(),
	} as unknown as SqlDialect<unknown>;
	return { dialect, bulkIngestMock, loadAllPathsMock, getBlobNoTxMock };
}

// ─────────────────────────────────────────────────────────────────────────────
// Codex Issue 1: Nested directory creation across multiple depth levels
// ─────────────────────────────────────────────────────────────────────────────

describe("bulkIngest — nested directory depth levels (Codex issue 1)", () => {
	it("deeply nested file (4 levels) creates all intermediate dirs in pathCache", async () => {
		const { dialect, bulkIngestMock, loadAllPathsMock } = makeDialect();
		loadAllPathsMock.mockResolvedValueOnce([dirEntry("/", 1n)]);
		const fs = new SqlFs({ dialect, sandboxId: "s1" });
		await fs.ready();

		bulkIngestMock.mockResolvedValueOnce(
			new Map<string, PathCacheEntry>([
				["/a", dirCacheEntry(10n)],
				["/a/b", dirCacheEntry(11n)],
				["/a/b/c", dirCacheEntry(12n)],
				["/a/b/c/d", dirCacheEntry(13n)],
				["/a/b/c/d/file.txt", cacheEntry(20n, 5)],
			]),
		);

		await fs.bulkIngest([{ path: "/a/b/c/d/file.txt", content: new TextEncoder().encode("hello"), mode: 0o644 }]);

		// Every intermediate dir must be stat-able
		for (const dir of ["/a", "/a/b", "/a/b/c", "/a/b/c/d"]) {
			const stat = await fs.stat(dir);
			expect(stat.isDirectory).toBe(true);
		}
		const fileStat = await fs.stat("/a/b/c/d/file.txt");
		expect(fileStat.isFile).toBe(true);
		expect(fileStat.size).toBe(5);
	});

	it("files at different depths share common ancestor directories", async () => {
		const { dialect, bulkIngestMock, loadAllPathsMock } = makeDialect();
		loadAllPathsMock.mockResolvedValueOnce([dirEntry("/", 1n)]);
		const fs = new SqlFs({ dialect, sandboxId: "s1" });
		await fs.ready();

		bulkIngestMock.mockResolvedValueOnce(
			new Map<string, PathCacheEntry>([
				["/src", dirCacheEntry(10n)],
				["/src/lib", dirCacheEntry(11n)],
				["/src/lib/deep", dirCacheEntry(12n)],
				["/src/index.ts", cacheEntry(20n, 10)],
				["/src/lib/util.ts", cacheEntry(21n, 8)],
				["/src/lib/deep/core.ts", cacheEntry(22n, 15)],
			]),
		);

		await fs.bulkIngest([
			{ path: "/src/index.ts", content: new Uint8Array(10), mode: 0o644 },
			{ path: "/src/lib/util.ts", content: new Uint8Array(8), mode: 0o644 },
			{ path: "/src/lib/deep/core.ts", content: new Uint8Array(15), mode: 0o644 },
		]);

		// Shared ancestor /src should appear once
		expect((await fs.stat("/src")).isDirectory).toBe(true);
		// Both /src/lib files accessible
		expect((await fs.stat("/src/lib/util.ts")).isFile).toBe(true);
		expect((await fs.stat("/src/lib/deep/core.ts")).isFile).toBe(true);
	});

	it("mix of pre-existing and new directories: only new dirs appear in returned map", async () => {
		const { dialect, bulkIngestMock, loadAllPathsMock } = makeDialect();
		// Sandbox already has /home and /home/user
		loadAllPathsMock.mockResolvedValueOnce([dirEntry("/", 1n), dirEntry("/home", 2n), dirEntry("/home/user", 3n)]);
		const fs = new SqlFs({ dialect, sandboxId: "s1" });
		await fs.ready();

		// Dialect returns only the NEW entries (not pre-existing /home, /home/user)
		bulkIngestMock.mockResolvedValueOnce(
			new Map<string, PathCacheEntry>([
				["/home/user/project", dirCacheEntry(30n)],
				["/home/user/project/src", dirCacheEntry(31n)],
				["/home/user/project/src/main.ts", cacheEntry(40n, 20)],
			]),
		);

		await fs.bulkIngest([{ path: "/home/user/project/src/main.ts", content: new Uint8Array(20), mode: 0o644 }]);

		const cache = fs._getPathCache();
		// Pre-existing dirs still have their original inodeIds
		expect(cache.get("/home")?.inodeId).toBe(2n);
		expect(cache.get("/home/user")?.inodeId).toBe(3n);
		// New dirs have new inodeIds from the merge
		expect(cache.get("/home/user/project")?.inodeId).toBe(30n);
		expect((await fs.stat("/home/user/project/src/main.ts")).isFile).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Codex Issue 2: File overwrite semantics — no orphan inodes in cache
// ─────────────────────────────────────────────────────────────────────────────

describe("bulkIngest — overwrite semantics (Codex issue 2)", () => {
	it("overwriting an existing file updates pathCache to the new inode", async () => {
		const { dialect, bulkIngestMock, loadAllPathsMock } = makeDialect();
		loadAllPathsMock.mockResolvedValueOnce([dirEntry("/", 1n), fileEntry("/a.txt", 5n, 3)]);
		const fs = new SqlFs({ dialect, sandboxId: "s1" });
		await fs.ready();

		// Before overwrite
		expect(fs._getPathCache().get("/a.txt")?.inodeId).toBe(5n);

		// Dialect overwrites /a.txt → new inode 50n
		bulkIngestMock.mockResolvedValueOnce(new Map<string, PathCacheEntry>([["/a.txt", cacheEntry(50n, 7)]]));

		await fs.bulkIngest([{ path: "/a.txt", content: new Uint8Array(7), mode: 0o644 }]);

		expect(fs._getPathCache().get("/a.txt")?.inodeId).toBe(50n);
		expect((await fs.stat("/a.txt")).size).toBe(7);
	});

	it("overwrite evicts old inode and seeds new inode in contentCache", async () => {
		const { dialect, bulkIngestMock, loadAllPathsMock, getBlobNoTxMock } = makeDialect();
		loadAllPathsMock.mockResolvedValueOnce([dirEntry("/", 1n), fileEntry("/data.bin", 100n, 10)]);
		const fs = new SqlFs({ dialect, sandboxId: "s1" });
		await fs.ready();

		const newContent = new Uint8Array(5).fill(0x02);
		// Overwrite → new inode 200n, seeds cache with newContent
		bulkIngestMock.mockResolvedValueOnce(new Map<string, PathCacheEntry>([["/data.bin", cacheEntry(200n, 5)]]));
		await fs.bulkIngest([{ path: "/data.bin", content: newContent, mode: 0o644 }]);

		// New inode is seeded in cache — readFileBuffer must be a hit (no getBlobNoTx)
		expect(await fs.readFileBuffer("/data.bin")).toEqual(newContent);
		expect(getBlobNoTxMock).not.toHaveBeenCalled();
		expect(fs._getPathCache().get("/data.bin")?.inodeId).toBe(200n);
	});

	it("same inode ID on overwrite does NOT evict contentCache (content-addressable dedup)", async () => {
		const { dialect, bulkIngestMock, loadAllPathsMock, getBlobNoTxMock } = makeDialect();
		loadAllPathsMock.mockResolvedValueOnce([dirEntry("/", 1n), fileEntry("/same.txt", 42n, 5)]);
		const fs = new SqlFs({ dialect, sandboxId: "s1" });
		await fs.ready();

		// Dialect returns same inode ID (hypothetical same-content scenario)
		const content = new TextEncoder().encode("hello");
		bulkIngestMock.mockResolvedValueOnce(new Map<string, PathCacheEntry>([["/same.txt", cacheEntry(42n, 5)]]));
		await fs.bulkIngest([{ path: "/same.txt", content, mode: 0o644 }]);

		// Inode 42n was seeded (not evicted since ID unchanged) — cache hit
		const result = await fs.readFileBuffer("/same.txt");
		expect(getBlobNoTxMock).not.toHaveBeenCalled();
		expect(result).toEqual(content);
	});

	it("multiple files with some overwrites and some new — both handled correctly", async () => {
		const { dialect, bulkIngestMock, loadAllPathsMock, getBlobNoTxMock } = makeDialect();
		loadAllPathsMock.mockResolvedValueOnce([
			dirEntry("/", 1n),
			dirEntry("/d", 2n),
			fileEntry("/d/existing.txt", 10n, 3),
		]);
		const fs = new SqlFs({ dialect, sandboxId: "s1" });
		await fs.ready();

		const existingContent = new Uint8Array(7).fill(0x11);
		const newContent = new Uint8Array(4).fill(0x22);
		bulkIngestMock.mockResolvedValueOnce(
			new Map<string, PathCacheEntry>([
				["/d/existing.txt", cacheEntry(50n, 7)],
				["/d/brand-new.txt", cacheEntry(51n, 4)],
			]),
		);

		await fs.bulkIngest([
			{ path: "/d/existing.txt", content: existingContent, mode: 0o644 },
			{ path: "/d/brand-new.txt", content: newContent, mode: 0o644 },
		]);

		// Both inodes seeded in cache — reads must be cache hits
		expect(await fs.readFileBuffer("/d/existing.txt")).toEqual(existingContent);
		expect(await fs.readFileBuffer("/d/brand-new.txt")).toEqual(newContent);
		expect(getBlobNoTxMock).not.toHaveBeenCalled();
		expect(fs._getPathCache().get("/d/existing.txt")?.inodeId).toBe(50n);
		expect(fs._getPathCache().get("/d/brand-new.txt")?.inodeId).toBe(51n);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Codex Issue 3: ENOTDIR when ancestor is a file/symlink
// ─────────────────────────────────────────────────────────────────────────────

describe("bulkIngest — ENOTDIR on non-directory ancestor (Codex issue 3)", () => {
	it("dialect throws ENOTDIR when an ancestor path is a file → error propagates, cache untouched", async () => {
		const { dialect, bulkIngestMock, loadAllPathsMock } = makeDialect();
		loadAllPathsMock.mockResolvedValueOnce([dirEntry("/", 1n), fileEntry("/a", 5n, 3)]);
		const fs = new SqlFs({ dialect, sandboxId: "s1" });
		await fs.ready();

		bulkIngestMock.mockRejectedValueOnce(
			Object.assign(new Error("ENOTDIR: not a directory, '/a'"), { code: "ENOTDIR" }),
		);

		await expect(
			fs.bulkIngest([{ path: "/a/b/c.txt", content: new TextEncoder().encode("x"), mode: 0o644 }]),
		).rejects.toMatchObject({ code: "ENOTDIR" });

		// Original cache unchanged — /a is still a file
		expect((await fs.stat("/a")).isFile).toBe(true);
		expect(fs.wasDirty()).toBe(false);
	});

	it("dialect throws ENOTDIR for symlink ancestor → error propagates", async () => {
		const { dialect, bulkIngestMock, loadAllPathsMock } = makeDialect();
		loadAllPathsMock.mockResolvedValueOnce([
			dirEntry("/", 1n),
			{
				path: "/link",
				inodeId: 7n,
				kind: 3 as const,
				mode: 0o777,
				size: 0,
				mtime: now,
				contentSha256: null,
				symlinkTarget: "/somewhere",
			},
		]);
		const fs = new SqlFs({ dialect, sandboxId: "s1" });
		await fs.ready();

		bulkIngestMock.mockRejectedValueOnce(
			Object.assign(new Error("ENOTDIR: not a directory, '/link'"), { code: "ENOTDIR" }),
		);

		await expect(
			fs.bulkIngest([{ path: "/link/child.txt", content: new TextEncoder().encode("x"), mode: 0o644 }]),
		).rejects.toMatchObject({ code: "ENOTDIR" });
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Additional edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe("bulkIngest — additional edge cases", () => {
	it("single file at root level (no intermediate dirs needed)", async () => {
		const { dialect, bulkIngestMock, loadAllPathsMock } = makeDialect();
		loadAllPathsMock.mockResolvedValueOnce([dirEntry("/", 1n)]);
		const fs = new SqlFs({ dialect, sandboxId: "s1" });
		await fs.ready();

		bulkIngestMock.mockResolvedValueOnce(new Map<string, PathCacheEntry>([["/root-file.txt", cacheEntry(99n, 1)]]));

		await fs.bulkIngest([{ path: "/root-file.txt", content: new Uint8Array(1), mode: 0o644 }]);

		expect((await fs.stat("/root-file.txt")).isFile).toBe(true);
	});

	it("empty directory subtrees — dirs needed but no file lands at that depth", async () => {
		const { dialect, bulkIngestMock, loadAllPathsMock } = makeDialect();
		loadAllPathsMock.mockResolvedValueOnce([dirEntry("/", 1n)]);
		const fs = new SqlFs({ dialect, sandboxId: "s1" });
		await fs.ready();

		// File is at /a/b/c/file.txt — dirs /a and /a/b are "empty" (no files land there)
		bulkIngestMock.mockResolvedValueOnce(
			new Map<string, PathCacheEntry>([
				["/a", dirCacheEntry(10n)],
				["/a/b", dirCacheEntry(11n)],
				["/a/b/c", dirCacheEntry(12n)],
				["/a/b/c/file.txt", cacheEntry(20n, 3)],
			]),
		);

		await fs.bulkIngest([{ path: "/a/b/c/file.txt", content: new Uint8Array(3), mode: 0o644 }]);

		expect((await fs.stat("/a")).isDirectory).toBe(true);
		expect((await fs.stat("/a/b")).isDirectory).toBe(true);
		expect((await fs.stat("/a/b/c")).isDirectory).toBe(true);
		expect((await fs.stat("/a/b/c/file.txt")).isFile).toBe(true);
	});

	it("dialect error does not leave partially merged state in pathCache", async () => {
		const { dialect, bulkIngestMock, loadAllPathsMock } = makeDialect();
		loadAllPathsMock.mockResolvedValueOnce([dirEntry("/", 1n)]);
		const fs = new SqlFs({ dialect, sandboxId: "s1" });
		await fs.ready();

		bulkIngestMock.mockRejectedValueOnce(new Error("DB connection lost"));

		await expect(fs.bulkIngest([{ path: "/x/y.txt", content: new Uint8Array(1), mode: 0o644 }])).rejects.toThrow(
			"DB connection lost",
		);

		// No partial entries should exist
		expect(fs.getAllPaths()).toEqual(["/"]);
	});

	it("large batch (100 files) across 10 directories merges all entries", async () => {
		const { dialect, bulkIngestMock, loadAllPathsMock } = makeDialect();
		loadAllPathsMock.mockResolvedValueOnce([dirEntry("/", 1n)]);
		const fs = new SqlFs({ dialect, sandboxId: "s1" });
		await fs.ready();

		const returnedEntries = new Map<string, PathCacheEntry>();
		const files: BulkIngestFile[] = [];
		let nextId = 100n;

		for (let d = 0; d < 10; d++) {
			const dir = `/dir${d}`;
			returnedEntries.set(dir, dirCacheEntry(nextId++));
			for (let f = 0; f < 10; f++) {
				const path = `${dir}/file${f}.txt`;
				files.push({ path, content: new Uint8Array(f + 1), mode: 0o644 });
				returnedEntries.set(path, cacheEntry(nextId++, f + 1));
			}
		}

		bulkIngestMock.mockResolvedValueOnce(returnedEntries);
		await fs.bulkIngest(files);

		// 1 (root) + 10 dirs + 100 files = 111
		expect(fs.getAllPaths().length).toBe(111);
		for (const f of files) {
			expect((await fs.stat(f.path)).isFile).toBe(true);
		}
	});
});

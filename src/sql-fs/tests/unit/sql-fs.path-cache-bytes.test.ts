/**
 * Unit tests for SqlFs.getPathCacheBytes() — incremental O(1) byte accounting (F9e).
 *
 * The counter MUST equal the previous full-walk `Σ (path.length + 100)` over
 * `getAllPaths()` exactly, after every mutation (write / delete / overwrite /
 * mkdir / cp / mv / rm -r / symlink / link) and after reload()/ready().
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

/** The original full-walk formula from SessionManager.estimatePathCacheBytes. */
function fullWalk(fs: SqlFs): number {
	let total = 0;
	for (const p of fs.getAllPaths()) total += p.length + 100;
	return total;
}

/** Asserts the O(1) counter matches the full-walk reference exactly. */
function expectInSync(fs: SqlFs): void {
	expect(fs.getPathCacheBytes()).toBe(fullWalk(fs));
}

describe("SqlFs.getPathCacheBytes() — incremental byte accounting (F9e)", () => {
	const sandboxId = "test-sandbox";
	let nextInode = 100n;
	let loadAllPathsMock: ReturnType<typeof vi.fn>;
	let dialect: SqlDialect<unknown>;
	let fs: SqlFs;

	beforeEach(async () => {
		nextInode = 100n;
		loadAllPathsMock = vi.fn(async () => [
			dirEntry("/", 1n),
			dirEntry("/a", 2n),
			dirEntry("/a/b", 3n),
			fileEntry("/a/b/c.txt", 4n, 10),
		]);

		dialect = {
			connect: vi.fn(),
			disconnect: vi.fn(),
			transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
			setSandboxContext: vi.fn(),
			setSandboxContextWithLock: vi.fn(),
			loadAllPaths: loadAllPathsMock,
			createSandbox: vi.fn(),
			deleteSandbox: vi.fn(),
			createInode: vi.fn(async () => nextInode++),
			getInode: vi.fn(),
			updateInode: vi.fn(),
			deleteInode: vi.fn(),
			incrementNlink: vi.fn(),
			decrementNlink: vi.fn(async () => 0),
			insertDirent: vi.fn(),
			upsertDirent: vi.fn(async () => null),
			deleteDirent: vi.fn(async () => nextInode),
			listDirents: vi.fn(),
			moveDirent: vi.fn(),
			upsertBlob: vi.fn(),
			getBlob: vi.fn(),
			gcOrphanBlobs: vi.fn(),
			getBlobsForSandbox: vi.fn(async () => []),
			loadSubtreeInodes: vi.fn(async () => []),
			bulkIngest: vi.fn(async () => new Map<string, PathCacheEntry>()),
			resolvePath: vi.fn(),
		} as unknown as SqlDialect<unknown>;

		fs = new SqlFs({ dialect, sandboxId, allowSymlinks: true });
		await fs.ready();
	});

	it("starts in sync after ready()", () => {
		// 4 entries: '/' '/a' '/a/b' '/a/b/c.txt' → (1+100)+(2+100)+(4+100)+(10+100)
		expect(fs.getPathCacheBytes()).toBe(1 + 100 + (2 + 100) + (4 + 100) + (10 + 100));
		expectInSync(fs);
	});

	it("is zero before ready()", () => {
		const fresh = new SqlFs({ dialect, sandboxId });
		expect(fresh.getPathCacheBytes()).toBe(0);
	});

	it("stays in sync across writeFile (new + overwrite)", async () => {
		await fs.writeFile("/a/new.txt", "hello");
		expectInSync(fs);
		const afterNew = fs.getPathCacheBytes();

		// Overwrite an existing path: key set unchanged → counter unchanged.
		await fs.writeFile("/a/new.txt", "longer content now");
		expect(fs.getPathCacheBytes()).toBe(afterNew);
		expectInSync(fs);
	});

	it("stays in sync across mkdir -p (multiple new segments)", async () => {
		await fs.mkdir("/a/x/y/z", { recursive: true });
		expectInSync(fs);
	});

	it("stays in sync across rm of a single file", async () => {
		await fs.writeFile("/a/tmp.txt", "x");
		expectInSync(fs);
		await fs.rm("/a/tmp.txt");
		expectInSync(fs);
		// Back to the post-ready baseline.
		expect(fs.getPathCacheBytes()).toBe(1 + 100 + (2 + 100) + (4 + 100) + (10 + 100));
	});

	it("stays in sync across rm -r of a subtree", async () => {
		await fs.mkdir("/a/sub", { recursive: true });
		await fs.writeFile("/a/sub/f1.txt", "a");
		await fs.writeFile("/a/sub/f2.txt", "bb");
		expectInSync(fs);
		await fs.rm("/a/sub", { recursive: true });
		expectInSync(fs);
	});

	it("stays in sync across cp -r of a subtree", async () => {
		await fs.mkdir("/a/sub", { recursive: true });
		await fs.writeFile("/a/sub/f.txt", "data");
		expectInSync(fs);
		await fs.cp("/a/sub", "/a/copy", { recursive: true });
		expectInSync(fs);
	});

	it("stays in sync across mv of a subtree (delete src + insert dest)", async () => {
		await fs.mkdir("/a/sub", { recursive: true });
		await fs.writeFile("/a/sub/f.txt", "data");
		expectInSync(fs);
		await fs.mv("/a/sub", "/a/moved");
		expectInSync(fs);
	});

	it("stays in sync across symlink and hardlink", async () => {
		await fs.symlink("/a/b/c.txt", "/a/link");
		expectInSync(fs);
		await fs.link("/a/b/c.txt", "/a/hard.txt");
		expectInSync(fs);
	});

	it("resets and re-syncs after reload() with a different tree", async () => {
		await fs.writeFile("/a/scratch.txt", "x");
		expectInSync(fs);

		// reload() pulls a smaller committed tree.
		loadAllPathsMock.mockResolvedValueOnce([dirEntry("/", 1n), fileEntry("/only.txt", 9n, 3)]);
		await fs.reload();

		expect(fs.getPathCacheBytes()).toBe(1 + 100 + (9 + 100));
		expectInSync(fs);
	});

	it("re-syncs after ready() is called again (clear + repopulate)", async () => {
		await fs.writeFile("/a/scratch.txt", "x");
		loadAllPathsMock.mockResolvedValueOnce([dirEntry("/", 1n)]);
		await fs.ready();
		expect(fs.getPathCacheBytes()).toBe(1 + 100);
		expectInSync(fs);
	});
});

/**
 * Phase D: Dirty-tracking unit tests for SqlFs.
 *
 * Every mutation method must flip `wasDirty()` to true; `clearDirty()` must
 * reset it. Missing one method means silent cross-replica coherence bugs
 * because `publishVersionIfDirty` will skip the INCR and other replicas
 * keep serving stale cache.
 *
 * Tests use a mocked SqlDialect — no database required.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SqlFs } from "./sql-fs.js";
import type { PathCacheEntry, SqlDialect } from "./types.js";

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

function makeDialect(): SqlDialect<unknown> {
	let nextInodeId = 100n;
	return {
		connect: vi.fn(),
		disconnect: vi.fn(),
		transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
		setSandboxContext: vi.fn(),
		loadAllPaths: vi.fn(async () => [
			dirEntry("/", 1n),
			dirEntry("/home", 2n),
			dirEntry("/home/user", 3n),
			fileEntry("/home/user/file.txt", 4n),
			fileEntry("/home/user/other.txt", 5n),
		]),
		createSandbox: vi.fn(),
		deleteSandbox: vi.fn(),
		createInode: vi.fn(async () => {
			nextInodeId += 1n;
			return nextInodeId;
		}),
		getInode: vi.fn(),
		updateInode: vi.fn(),
		deleteInode: vi.fn(),
		incrementNlink: vi.fn(),
		decrementNlink: vi.fn(async () => 0),
		insertDirent: vi.fn(),
		upsertDirent: vi.fn(async () => null),
		deleteDirent: vi.fn(async () => 4n),
		listDirents: vi.fn(),
		moveDirent: vi.fn(),
		upsertBlob: vi.fn(),
		getBlob: vi.fn(async () => new Uint8Array(0)),
		gcOrphanBlobs: vi.fn(),
		loadSubtreeInodes: vi.fn(async () => [3n, 4n, 5n]),
		bulkIngest: vi.fn(),
		resolvePath: vi.fn(),
	} as unknown as SqlDialect<unknown>;
}

async function makeFs(): Promise<SqlFs> {
	const fs = new SqlFs({ dialect: makeDialect(), sandboxId: "s-dirty", allowSymlinks: true });
	await fs.ready();
	// ready() should not set the dirty flag — it only populates from DB.
	expect(fs.wasDirty()).toBe(false);
	return fs;
}

describe("SqlFs dirty-tracking: mutations flip wasDirty", () => {
	let fs: SqlFs;

	beforeEach(async () => {
		fs = await makeFs();
	});

	it("starts clean", () => {
		expect(fs.wasDirty()).toBe(false);
	});

	it("clearDirty resets the flag", () => {
		fs._markDirty();
		expect(fs.wasDirty()).toBe(true);
		fs.clearDirty();
		expect(fs.wasDirty()).toBe(false);
	});

	it("writeFile marks dirty", async () => {
		await fs.writeFile("/home/user/new.txt", "hello");
		expect(fs.wasDirty()).toBe(true);
	});

	it("appendFile marks dirty", async () => {
		await fs.appendFile("/home/user/file.txt", "more");
		expect(fs.wasDirty()).toBe(true);
	});

	it("mkdir (non-recursive) marks dirty", async () => {
		await fs.mkdir("/home/user/subdir");
		expect(fs.wasDirty()).toBe(true);
	});

	it("mkdir (recursive) marks dirty", async () => {
		await fs.mkdir("/home/user/a/b/c", { recursive: true });
		expect(fs.wasDirty()).toBe(true);
	});

	it("rm (non-recursive) marks dirty", async () => {
		await fs.rm("/home/user/file.txt");
		expect(fs.wasDirty()).toBe(true);
	});

	it("rm (recursive) marks dirty", async () => {
		await fs.rm("/home/user", { recursive: true });
		expect(fs.wasDirty()).toBe(true);
	});

	it("chmod marks dirty", async () => {
		await fs.chmod("/home/user/file.txt", 0o600);
		expect(fs.wasDirty()).toBe(true);
	});

	it("utimes marks dirty", async () => {
		await fs.utimes("/home/user/file.txt", new Date(), new Date());
		expect(fs.wasDirty()).toBe(true);
	});

	it("cp (single file) marks dirty", async () => {
		await fs.cp("/home/user/file.txt", "/home/user/copy.txt");
		expect(fs.wasDirty()).toBe(true);
	});

	it("cp (recursive) marks dirty", async () => {
		await fs.cp("/home/user", "/home/clone", { recursive: true });
		expect(fs.wasDirty()).toBe(true);
	});

	it("mv marks dirty", async () => {
		await fs.mv("/home/user/file.txt", "/home/user/renamed.txt");
		expect(fs.wasDirty()).toBe(true);
	});

	it("symlink marks dirty", async () => {
		await fs.symlink("/home/user/file.txt", "/home/user/lnk");
		expect(fs.wasDirty()).toBe(true);
	});

	it("link marks dirty", async () => {
		await fs.link("/home/user/file.txt", "/home/user/hardlink.txt");
		expect(fs.wasDirty()).toBe(true);
	});

	it("read-only ops do NOT mark dirty", async () => {
		await fs.readFile("/home/user/file.txt");
		await fs.stat("/home/user/file.txt");
		await fs.exists("/home/user/file.txt");
		await fs.readdir("/home/user");
		expect(fs.wasDirty()).toBe(false);
	});

	it("rm with force=true on missing path does NOT mark dirty", async () => {
		await fs.rm("/home/user/does-not-exist", { force: true });
		expect(fs.wasDirty()).toBe(false);
	});
});

describe("SqlFs reload()", () => {
	it("clears in-memory caches and repopulates from loadAllPaths", async () => {
		const dialect = makeDialect();
		const fs = new SqlFs({ dialect, sandboxId: "s-reload" });
		await fs.ready();

		// Simulate drift: write a local-only path entry via mutation
		await fs.writeFile("/home/user/local-only.txt", "unique");
		expect(fs.getAllPaths()).toContain("/home/user/local-only.txt");
		expect(fs.wasDirty()).toBe(true);

		// Change the dialect snapshot to not include that file, then reload
		(dialect.loadAllPaths as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
			dirEntry("/", 1n),
			dirEntry("/home", 2n),
		]);

		await fs.reload();

		expect(fs.getAllPaths()).toEqual(["/", "/home"]);
		// reload clears the dirty flag so the publisher doesn't bump the version
		// on a turn that only did a cache refresh.
		expect(fs.wasDirty()).toBe(false);
	});

	it("single-flight: concurrent reload calls share one DB round trip", async () => {
		const dialect = makeDialect();
		const fs = new SqlFs({ dialect, sandboxId: "s-flight" });
		await fs.ready();

		(dialect.loadAllPaths as ReturnType<typeof vi.fn>).mockClear();

		await Promise.all([fs.reload(), fs.reload(), fs.reload()]);

		// Three concurrent callers collapsed into one load.
		expect((dialect.loadAllPaths as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
	});

	it("reload preserves old cache when the fresh load throws", async () => {
		const dialect = makeDialect();
		const fs = new SqlFs({ dialect, sandboxId: "s-err" });
		await fs.ready();

		const before = fs.getAllPaths().sort();
		(dialect.loadAllPaths as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("pg down"));

		await expect(fs.reload()).rejects.toThrow("pg down");

		// Old cache must still be intact so subsequent reads don't ENOENT everything.
		expect(fs.getAllPaths().sort()).toEqual(before);
	});
});

/**
 * Unit tests for SqlFs.stat and SqlFs.lstat.
 * US-025: SqlFs.stat and SqlFs.lstat
 */

import { describe, expect, it, vi } from "vitest";
import { SqlFs } from "../sql-fs.js";
import type { PathCacheEntry, SqlDialect } from "../types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const now = new Date("2026-01-01T00:00:00Z");

function makeDialect(): SqlDialect<unknown> {
	const transactionMock = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({}));
	return {
		connect: vi.fn(),
		disconnect: vi.fn(),
		transaction: transactionMock,
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
		gcOrphanBlobs: vi.fn(),
		getBlobsForSandbox: vi.fn(async () => []),
		loadSubtreeInodes: vi.fn(),
		bulkIngest: vi.fn(),
		resolvePath: vi.fn(),
	} as unknown as SqlDialect<unknown>;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("SqlFs.stat and SqlFs.lstat", () => {
	const sandboxId = "test-sandbox";

	async function makeFs(entries: Array<{ path: string } & PathCacheEntry>): Promise<SqlFs> {
		const dialect = makeDialect();
		(dialect.loadAllPaths as ReturnType<typeof vi.fn>).mockResolvedValue(entries);
		const fs = new SqlFs({ dialect, sandboxId });
		await fs.ready();
		return fs;
	}

	const fileEntry: { path: string } & PathCacheEntry = {
		path: "/file.txt",
		inodeId: 10n,
		kind: 1,
		mode: 0o644,
		size: 42,
		mtime: now,
		contentSha256: new Uint8Array(32),
		symlinkTarget: null,
	};

	const dirEntry: { path: string } & PathCacheEntry = {
		path: "/mydir",
		inodeId: 20n,
		kind: 2,
		mode: 0o755,
		size: 0,
		mtime: now,
		contentSha256: null,
		symlinkTarget: null,
	};

	const symlinkEntry: { path: string } & PathCacheEntry = {
		path: "/link",
		inodeId: 30n,
		kind: 3,
		mode: 0o777,
		size: 0,
		mtime: now,
		contentSha256: null,
		symlinkTarget: "/file.txt",
	};

	it("stat on a file returns isFile=true, isDirectory=false, isSymbolicLink=false", async () => {
		const fs = await makeFs([fileEntry]);
		const result = await fs.stat("/file.txt");
		expect(result.isFile).toBe(true);
		expect(result.isDirectory).toBe(false);
		expect(result.isSymbolicLink).toBe(false);
		expect(result.mode).toBe(0o644);
		expect(result.size).toBe(42);
		expect(result.mtime).toEqual(now);
	});

	it("stat on a directory returns isFile=false, isDirectory=true, isSymbolicLink=false", async () => {
		const fs = await makeFs([dirEntry]);
		const result = await fs.stat("/mydir");
		expect(result.isFile).toBe(false);
		expect(result.isDirectory).toBe(true);
		expect(result.isSymbolicLink).toBe(false);
		expect(result.mode).toBe(0o755);
	});

	it("stat on a symlink follows the link and returns target's metadata with isSymbolicLink=false", async () => {
		const fs = await makeFs([fileEntry, symlinkEntry]);
		const result = await fs.stat("/link");
		// Should return the target file's metadata
		expect(result.isFile).toBe(true);
		expect(result.isDirectory).toBe(false);
		expect(result.isSymbolicLink).toBe(false);
		expect(result.size).toBe(42);
	});

	it("stat throws ENOENT for non-existent path", async () => {
		const fs = await makeFs([]);
		await expect(fs.stat("/nonexistent")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("lstat on a file returns isSymbolicLink=false", async () => {
		const fs = await makeFs([fileEntry]);
		const result = await fs.lstat("/file.txt");
		expect(result.isFile).toBe(true);
		expect(result.isDirectory).toBe(false);
		expect(result.isSymbolicLink).toBe(false);
	});

	it("lstat on a directory returns isSymbolicLink=false", async () => {
		const fs = await makeFs([dirEntry]);
		const result = await fs.lstat("/mydir");
		expect(result.isFile).toBe(false);
		expect(result.isDirectory).toBe(true);
		expect(result.isSymbolicLink).toBe(false);
	});

	it("lstat on a symlink returns isSymbolicLink=true and symlink's own metadata", async () => {
		const fs = await makeFs([fileEntry, symlinkEntry]);
		const result = await fs.lstat("/link");
		expect(result.isFile).toBe(false);
		expect(result.isDirectory).toBe(false);
		expect(result.isSymbolicLink).toBe(true);
		expect(result.mode).toBe(0o777);
	});

	it("lstat throws ENOENT for non-existent path", async () => {
		const fs = await makeFs([]);
		await expect(fs.lstat("/nonexistent")).rejects.toMatchObject({ code: "ENOENT" });
	});
});

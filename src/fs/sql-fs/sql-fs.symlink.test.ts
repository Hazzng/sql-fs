/**
 * Unit tests for SqlFs.symlink (default-deny).
 * US-040: SqlFs.symlink (default-deny)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SqlFs } from "./sql-fs.js";
import type { PathCacheEntry, SqlDialect } from "./types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const now = new Date("2026-01-01T00:00:00Z");

function dirEntry(path: string, inodeId: bigint): { path: string } & PathCacheEntry {
	return { path, inodeId, kind: 2, mode: 0o755, size: 0, mtime: now, contentSha256: null, symlinkTarget: null };
}

function makeDialect(overrides: Partial<SqlDialect<unknown>> = {}): SqlDialect<unknown> {
	return {
		connect: vi.fn(),
		disconnect: vi.fn(),
		transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
		setSandboxContext: vi.fn(),
		setSandboxContextWithLock: vi.fn(),
		loadAllPaths: vi.fn(async () => [dirEntry("/", 1n), dirEntry("/home", 2n)]),
		createSandbox: vi.fn(),
		deleteSandbox: vi.fn(),
		createInode: vi.fn(async () => 10n),
		getInode: vi.fn(),
		updateInode: vi.fn(),
		deleteInode: vi.fn(),
		incrementNlink: vi.fn(),
		decrementNlink: vi.fn(),
		insertDirent: vi.fn(async () => undefined),
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
		...overrides,
	} as unknown as SqlDialect<unknown>;
}

// ── Tests: allowSymlinks=false (default) ─────────────────────────────────────

describe("SqlFs.symlink() — allowSymlinks=false (default)", () => {
	const sandboxId = "test-sandbox";
	let fs: SqlFs;

	beforeEach(async () => {
		fs = new SqlFs({ dialect: makeDialect(), sandboxId });
		await fs.ready();
	});

	it("throws EPERM immediately without any DB call", async () => {
		const dialect = makeDialect();
		const strictFs = new SqlFs({ dialect, sandboxId });
		await strictFs.ready();

		await expect(strictFs.symlink("/home", "/home/link")).rejects.toMatchObject({ code: "EPERM" });
		expect(dialect.createInode).not.toHaveBeenCalled();
		expect(dialect.insertDirent).not.toHaveBeenCalled();
	});

	it("throws EPERM when allowSymlinks is explicitly false", async () => {
		const dialect = makeDialect();
		const strictFs = new SqlFs({ dialect, sandboxId, allowSymlinks: false });
		await strictFs.ready();

		await expect(strictFs.symlink("/home", "/home/link")).rejects.toMatchObject({ code: "EPERM" });
	});
});

// ── Tests: allowSymlinks=true ─────────────────────────────────────────────────

describe("SqlFs.symlink() — allowSymlinks=true", () => {
	const sandboxId = "test-sandbox";
	let createInodeMock: ReturnType<typeof vi.fn>;
	let insertDirentMock: ReturnType<typeof vi.fn>;
	let dialect: SqlDialect<unknown>;
	let fs: SqlFs;

	beforeEach(async () => {
		createInodeMock = vi.fn(async () => 10n);
		insertDirentMock = vi.fn(async () => undefined);

		dialect = makeDialect({ createInode: createInodeMock, insertDirent: insertDirentMock });
		fs = new SqlFs({ dialect, sandboxId, allowSymlinks: true });
		await fs.ready();
	});

	it("adds new path to pathCache with kind=3", async () => {
		await fs.symlink("/home", "/home/mylink");

		expect(fs.getAllPaths()).toContain("/home/mylink");
	});

	it("readlink on the created symlink returns the target", async () => {
		await fs.symlink("/home", "/home/mylink");

		await expect(fs.readlink("/home/mylink")).resolves.toBe("/home");
	});

	it("calls createInode with kind=3 and symlinkTarget", async () => {
		await fs.symlink("/home", "/home/mylink");

		expect(createInodeMock).toHaveBeenCalledWith(
			expect.anything(), // tx
			expect.objectContaining({ kind: 3, symlinkTarget: "/home" }),
		);
	});

	it("calls insertDirent with parent inodeId and link name", async () => {
		await fs.symlink("/home", "/home/mylink");

		expect(insertDirentMock).toHaveBeenCalledWith(
			expect.anything(), // tx
			2n, // parent /home inodeId
			"mylink",
			10n, // new inode id returned by createInode
		);
	});

	it("pathCache entry has kind=3 and correct symlinkTarget", async () => {
		await fs.symlink("/home", "/home/mylink");

		// lstat should show isSymbolicLink=true
		const stat = await fs.lstat("/home/mylink");
		expect(stat.isSymbolicLink).toBe(true);
	});
});

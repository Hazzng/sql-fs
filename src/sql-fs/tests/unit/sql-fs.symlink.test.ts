/**
 * Unit tests for SqlFs.symlink defaults and explicit denial.
 * US-040: SqlFs.symlink defaults and explicit denial
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SqlFs } from "../../sql-fs.js";
import type { PathCacheEntry, SqlDialect } from "../../types.js";

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
		getSandboxEpoch: vi.fn(async () => 0n),
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

// ── Tests: symlinks enabled by default ─────────────────────────────────────

describe("SqlFs.symlink() — symlinks enabled by default", () => {
	const sandboxId = "test-sandbox";
	it("creates a readable link when the option is omitted", async () => {
		const dialect = makeDialect();
		const defaultFs = new SqlFs({ dialect, sandboxId });
		await defaultFs.ready();

		await defaultFs.symlink("/home", "/home/link");
		expect(await defaultFs.readlink("/home/link")).toBe("/home");
		expect((await defaultFs.lstat("/home/link")).isSymbolicLink).toBe(true);
	});

	it("throws EPERM when allowSymlinks is explicitly false", async () => {
		const dialect = makeDialect();
		const strictFs = new SqlFs({ dialect, sandboxId, allowSymlinks: false });
		await strictFs.ready();

		await expect(strictFs.symlink("/home", "/home/link")).rejects.toMatchObject({ code: "EPERM" });
		expect(dialect.createInode).not.toHaveBeenCalled();
		expect(dialect.insertDirent).not.toHaveBeenCalled();
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
			0n,
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

/**
 * Unit tests for SqlFs.readdir and SqlFs.readdirWithFileTypes.
 * US-027: SqlFs.readdir and readdirWithFileTypes
 */

import { describe, expect, it, vi } from "vitest";
import { SqlFs } from "./sql-fs.js";
import type { PathCacheEntry, SqlDialect } from "./types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const now = new Date("2026-01-01T00:00:00Z");

function makeDialect(): SqlDialect<unknown> {
	const transactionMock = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({}));
	return {
		connect: vi.fn(),
		disconnect: vi.fn(),
		transaction: transactionMock,
		setSandboxContext: vi.fn(),
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
		loadSubtreeInodes: vi.fn(),
		bulkIngest: vi.fn(),
		resolvePath: vi.fn(),
	} as unknown as SqlDialect<unknown>;
}

async function makeFs(entries: Array<{ path: string } & PathCacheEntry>): Promise<SqlFs> {
	const dialect = makeDialect();
	(dialect.loadAllPaths as ReturnType<typeof vi.fn>).mockResolvedValue(entries);
	const fs = new SqlFs({ dialect, sandboxId: "test-sandbox" });
	await fs.ready();
	return fs;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("SqlFs.readdir and SqlFs.readdirWithFileTypes", () => {
	const rootEntry: { path: string } & PathCacheEntry = {
		path: "/",
		inodeId: 1n,
		kind: 2,
		mode: 0o755,
		size: 0,
		mtime: now,
		contentSha256: null,
		symlinkTarget: null,
	};

	const fileEntry: { path: string } & PathCacheEntry = {
		path: "/file.txt",
		inodeId: 10n,
		kind: 1,
		mode: 0o644,
		size: 100,
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

	it("readdir returns names of direct children (file, dir, symlink)", async () => {
		const fs = await makeFs([rootEntry, fileEntry, dirEntry, symlinkEntry]);
		const names = await fs.readdir("/");
		expect(names.sort()).toEqual(["file.txt", "link", "mydir"]);
	});

	it("readdir on a nested directory returns only its direct children", async () => {
		const parentEntry: { path: string } & PathCacheEntry = {
			path: "/parent",
			inodeId: 2n,
			kind: 2,
			mode: 0o755,
			size: 0,
			mtime: now,
			contentSha256: null,
			symlinkTarget: null,
		};
		const childEntry: { path: string } & PathCacheEntry = {
			path: "/parent/child.txt",
			inodeId: 3n,
			kind: 1,
			mode: 0o644,
			size: 0,
			mtime: now,
			contentSha256: new Uint8Array(32),
			symlinkTarget: null,
		};
		const grandchildEntry: { path: string } & PathCacheEntry = {
			path: "/parent/child.txt/not-a-child",
			// Note: just testing that grandchildren are not returned
			// In practice, a file can't have children, but we test the prefix logic
			inodeId: 4n,
			kind: 1,
			mode: 0o644,
			size: 0,
			mtime: now,
			contentSha256: new Uint8Array(32),
			symlinkTarget: null,
		};
		// Only direct children: /parent/child.txt — /parent/child.txt/not-a-child is not a direct child
		const fs = await makeFs([rootEntry, parentEntry, childEntry, grandchildEntry]);
		const names = await fs.readdir("/parent");
		expect(names).toEqual(["child.txt"]);
	});

	it("readdir throws ENOENT for a non-existent path", async () => {
		const fs = await makeFs([rootEntry]);
		await expect(fs.readdir("/nonexistent")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("readdir throws ENOTDIR for a file path", async () => {
		const fs = await makeFs([rootEntry, fileEntry]);
		await expect(fs.readdir("/file.txt")).rejects.toMatchObject({ code: "ENOTDIR" });
	});

	it("readdirWithFileTypes returns DirentEntry[] with correct types", async () => {
		const fs = await makeFs([rootEntry, fileEntry, dirEntry, symlinkEntry]);
		const entries = await fs.readdirWithFileTypes!("/");
		const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));

		expect(sorted).toEqual([
			{ name: "file.txt", isFile: true, isDirectory: false, isSymbolicLink: false },
			{ name: "link", isFile: false, isDirectory: false, isSymbolicLink: true },
			{ name: "mydir", isFile: false, isDirectory: true, isSymbolicLink: false },
		]);
	});

	it("readdirWithFileTypes throws ENOENT for non-existent path", async () => {
		const fs = await makeFs([rootEntry]);
		await expect(fs.readdirWithFileTypes!("/nonexistent")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("readdirWithFileTypes throws ENOTDIR for a file path", async () => {
		const fs = await makeFs([rootEntry, fileEntry]);
		await expect(fs.readdirWithFileTypes!("/file.txt")).rejects.toMatchObject({ code: "ENOTDIR" });
	});
});

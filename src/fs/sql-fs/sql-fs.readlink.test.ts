/**
 * Unit tests for SqlFs.readlink.
 * US-029: SqlFs.readlink
 */

import { describe, expect, it, vi } from "vitest";
import { SqlFs } from "./sql-fs.js";
import type { PathCacheEntry, SqlDialect } from "./types.js";

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

const now = new Date("2026-01-01T00:00:00Z");

async function makeFs(entries: Array<{ path: string } & PathCacheEntry>): Promise<SqlFs> {
	const dialect = makeDialect();
	(dialect.loadAllPaths as ReturnType<typeof vi.fn>).mockResolvedValue(entries);
	const fs = new SqlFs({ dialect, sandboxId: "test-sandbox" });
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

describe("SqlFs.readlink", () => {
	it("returns the symlink target string", async () => {
		const fs = await makeFs([fileEntry, symlinkEntry]);
		const target = await fs.readlink("/link");
		expect(target).toBe("/file.txt");
	});

	it("throws EINVAL when path is a regular file (not a symlink)", async () => {
		const fs = await makeFs([fileEntry]);
		await expect(fs.readlink("/file.txt")).rejects.toMatchObject({ code: "EINVAL" });
	});

	it("throws ENOENT when path does not exist", async () => {
		const fs = await makeFs([]);
		await expect(fs.readlink("/nonexistent")).rejects.toMatchObject({ code: "ENOENT" });
	});
});

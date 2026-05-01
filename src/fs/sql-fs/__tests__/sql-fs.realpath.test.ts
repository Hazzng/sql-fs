/**
 * Unit tests for SqlFs.realpath.
 * US-030: SqlFs.realpath
 */

import { describe, expect, it, vi } from "vitest";

import { createEloop, createEnoent } from "../errors.js";
import { SqlFs } from "../sql-fs.js";
import type { PathCacheEntry, SqlDialect } from "../types.js";

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

async function makeFs(
	entries: Array<{ path: string } & PathCacheEntry>,
): Promise<{ fs: SqlFs; dialect: SqlDialect<unknown> }> {
	const dialect = makeDialect();
	(dialect.loadAllPaths as ReturnType<typeof vi.fn>).mockResolvedValue(entries);
	const fs = new SqlFs({ dialect, sandboxId: "test-sandbox" });
	await fs.ready();
	return { fs, dialect };
}

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

const realFileEntry: { path: string } & PathCacheEntry = {
	path: "/real",
	inodeId: 3n,
	kind: 1,
	mode: 0o644,
	size: 42,
	mtime: now,
	contentSha256: new Uint8Array(32),
	symlinkTarget: null,
};

const symlinkEntry: { path: string } & PathCacheEntry = {
	path: "/link",
	inodeId: 2n,
	kind: 3,
	mode: 0o777,
	size: 0,
	mtime: now,
	contentSha256: null,
	symlinkTarget: "/real",
};

describe("SqlFs.realpath", () => {
	it("resolves symlink to canonical path via dialect.resolvePath", async () => {
		const { fs, dialect } = await makeFs([rootEntry, symlinkEntry, realFileEntry]);
		(dialect.resolvePath as ReturnType<typeof vi.fn>).mockResolvedValue(3n);

		const result = await fs.realpath("/link");
		expect(result).toBe("/real");
		expect(dialect.resolvePath).toHaveBeenCalledWith(expect.anything(), "/link", true);
	});

	it("returns the path for a non-symlink (resolves to its own inodeId)", async () => {
		const { fs, dialect } = await makeFs([rootEntry, realFileEntry]);
		(dialect.resolvePath as ReturnType<typeof vi.fn>).mockResolvedValue(3n);

		const result = await fs.realpath("/real");
		expect(result).toBe("/real");
	});

	it("calls dialect.resolvePath with followLast=true", async () => {
		const { fs, dialect } = await makeFs([rootEntry, realFileEntry]);
		(dialect.resolvePath as ReturnType<typeof vi.fn>).mockResolvedValue(3n);

		await fs.realpath("/real");
		expect(dialect.resolvePath).toHaveBeenCalledWith(expect.anything(), "/real", true);
	});

	it("throws ENOENT when resolvePath throws ENOENT", async () => {
		const { fs, dialect } = await makeFs([rootEntry]);
		(dialect.resolvePath as ReturnType<typeof vi.fn>).mockRejectedValue(createEnoent("/missing"));

		await expect(fs.realpath("/missing")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("throws ELOOP when resolvePath detects circular symlinks", async () => {
		const { fs, dialect } = await makeFs([rootEntry]);
		(dialect.resolvePath as ReturnType<typeof vi.fn>).mockRejectedValue(createEloop("/circular"));

		await expect(fs.realpath("/circular")).rejects.toMatchObject({ code: "ELOOP" });
	});
});

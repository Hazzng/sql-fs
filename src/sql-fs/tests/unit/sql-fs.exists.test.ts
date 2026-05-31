/**
 * Unit tests for SqlFs.exists.
 * US-026: SqlFs.exists
 */

import { describe, expect, it, vi } from "vitest";
import { SqlFs } from "../../sql-fs.js";
import type { PathCacheEntry, SqlDialect } from "../../types.js";

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

describe("SqlFs.exists", () => {
	const sandboxId = "test-sandbox";

	async function makeFs(entries: Array<{ path: string } & PathCacheEntry>): Promise<SqlFs> {
		const dialect = makeDialect();
		(dialect.loadAllPaths as ReturnType<typeof vi.fn>).mockResolvedValue(entries);
		const fs = new SqlFs({ dialect, sandboxId });
		await fs.ready();
		return fs;
	}

	it("returns true for an existing path", async () => {
		const fs = await makeFs([fileEntry]);
		const result = await fs.exists("/file.txt");
		expect(result).toBe(true);
	});

	it("returns false for a non-existing path", async () => {
		const fs = await makeFs([fileEntry]);
		const result = await fs.exists("/nonexistent.txt");
		expect(result).toBe(false);
	});

	it("never throws — returns false for empty cache", async () => {
		const fs = await makeFs([]);
		await expect(fs.exists("/anything")).resolves.toBe(false);
	});
});

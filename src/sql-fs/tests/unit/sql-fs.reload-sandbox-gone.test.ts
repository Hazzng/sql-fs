/**
 * F7 unit test: SqlFs.reload() must not install an empty pathCache when the
 * sandbox has been destroyed on another replica.
 *
 * A live sandbox's recursive-CTE `loadAllPaths` always returns at least the
 * root dir; zero rows means the sandbox/root is gone. reload() must throw
 * ESANDBOXGONE (so the session manager tears the warm session down) and leave
 * the prior caches intact rather than serving ghost ENOENTs.
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
	size: 42,
	mtime: now,
	contentSha256: new Uint8Array(32),
	symlinkTarget: null,
};

describe("SqlFs.reload — sandbox gone (F7)", () => {
	it("throws ESANDBOXGONE when loadAllPaths returns zero rows on reload", async () => {
		const dialect = makeDialect();
		const loadAllPaths = dialect.loadAllPaths as ReturnType<typeof vi.fn>;
		// Initial ready() sees a live, populated sandbox.
		loadAllPaths.mockResolvedValueOnce([rootEntry, fileEntry]);
		const fs = new SqlFs({ dialect, sandboxId: "sbx" });
		await fs.ready();
		expect(await fs.exists("/file.txt")).toBe(true);

		// The sandbox is destroyed elsewhere → reload sees zero rows.
		loadAllPaths.mockResolvedValueOnce([]);
		await expect(fs.reload()).rejects.toMatchObject({ code: "ESANDBOXGONE" });

		// The prior cache must be left intact — reload must NOT have installed an
		// empty pathCache (which would serve ghost ENOENTs for everything).
		expect(await fs.exists("/file.txt")).toBe(true);
	});

	it("reload succeeds normally when the sandbox still has rows", async () => {
		const dialect = makeDialect();
		const loadAllPaths = dialect.loadAllPaths as ReturnType<typeof vi.fn>;
		loadAllPaths.mockResolvedValueOnce([rootEntry, fileEntry]);
		const fs = new SqlFs({ dialect, sandboxId: "sbx" });
		await fs.ready();

		// Reload reflects a new file added by another replica.
		const newEntry = { ...fileEntry, path: "/new.txt", inodeId: 11n };
		loadAllPaths.mockResolvedValueOnce([rootEntry, fileEntry, newEntry]);
		await expect(fs.reload()).resolves.toBeUndefined();
		expect(await fs.exists("/new.txt")).toBe(true);
	});
});

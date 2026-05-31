/**
 * Regression: cp of a single symlink must preserve the link (audit M8).
 *
 * Previously SqlFs.cp forced kind=FILE for the single-entry path, turning a
 * copied symlink into a corrupt FILE inode (non-zero size, NULL content). cp
 * now preserves the source inode's kind + symlinkTarget, matching the
 * recursive-cp path.
 */

import { describe, expect, it, vi } from "vitest";
import { SqlFs } from "../../sql-fs.js";
import type { PathCacheEntry, SqlDialect } from "../../types.js";

const now = new Date("2026-01-01T00:00:00Z");
const fileSha = new Uint8Array(32).fill(0xab);

function entry(p: Partial<PathCacheEntry> & { path: string; inodeId: bigint; kind: 1 | 2 | 3 }): {
	path: string;
} & PathCacheEntry {
	return {
		path: p.path,
		inodeId: p.inodeId,
		kind: p.kind,
		mode: p.mode ?? 0o644,
		size: p.size ?? 0,
		mtime: now,
		contentSha256: p.contentSha256 ?? null,
		symlinkTarget: p.symlinkTarget ?? null,
	};
}

describe("cp single symlink preserves the link (M8 regression)", () => {
	it("creates a SYMLINK inode with the same target, not a corrupt FILE", async () => {
		const createInodeMock = vi.fn(async () => 99n);
		const targetPath = "/home/user/real.txt";

		const dialect = {
			connect: vi.fn(),
			disconnect: vi.fn(),
			transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
			setSandboxContext: vi.fn(),
			setSandboxContextWithLock: vi.fn(),
			loadAllPaths: vi.fn(async () => [
				entry({ path: "/", inodeId: 1n, kind: 2, mode: 0o755 }),
				entry({ path: "/home", inodeId: 2n, kind: 2, mode: 0o755 }),
				entry({ path: "/home/user", inodeId: 3n, kind: 2, mode: 0o755 }),
				entry({ path: targetPath, inodeId: 4n, kind: 1, size: 10, contentSha256: fileSha }),
				entry({
					path: "/home/user/link",
					inodeId: 5n,
					kind: 3,
					mode: 0o777,
					size: targetPath.length,
					symlinkTarget: targetPath,
				}),
			]),
			createSandbox: vi.fn(),
			deleteSandbox: vi.fn(),
			createInode: createInodeMock,
			getInode: vi.fn(),
			updateInode: vi.fn(),
			deleteInode: vi.fn(),
			incrementNlink: vi.fn(),
			decrementNlink: vi.fn(async () => 0),
			insertDirent: vi.fn(),
			upsertDirent: vi.fn(async () => null),
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
			getBlobNoTx: vi.fn(async () => null),
		} as unknown as SqlDialect<unknown>;

		const fs = new SqlFs({ dialect, sandboxId: "s", allowSymlinks: true });
		await fs.ready();

		await fs.cp("/home/user/link", "/home/user/copy");

		// The copy preserves the symlink kind + target (no forced FILE inode).
		expect(createInodeMock).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				kind: 3, // INODE_KIND.SYMLINK
				symlinkTarget: targetPath,
				contentSha256: null,
			}),
		);

		// lstat reports a symlink (not a file) with the target's string length —
		// no corrupt FILE inode with NULL content.
		const ls = await fs.lstat("/home/user/copy");
		expect(ls.isSymbolicLink).toBe(true);
		expect(ls.isFile).toBe(false);
		expect(ls.size).toBe(targetPath.length);
	});
});

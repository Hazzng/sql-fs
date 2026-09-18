/**
 * SqlFs.bulkGraft — cache coherence. The graft updates the path cache, never
 * puts anything in the content cache (it has no bytes), evicts a replaced
 * inode's stale content, and propagates EGRAFTMISSING unchanged.
 */

import { describe, expect, it, vi } from "vitest";
import { SqlFs } from "../../sql-fs.js";
import type { GraftFile, PathCacheEntry, SqlDialect } from "../../types.js";

const now = new Date("2026-01-01T00:00:00Z");

function dirEntry(path: string, inodeId: bigint): { path: string } & PathCacheEntry {
	return { path, inodeId, kind: 2, mode: 0o755, size: 0, mtime: now, contentSha256: null, symlinkTarget: null };
}

function fileEntry(inodeId: bigint, sha256: Uint8Array, size: number): PathCacheEntry {
	return { inodeId, kind: 1, mode: 0o644, size, mtime: now, contentSha256: sha256, symlinkTarget: null };
}

function makeFs(bulkGraft: SqlDialect<unknown>["bulkGraft"]): SqlFs<unknown> {
	const dialect = {
		connect: vi.fn(),
		disconnect: vi.fn(),
		transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
		setSandboxContext: vi.fn(),
		setSandboxContextWithLock: vi.fn(),
		loadAllPaths: vi.fn(async () => [dirEntry("/", 1n), dirEntry("/site-packages", 2n)]),
		getBlobsForSandbox: vi.fn(async () => []),
		bulkGraft,
	} as unknown as SqlDialect<unknown>;
	return new SqlFs<unknown>({ dialect, sandboxId: "sbx" });
}

const sha = new Uint8Array(32).fill(0xa1);
const files: GraftFile[] = [{ path: "/site-packages/demo/mod.py", sha256: sha, mode: 0o644, size: 7 }];

describe("SqlFs.bulkGraft", () => {
	it("adds the grafted paths to the path cache", async () => {
		const fs = makeFs(
			vi.fn(
				async () =>
					new Map<string, PathCacheEntry>([
						["/site-packages/demo", dirEntry("/site-packages/demo", 10n)],
						["/site-packages/demo/mod.py", fileEntry(11n, sha, 7)],
					]),
			),
		);
		await fs.ready();

		await fs.bulkGraft(files);

		const stat = await fs.stat("/site-packages/demo/mod.py");
		expect(stat.isFile).toBe(true);
		expect(stat.size).toBe(7);
		expect((await fs.stat("/site-packages/demo")).isDirectory).toBe(true);
	});

	it("puts nothing in the content cache", async () => {
		const fs = makeFs(
			vi.fn(async () => new Map<string, PathCacheEntry>([["/site-packages/demo/mod.py", fileEntry(11n, sha, 7)]])),
		);
		await fs.ready();

		await fs.bulkGraft(files);

		expect(fs._getContentCache().size).toBe(0);
	});

	it("marks the filesystem dirty", async () => {
		const fs = makeFs(
			vi.fn(async () => new Map<string, PathCacheEntry>([["/site-packages/demo/mod.py", fileEntry(11n, sha, 7)]])),
		);
		await fs.ready();
		fs.clearDirty();

		await fs.bulkGraft(files);

		expect(fs.wasDirty()).toBe(true);
	});

	it("evicts the content of an inode it replaces", async () => {
		let inodeId = 11n;
		const fs = makeFs(
			vi.fn(async () => {
				const entry = fileEntry(inodeId, sha, 7);
				inodeId += 1n;
				return new Map<string, PathCacheEntry>([["/site-packages/demo/mod.py", entry]]);
			}),
		);
		await fs.ready();
		await fs.bulkGraft(files);
		fs._getContentCache().set(11n, new Uint8Array([1, 2, 3]));

		await fs.bulkGraft(files);

		expect(fs._getContentCache().has(11n)).toBe(false);
	});

	it("propagates EGRAFTMISSING with the missing hashes", async () => {
		const missing = ["aa".repeat(32)];
		const fs = makeFs(
			vi.fn(async () => {
				throw Object.assign(new Error("EGRAFTMISSING: 1 referenced blob(s) are no longer stored"), {
					code: "EGRAFTMISSING",
					missing,
				});
			}),
		);
		await fs.ready();

		const err = (await fs.bulkGraft(files).catch((e: unknown) => e)) as Error & {
			code?: string;
			missing?: string[];
		};

		expect(err.code).toBe("EGRAFTMISSING");
		expect(err.missing).toEqual(missing);
	});

	it("rejects two inputs that normalise to the same path", async () => {
		const fs = makeFs(vi.fn(async () => new Map<string, PathCacheEntry>()));
		await fs.ready();

		const err = (await fs
			.bulkGraft([files[0]!, { ...files[0]!, path: "/site-packages/demo/./mod.py" }])
			.catch((e: unknown) => e)) as Error & { code?: string };

		expect(err.code).toBe("EEXIST");
	});

	it("does nothing when given no files", async () => {
		const bulkGraft = vi.fn(async () => new Map<string, PathCacheEntry>());
		const fs = makeFs(bulkGraft);
		await fs.ready();

		await fs.bulkGraft([]);

		expect(bulkGraft).not.toHaveBeenCalled();
	});
});

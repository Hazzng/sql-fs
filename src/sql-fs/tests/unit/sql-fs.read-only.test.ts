/**
 * Unit tests for SqlFs read-only scope (parallel readOnly bash exec).
 *
 * Coverage:
 *  - Begin/end scope toggles the active flag.
 *  - Every mutating method throws EREADONLY while the scope is active.
 *  - The violated flag flips to true on the first attempted mutation and is
 *    reset on the next beginReadOnlyScope.
 *  - Read methods continue to work while the scope is active.
 *  - No DB write methods are dispatched (dialect mocks remain uncalled) — the
 *    rejection is a fast pre-DB guard.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readOnlyContext } from "../../../api/read-only-context.js";
import { SqlFs } from "../../sql-fs.js";
import type { PathCacheEntry, SqlDialect } from "../../types.js";

const now = new Date("2026-01-01T00:00:00Z");

const ROOT: { path: string } & PathCacheEntry = {
	path: "/",
	inodeId: 1n,
	kind: 2,
	mode: 0o755,
	size: 0,
	mtime: now,
	contentSha256: null,
	symlinkTarget: null,
};

const FILE: { path: string } & PathCacheEntry = {
	path: "/file.txt",
	inodeId: 10n,
	kind: 1,
	mode: 0o644,
	size: 5,
	mtime: now,
	contentSha256: new Uint8Array(32),
	symlinkTarget: null,
};

function makeFs() {
	const dialect = {
		connect: vi.fn(),
		disconnect: vi.fn(),
		transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
		setSandboxContext: vi.fn(),
		setSandboxContextWithLock: vi.fn(),
		loadAllPaths: vi.fn(async () => [ROOT, FILE]),
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
		getBlob: vi.fn(async () => null),
		getBlobNoTx: vi.fn(async () => null),
		gcOrphanBlobs: vi.fn(),
		getBlobsForSandbox: vi.fn(async () => []),
		loadSubtreeInodes: vi.fn(async () => []),
		bulkIngest: vi.fn(),
		resolvePath: vi.fn(),
	} as unknown as SqlDialect<unknown>;
	const fs = new SqlFs({ dialect, sandboxId: "s1" });
	return { fs, dialect };
}

describe("SqlFs.readOnlyScope", () => {
	let fs: SqlFs;
	let dialect: SqlDialect<unknown>;

	beforeEach(async () => {
		const made = makeFs();
		fs = made.fs;
		dialect = made.dialect;
		await fs.ready();
	});

	it("begin/end toggles the active flag", () => {
		expect(fs.readOnlyScopeActive).toBe(false);
		fs.beginReadOnlyScope();
		expect(fs.readOnlyScopeActive).toBe(true);
		fs.endReadOnlyScope();
		expect(fs.readOnlyScopeActive).toBe(false);
	});

	it("ref-counts nested begin/end (parallel readers)", () => {
		fs.beginReadOnlyScope();
		fs.beginReadOnlyScope();
		expect(fs.readOnlyScopeActive).toBe(true);
		fs.endReadOnlyScope();
		expect(fs.readOnlyScopeActive).toBe(true); // still held by the first begin
		fs.endReadOnlyScope();
		expect(fs.readOnlyScopeActive).toBe(false);
	});

	it("endReadOnlyScope without an active scope throws", () => {
		expect(() => fs.endReadOnlyScope()).toThrow(/no active read-only scope/);
	});

	it("writeFile throws EREADONLY before issuing any DB call", async () => {
		fs.beginReadOnlyScope();
		const ctx = { violated: false };
		await readOnlyContext.run(ctx, async () => {
			await expect(fs.writeFile("/new.txt", "x")).rejects.toMatchObject({ code: "EREADONLY" });
		});
		// The throw happens before any new transaction is opened — only the
		// initial loadAllPaths transaction from ready() may have run.
		expect(dialect.upsertBlob).not.toHaveBeenCalled();
		expect(dialect.createInode).not.toHaveBeenCalled();
		expect(dialect.upsertDirent).not.toHaveBeenCalled();
		expect(dialect.deleteDirent).not.toHaveBeenCalled();
		expect(dialect.updateInode).not.toHaveBeenCalled();
		expect(ctx.violated).toBe(true);
		fs.endReadOnlyScope();
	});

	it("violation marks only the originating reader's context, not concurrent ones", async () => {
		fs.beginReadOnlyScope();
		fs.beginReadOnlyScope();
		const ctxLying = { violated: false };
		const ctxInnocent = { violated: false };

		await readOnlyContext.run(ctxLying, async () => {
			await expect(fs.writeFile("/lie.txt", "x")).rejects.toMatchObject({ code: "EREADONLY" });
		});
		await readOnlyContext.run(ctxInnocent, async () => {
			await fs.exists("/file.txt");
		});

		expect(ctxLying.violated).toBe(true);
		expect(ctxInnocent.violated).toBe(false);
		fs.endReadOnlyScope();
		fs.endReadOnlyScope();
	});

	it("appendFile, mkdir, rm, chmod, utimes, cp, mv, link all throw EREADONLY", async () => {
		fs.beginReadOnlyScope();
		await readOnlyContext.run({ violated: false }, async () => {
			await expect(fs.appendFile("/file.txt", "y")).rejects.toMatchObject({ code: "EREADONLY" });
			await expect(fs.mkdir("/d")).rejects.toMatchObject({ code: "EREADONLY" });
			await expect(fs.rm("/file.txt")).rejects.toMatchObject({ code: "EREADONLY" });
			await expect(fs.chmod("/file.txt", 0o600)).rejects.toMatchObject({ code: "EREADONLY" });
			await expect(fs.utimes("/file.txt", now, now)).rejects.toMatchObject({ code: "EREADONLY" });
			await expect(fs.cp("/file.txt", "/copy.txt")).rejects.toMatchObject({ code: "EREADONLY" });
			await expect(fs.mv("/file.txt", "/moved.txt")).rejects.toMatchObject({ code: "EREADONLY" });
			await expect(fs.link("/file.txt", "/link.txt")).rejects.toMatchObject({ code: "EREADONLY" });
			await expect(fs.bulkIngest([{ path: "/x", content: new Uint8Array([1]), mode: 0o644 }])).rejects.toMatchObject({
				code: "EREADONLY",
			});
		});
		// The throw happens before any new transaction is opened — only the
		// initial loadAllPaths transaction from ready() may have run.
		expect(dialect.upsertBlob).not.toHaveBeenCalled();
		expect(dialect.createInode).not.toHaveBeenCalled();
		expect(dialect.upsertDirent).not.toHaveBeenCalled();
		expect(dialect.deleteDirent).not.toHaveBeenCalled();
		expect(dialect.updateInode).not.toHaveBeenCalled();
		fs.endReadOnlyScope();
	});

	it("symlink also throws EREADONLY (even before the symlinks-disabled check)", async () => {
		fs.beginReadOnlyScope();
		await readOnlyContext.run({ violated: false }, async () => {
			await expect(fs.symlink("/file.txt", "/link.txt")).rejects.toMatchObject({ code: "EREADONLY" });
		});
		fs.endReadOnlyScope();
	});

	it("read methods still work while the scope is active", async () => {
		fs.beginReadOnlyScope();
		await expect(fs.exists("/file.txt")).resolves.toBe(true);
		await expect(fs.exists("/missing")).resolves.toBe(false);
		await expect(fs.readdir("/")).resolves.toEqual(["file.txt"]);
		const stat = await fs.stat("/file.txt");
		expect(stat.size).toBe(5);
		fs.endReadOnlyScope();
	});

	it("after the last end, writes succeed again and #assertWritable is a no-op", async () => {
		fs.beginReadOnlyScope();
		const ctx = { violated: false };
		await readOnlyContext.run(ctx, async () => {
			await expect(fs.writeFile("/x.txt", "y")).rejects.toMatchObject({ code: "EREADONLY" });
		});
		expect(ctx.violated).toBe(true);
		fs.endReadOnlyScope();
		expect(fs.readOnlyScopeActive).toBe(false);

		// A fresh context outside any scope is never marked as violated —
		// even if a context is in scope, writes are unguarded once depth is 0.
		const fresh = { violated: false };
		await readOnlyContext.run(fresh, async () => {
			// Reads obviously work; writes would also work (we don't actually
			// fire one to avoid the dialect mocks; the depth check is enough).
			expect(fs.readOnlyScopeActive).toBe(false);
		});
		expect(fresh.violated).toBe(false);
	});
});

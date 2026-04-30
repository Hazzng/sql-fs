/**
 * Unit tests for SqlFs.chmod and SqlFs.utimes.
 * US-041: SqlFs.chmod and SqlFs.utimes
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SqlFs } from "./sql-fs.js";
import type { PathCacheEntry, SqlDialect } from "./types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const now = new Date("2026-01-01T00:00:00Z");

const FILE: { path: string } & PathCacheEntry = {
	path: "/file.txt",
	inodeId: 10n,
	kind: 1,
	mode: 0o644,
	size: 42,
	mtime: now,
	contentSha256: new Uint8Array(32),
	symlinkTarget: null,
};

function makeFs() {
	const updateInodeMock = vi.fn(async () => undefined);
	const dialect: SqlDialect<unknown> = {
		connect: vi.fn(),
		disconnect: vi.fn(),
		transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
		setSandboxContext: vi.fn(),
		setSandboxContextWithLock: vi.fn(),
		loadAllPaths: vi.fn(async () => [FILE]),
		createSandbox: vi.fn(),
		deleteSandbox: vi.fn(),
		createInode: vi.fn(),
		getInode: vi.fn(),
		updateInode: updateInodeMock,
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
		loadSubtreeInodes: vi.fn(async () => []),
		bulkIngest: vi.fn(),
		resolvePath: vi.fn(),
	} as unknown as SqlDialect<unknown>;
	const fs = new SqlFs({ dialect, sandboxId: "s1" });
	return { fs, updateInodeMock };
}

// ── chmod ─────────────────────────────────────────────────────────────────────

describe("SqlFs.chmod", () => {
	let fs: SqlFs;
	let updateInodeMock: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		({ fs, updateInodeMock } = makeFs());
		await fs.ready();
	});

	it("calls updateInode with new mode and reflects change in stat()", async () => {
		await fs.chmod("/file.txt", 0o600);

		expect(updateInodeMock).toHaveBeenCalledOnce();
		expect(updateInodeMock).toHaveBeenCalledWith(expect.anything(), 10n, { mode: 0o600 });

		const s = await fs.stat("/file.txt");
		expect(s.mode).toBe(0o600);
	});

	it("throws ENOENT when path does not exist", async () => {
		await expect(fs.chmod("/nonexistent.txt", 0o600)).rejects.toMatchObject({ code: "ENOENT" });
	});
});

// ── utimes ────────────────────────────────────────────────────────────────────

describe("SqlFs.utimes", () => {
	let fs: SqlFs;
	let updateInodeMock: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		({ fs, updateInodeMock } = makeFs());
		await fs.ready();
	});

	it("calls updateInode with new mtime and reflects change in stat()", async () => {
		const newMtime = new Date("2026-06-01T00:00:00Z");
		await fs.utimes("/file.txt", newMtime, newMtime);

		expect(updateInodeMock).toHaveBeenCalledOnce();
		expect(updateInodeMock).toHaveBeenCalledWith(expect.anything(), 10n, { mtime: newMtime });

		const s = await fs.stat("/file.txt");
		expect(s.mtime).toEqual(newMtime);
	});

	it("throws ENOENT when path does not exist", async () => {
		const t = new Date();
		await expect(fs.utimes("/nonexistent.txt", t, t)).rejects.toMatchObject({ code: "ENOENT" });
	});
});

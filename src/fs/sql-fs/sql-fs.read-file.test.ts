/**
 * Unit tests for SqlFs.readFile and SqlFs.readFileBuffer.
 * US-028: ENOENT/EISDIR guards, readFileBuffer returns raw Uint8Array
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SqlFs } from "./sql-fs.js";
import type { PathCacheEntry, SqlDialect } from "./types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const now = new Date("2026-01-01T00:00:00Z");
const sha256 = new Uint8Array(32).fill(0xcd);

function fileEntry(path: string, inodeId: bigint): { path: string } & PathCacheEntry {
	return { path, inodeId, kind: 1, mode: 0o644, size: 5, mtime: now, contentSha256: sha256, symlinkTarget: null };
}

function dirEntry(path: string, inodeId: bigint): { path: string } & PathCacheEntry {
	return { path, inodeId, kind: 2, mode: 0o755, size: 0, mtime: now, contentSha256: null, symlinkTarget: null };
}

function makeFs(
	entries: Array<{ path: string } & PathCacheEntry>,
	blobData: Uint8Array,
): {
	fs: SqlFs;
	getBlobMock: ReturnType<typeof vi.fn>;
} {
	const getBlobMock = vi.fn(async () => blobData);
	const dialect: SqlDialect<unknown> = {
		connect: vi.fn(),
		disconnect: vi.fn(),
		transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
		setSandboxContext: vi.fn(),
		setSandboxContextWithLock: vi.fn(),
		loadAllPaths: vi.fn(async () => entries),
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
		getBlob: getBlobMock,
		gcOrphanBlobs: vi.fn(),
		loadSubtreeInodes: vi.fn(),
		bulkIngest: vi.fn(),
		resolvePath: vi.fn(),
	} as unknown as SqlDialect<unknown>;

	const fs = new SqlFs({ dialect, sandboxId: "s1" });
	return { fs, getBlobMock };
}

// ── readFile tests ─────────────────────────────────────────────────────────────

describe("SqlFs.readFile — ENOENT and EISDIR", () => {
	const fileContent = new TextEncoder().encode("hello");
	const filePath = "/file.txt";
	const dirPath = "/mydir";

	let fs: SqlFs;

	beforeEach(async () => {
		const result = makeFs([fileEntry(filePath, 1n), dirEntry(dirPath, 2n)], fileContent);
		fs = result.fs;
		await fs.ready();
	});

	it("reads an existing file and returns decoded string", async () => {
		const content = await fs.readFile(filePath);
		expect(content).toBe("hello");
	});

	it("throws ENOENT when path is not in pathCache", async () => {
		await expect(fs.readFile("/nonexistent.txt")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("throws EISDIR when path resolves to a directory", async () => {
		await expect(fs.readFile(dirPath)).rejects.toMatchObject({ code: "EISDIR" });
	});
});

// ── readFileBuffer tests ───────────────────────────────────────────────────────

describe("SqlFs.readFileBuffer", () => {
	const fileContent = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]);
	const filePath = "/data.bin";
	const dirPath = "/mydir";
	const inodeId = 10n;

	let fs: SqlFs;
	let getBlobMock: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		const result = makeFs([fileEntry(filePath, inodeId), dirEntry(dirPath, 11n)], fileContent);
		fs = result.fs;
		getBlobMock = result.getBlobMock;
		await fs.ready();
	});

	it("returns raw Uint8Array from DB on cache miss", async () => {
		const data = await fs.readFileBuffer(filePath);
		expect(getBlobMock).toHaveBeenCalledOnce();
		expect(data).toEqual(fileContent);
		expect(data).toBeInstanceOf(Uint8Array);
	});

	it("stores fetched content in contentCache after cache miss", async () => {
		expect(fs._contentCacheHas(inodeId)).toBe(false);
		await fs.readFileBuffer(filePath);
		expect(fs._contentCacheHas(inodeId)).toBe(true);
		expect(fs._contentCacheGet(inodeId)).toEqual(fileContent);
	});

	it("returns cached Uint8Array on cache hit without calling getBlob", async () => {
		await fs.readFileBuffer(filePath); // prime cache
		getBlobMock.mockClear();

		const data = await fs.readFileBuffer(filePath);
		expect(getBlobMock).not.toHaveBeenCalled();
		expect(data).toEqual(fileContent);
	});

	it("throws ENOENT when path is not in pathCache", async () => {
		await expect(fs.readFileBuffer("/nonexistent.bin")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("throws EISDIR when path resolves to a directory", async () => {
		await expect(fs.readFileBuffer(dirPath)).rejects.toMatchObject({ code: "EISDIR" });
	});
});

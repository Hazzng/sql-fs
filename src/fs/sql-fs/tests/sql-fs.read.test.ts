/**
 * Unit tests for SqlFs.readFile content cache behaviour.
 * US-023: Content cache hit on readFile
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SqlFs } from "../sql-fs.js";
import type { PathCacheEntry, SqlDialect } from "../types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const now = new Date("2026-01-01T00:00:00Z");

function fileEntry(path: string, inodeId: bigint, contentSha256: Uint8Array): { path: string } & PathCacheEntry {
	return { path, inodeId, kind: 1, mode: 0o644, size: 11, mtime: now, contentSha256, symlinkTarget: null };
}

function makeDialect(getBlobImpl: () => Promise<Uint8Array | null>): {
	dialect: SqlDialect<unknown>;
	getBlobMock: ReturnType<typeof vi.fn>;
} {
	const getBlobMock = vi.fn(getBlobImpl);
	const dialect: SqlDialect<unknown> = {
		connect: vi.fn(),
		disconnect: vi.fn(),
		transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
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
		getBlobNoTx: getBlobMock,
		gcOrphanBlobs: vi.fn(),
		getBlobsForSandbox: vi.fn(async () => []),
		loadSubtreeInodes: vi.fn(),
		bulkIngest: vi.fn(),
		resolvePath: vi.fn(),
	} as unknown as SqlDialect<unknown>;
	return { dialect, getBlobMock };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("SqlFs.readFile — content cache", () => {
	const sha256 = new Uint8Array(32).fill(0xab);
	const fileContent = new TextEncoder().encode("hello world");
	const filePath = "/home/user/hello.txt";
	const inodeId = 5n;

	let getBlobMock: ReturnType<typeof vi.fn>;
	let fs: SqlFs;

	beforeEach(async () => {
		const result = makeDialect(async () => fileContent);
		getBlobMock = result.getBlobMock;

		// Seed loadAllPaths to pre-populate pathCache with one file entry
		(result.dialect.loadAllPaths as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
			fileEntry(filePath, inodeId, sha256),
		]);

		fs = new SqlFs({ dialect: result.dialect, sandboxId: "s1" });
		await fs.ready();
	});

	it("calls getBlob on first read (cache miss)", async () => {
		const content = await fs.readFile(filePath);

		expect(getBlobMock).toHaveBeenCalledOnce();
		expect(content).toBe("hello world");
	});

	it("does NOT call getBlob on second read (cache hit)", async () => {
		await fs.readFile(filePath);
		const content = await fs.readFile(filePath);

		// getBlob called exactly once total (only on the first read)
		expect(getBlobMock).toHaveBeenCalledOnce();
		expect(content).toBe("hello world");
	});

	it("stores fetched content in contentCache after cache miss", async () => {
		expect(fs._contentCacheHas(inodeId)).toBe(false);

		await fs.readFile(filePath);

		expect(fs._contentCacheHas(inodeId)).toBe(true);
		expect(fs._contentCacheGet(inodeId)).toEqual(fileContent);
	});

	it("returns cached content directly on cache hit without DB call", async () => {
		// Pre-populate cache manually (simulates a prior write that stored content)
		const cachedBytes = new TextEncoder().encode("cached content");
		fs._contentCacheSet(inodeId, cachedBytes);

		const content = await fs.readFile(filePath);

		expect(getBlobMock).not.toHaveBeenCalled();
		expect(content).toBe("cached content");
	});
});

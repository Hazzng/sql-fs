/**
 * Unit tests verifying that SqlFs.bulkIngest seeds #contentCache with the
 * bytes it already holds in memory, so the next readFileBuffer is a cache hit
 * with zero dialect calls.
 *
 * Acceptance criteria: §4 of IMPLEMENT-issue-38-pr2-bulkingest-cache-seed.md
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SqlFs } from "./sql-fs.js";
import type { PathCacheEntry, SqlDialect } from "./types.js";

const now = new Date("2026-01-01T00:00:00Z");

function dirEntry(path: string, inodeId: bigint): { path: string } & PathCacheEntry {
	return { path, inodeId, kind: 2, mode: 0o755, size: 0, mtime: now, contentSha256: null, symlinkTarget: null };
}

function fileEntry(inodeId: bigint, size: number): PathCacheEntry {
	const sha = new Uint8Array(32).fill(0xcd);
	return { inodeId, kind: 1, mode: 0o644, size, mtime: now, contentSha256: sha, symlinkTarget: null };
}

function makeDialect(): {
	dialect: SqlDialect<unknown>;
	transactionMock: ReturnType<typeof vi.fn>;
	bulkIngestMock: ReturnType<typeof vi.fn>;
	getBlobMock: ReturnType<typeof vi.fn>;
	getBlobNoTxMock: ReturnType<typeof vi.fn>;
	loadAllPathsMock: ReturnType<typeof vi.fn>;
} {
	const transactionMock = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({}));
	const bulkIngestMock = vi.fn(async () => new Map<string, PathCacheEntry>());
	const getBlobMock = vi.fn(async () => new Uint8Array(0));
	const getBlobNoTxMock = vi.fn(async () => new Uint8Array(0));
	const loadAllPathsMock = vi.fn(async () => [] as Array<{ path: string } & PathCacheEntry>);
	const dialect: SqlDialect<unknown> = {
		connect: vi.fn(),
		disconnect: vi.fn(),
		transaction: transactionMock,
		setSandboxContext: vi.fn(),
		setSandboxContextWithLock: vi.fn(),
		loadAllPaths: loadAllPathsMock,
		createSandbox: vi.fn(),
		deleteSandbox: vi.fn(),
		sandboxExists: vi.fn(),
		getSandboxMeta: vi.fn(),
		updateSandboxMeta: vi.fn(),
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
		getBlobNoTx: getBlobNoTxMock,
		gcOrphanBlobs: vi.fn(),
		getBlobsForSandbox: vi.fn(async () => []),
		loadSubtreeInodes: vi.fn(),
		bulkIngest: bulkIngestMock,
		resolvePath: vi.fn(),
	} as unknown as SqlDialect<unknown>;
	return { dialect, transactionMock, bulkIngestMock, getBlobMock, getBlobNoTxMock, loadAllPathsMock };
}

describe("SqlFs.bulkIngest — content cache seeding (AC 1–6)", () => {
	let fs: SqlFs;
	let transactionMock: ReturnType<typeof vi.fn>;
	let bulkIngestMock: ReturnType<typeof vi.fn>;
	let getBlobMock: ReturnType<typeof vi.fn>;
	let getBlobNoTxMock: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		const m = makeDialect();
		transactionMock = m.transactionMock;
		bulkIngestMock = m.bulkIngestMock;
		getBlobMock = m.getBlobMock;
		getBlobNoTxMock = m.getBlobNoTxMock;
		m.loadAllPathsMock.mockResolvedValueOnce([dirEntry("/", 1n)]);
		fs = new SqlFs({ dialect: m.dialect, sandboxId: "s1" });
		await fs.ready();
	});

	it("AC1 — populates contentCache for newly-ingested files", async () => {
		const content = new TextEncoder().encode("hello world");
		bulkIngestMock.mockResolvedValueOnce(new Map([["/a.txt", fileEntry(2n, content.byteLength)]]));

		await fs.bulkIngest([{ path: "/a.txt", content, mode: 0o644 }]);

		// readFileBuffer should serve from cache (no getBlobNoTx call)
		const result = await fs.readFileBuffer("/a.txt");
		expect(getBlobNoTxMock).not.toHaveBeenCalled();
		expect(result).toBe(content);
	});

	it("AC2 — readFileBuffer after bulkIngest issues zero dialect calls", async () => {
		const content = new TextEncoder().encode("cached bytes");
		bulkIngestMock.mockResolvedValueOnce(new Map([["/b.txt", fileEntry(3n, content.byteLength)]]));

		await fs.bulkIngest([{ path: "/b.txt", content, mode: 0o644 }]);

		const txCountAfterIngest = transactionMock.mock.calls.length;
		const result = await fs.readFileBuffer("/b.txt");

		expect(result).toBe(content);
		expect(transactionMock.mock.calls.length).toBe(txCountAfterIngest);
		expect(getBlobMock).not.toHaveBeenCalled();
	});

	it("AC3 — empty files are not cached (readFileBuffer falls through to DB)", async () => {
		const empty = new Uint8Array(0);
		bulkIngestMock.mockResolvedValueOnce(new Map([["/empty.txt", fileEntry(4n, 0)]]));

		await fs.bulkIngest([{ path: "/empty.txt", content: empty, mode: 0o644 }]);

		// Empty file not seeded in cache — readFileBuffer must call getBlobNoTx
		await fs.readFileBuffer("/empty.txt");
		expect(getBlobNoTxMock).toHaveBeenCalledOnce();
	});

	it("AC4 — replacement: old inode evicted, new inode populated", async () => {
		const bytesA = new TextEncoder().encode("version A");
		const bytesB = new TextEncoder().encode("version B");

		// First ingest: /x.txt → inode 10n (seeded in cache)
		bulkIngestMock.mockResolvedValueOnce(new Map([["/x.txt", fileEntry(10n, bytesA.byteLength)]]));
		await fs.bulkIngest([{ path: "/x.txt", content: bytesA, mode: 0o644 }]);

		// Second ingest: /x.txt → inode 11n (evicts 10n, seeds 11n)
		bulkIngestMock.mockResolvedValueOnce(new Map([["/x.txt", fileEntry(11n, bytesB.byteLength)]]));
		await fs.bulkIngest([{ path: "/x.txt", content: bytesB, mode: 0o644 }]);

		// Reading must return bytesB from cache (no getBlobNoTx) — proves 11n is seeded
		const result = await fs.readFileBuffer("/x.txt");
		expect(getBlobNoTxMock).not.toHaveBeenCalled();
		expect(result).toBe(bytesB);
	});

	it("AC5 — two paths sharing identical bytes each get their own cache entry", async () => {
		const shared = new TextEncoder().encode("same content");

		bulkIngestMock.mockResolvedValueOnce(
			new Map([
				["/p1.txt", fileEntry(20n, shared.byteLength)],
				["/p2.txt", fileEntry(21n, shared.byteLength)],
			]),
		);

		await fs.bulkIngest([
			{ path: "/p1.txt", content: shared, mode: 0o644 },
			{ path: "/p2.txt", content: shared, mode: 0o644 },
		]);

		// Both paths served from cache — no getBlobNoTx calls
		const r1 = await fs.readFileBuffer("/p1.txt");
		const r2 = await fs.readFileBuffer("/p2.txt");
		expect(getBlobNoTxMock).not.toHaveBeenCalled();
		expect(r1).toBe(shared);
		expect(r2).toBe(shared);
	});

	it("AC6 — empty input is a no-op, cache untouched", async () => {
		const sizeBefore = [...fs._getPathCache().keys()].length;

		await fs.bulkIngest([]);

		expect(bulkIngestMock).not.toHaveBeenCalled();
		expect([...fs._getPathCache().keys()].length).toBe(sizeBefore);
		expect(fs.wasDirty()).toBe(false);
	});
});

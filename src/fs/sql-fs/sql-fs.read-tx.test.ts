/**
 * Unit tests verifying the read path uses getBlobNoTx (no transaction wrapper).
 * Acceptance criteria 1–5 from IMPLEMENT-issue-38-pr1-getblob-no-tx.md §4.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SqlFs } from "./sql-fs.js";
import type { PathCacheEntry, SqlDialect } from "./types.js";

const now = new Date("2026-01-01T00:00:00Z");
const sha256 = new Uint8Array(32).fill(0xab);
const blobBytes = new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]); // "hello"

function fileEntry(path: string, inodeId: bigint): { path: string } & PathCacheEntry {
	return { path, inodeId, kind: 1, mode: 0o644, size: 5, mtime: now, contentSha256: sha256, symlinkTarget: null };
}

function makeDialect(getBlobNoTxImpl: () => Promise<Uint8Array | null>): {
	dialect: SqlDialect<unknown>;
	transactionSpy: ReturnType<typeof vi.fn>;
	setSandboxContextSpy: ReturnType<typeof vi.fn>;
	getBlobNoTxSpy: ReturnType<typeof vi.fn>;
	getBlobSpy: ReturnType<typeof vi.fn>;
} {
	const transactionSpy = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({}));
	const setSandboxContextSpy = vi.fn();
	const getBlobNoTxSpy = vi.fn(getBlobNoTxImpl);
	const getBlobSpy = vi.fn();

	const dialect = {
		connect: vi.fn(),
		disconnect: vi.fn(),
		transaction: transactionSpy,
		setSandboxContext: setSandboxContextSpy,
		setSandboxContextWithLock: vi.fn(),
		loadAllPaths: vi.fn(async () => [fileEntry("/file.txt", 1n)]),
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
		getBlob: getBlobSpy,
		getBlobNoTx: getBlobNoTxSpy,
		gcOrphanBlobs: vi.fn(),
		loadSubtreeInodes: vi.fn(),
		bulkIngest: vi.fn(),
		resolvePath: vi.fn(),
	} as unknown as SqlDialect<unknown>;

	return { dialect, transactionSpy, setSandboxContextSpy, getBlobNoTxSpy, getBlobSpy };
}

// AC1 + AC2: cache-miss readFile calls getBlobNoTx, not getBlob; transaction never invoked
describe("readFile cache-miss", () => {
	let fs: SqlFs;
	let transactionSpy: ReturnType<typeof vi.fn>;
	let setSandboxContextSpy: ReturnType<typeof vi.fn>;
	let getBlobNoTxSpy: ReturnType<typeof vi.fn>;
	let getBlobSpy: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		const mocks = makeDialect(async () => blobBytes);
		transactionSpy = mocks.transactionSpy;
		setSandboxContextSpy = mocks.setSandboxContextSpy;
		getBlobNoTxSpy = mocks.getBlobNoTxSpy;
		getBlobSpy = mocks.getBlobSpy;
		fs = new SqlFs({ dialect: mocks.dialect, sandboxId: "s1" });
		await fs.ready();
		// ready() calls loadAllPaths inside a transaction — reset spies after setup
		transactionSpy.mockClear();
		setSandboxContextSpy.mockClear();
	});

	it("calls getBlobNoTx exactly once on cache miss (AC1)", async () => {
		await fs.readFile("/file.txt");
		expect(getBlobNoTxSpy).toHaveBeenCalledOnce();
		expect(getBlobNoTxSpy).toHaveBeenCalledWith(sha256);
	});

	it("does not call transaction or setSandboxContext on read miss (AC1)", async () => {
		await fs.readFile("/file.txt");
		expect(transactionSpy).not.toHaveBeenCalled();
		expect(setSandboxContextSpy).not.toHaveBeenCalled();
	});

	it("does not call getBlob on read miss (AC1)", async () => {
		await fs.readFile("/file.txt");
		expect(getBlobSpy).not.toHaveBeenCalled();
	});

	it("returns bytes identical to what getBlobNoTx provided (AC2)", async () => {
		const content = await fs.readFile("/file.txt");
		expect(content).toBe("hello");
	});
});

// AC1 + AC2: cache-miss readFileBuffer
describe("readFileBuffer cache-miss", () => {
	let fs: SqlFs;
	let transactionSpy: ReturnType<typeof vi.fn>;
	let getBlobNoTxSpy: ReturnType<typeof vi.fn>;
	let getBlobSpy: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		const mocks = makeDialect(async () => blobBytes);
		transactionSpy = mocks.transactionSpy;
		getBlobNoTxSpy = mocks.getBlobNoTxSpy;
		getBlobSpy = mocks.getBlobSpy;
		fs = new SqlFs({ dialect: mocks.dialect, sandboxId: "s1" });
		await fs.ready();
		transactionSpy.mockClear();
	});

	it("calls getBlobNoTx exactly once on cache miss (AC1)", async () => {
		await fs.readFileBuffer("/file.txt");
		expect(getBlobNoTxSpy).toHaveBeenCalledOnce();
		expect(getBlobNoTxSpy).toHaveBeenCalledWith(sha256);
	});

	it("does not open a transaction on read miss (AC1)", async () => {
		await fs.readFileBuffer("/file.txt");
		expect(transactionSpy).not.toHaveBeenCalled();
	});

	it("does not call getBlob on read miss (AC1)", async () => {
		await fs.readFileBuffer("/file.txt");
		expect(getBlobSpy).not.toHaveBeenCalled();
	});

	it("returns bytes identical to what getBlobNoTx provided (AC2)", async () => {
		const data = await fs.readFileBuffer("/file.txt");
		expect(data).toEqual(blobBytes);
	});
});

// AC2: getBlobNoTx returning null → readFile returns '' / readFileBuffer returns empty
describe("getBlobNoTx returns null", () => {
	let fs: SqlFs;

	beforeEach(async () => {
		const mocks = makeDialect(async () => null);
		fs = new SqlFs({ dialect: mocks.dialect, sandboxId: "s1" });
		await fs.ready();
	});

	it("readFile returns empty string when blob is missing (AC2)", async () => {
		const content = await fs.readFile("/file.txt");
		expect(content).toBe("");
	});

	it("readFileBuffer returns empty Uint8Array when blob is missing (AC2)", async () => {
		const data = await fs.readFileBuffer("/file.txt");
		expect(data).toEqual(new Uint8Array(0));
	});
});

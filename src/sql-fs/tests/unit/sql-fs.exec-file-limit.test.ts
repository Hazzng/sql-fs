/**
 * #168: the per-file ceiling on what a sandbox `exec` script may read whole or produce.
 *
 * The cap is scoped to `execContext`, so every test here has a counterpart that runs the
 * identical oversized call *outside* the context and asserts it still succeeds — without
 * those, a cap accidentally applied to every caller (which would break the HTTP file
 * routes) would pass the suite.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { execContext } from "../../../api/exec-context.js";
import { SqlFs } from "../../sql-fs.js";
import type { PathCacheEntry, SqlDialect } from "../../types.js";

const now = new Date("2026-01-01T00:00:00Z");
const LIMIT = 1024;

function dirEntry(path: string, inodeId: bigint): { path: string } & PathCacheEntry {
	return { path, inodeId, kind: 2, mode: 0o755, size: 0, mtime: now, contentSha256: null, symlinkTarget: null };
}

function fileEntry(path: string, inodeId: bigint, size: number): { path: string } & PathCacheEntry {
	return {
		path,
		inodeId,
		kind: 1,
		mode: 0o644,
		size,
		mtime: now,
		contentSha256: new Uint8Array(32).fill(0xcd),
		symlinkTarget: null,
	};
}

function makeFs(entries: Array<{ path: string } & PathCacheEntry>): {
	fs: SqlFs;
	getBlobNoTxMock: ReturnType<typeof vi.fn>;
	getBlobMock: ReturnType<typeof vi.fn>;
	upsertBlobMock: ReturnType<typeof vi.fn>;
	createInodeMock: ReturnType<typeof vi.fn>;
} {
	const getBlobNoTxMock = vi.fn(async () => new Uint8Array(0));
	const getBlobMock = vi.fn(async () => new Uint8Array(0));
	const upsertBlobMock = vi.fn(async () => undefined);
	const createInodeMock = vi.fn(async () => 99n);

	const dialect: SqlDialect<unknown> = {
		connect: vi.fn(),
		disconnect: vi.fn(),
		transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
		setSandboxContext: vi.fn(),
		getSandboxEpoch: vi.fn(async () => 0n),
		setSandboxContextWithLock: vi.fn(),
		loadAllPaths: vi.fn(async () => entries),
		createSandbox: vi.fn(),
		deleteSandbox: vi.fn(),
		createInode: createInodeMock,
		getInode: vi.fn(),
		updateInode: vi.fn(),
		deleteInode: vi.fn(),
		incrementNlink: vi.fn(),
		decrementNlink: vi.fn(async () => 0),
		insertDirent: vi.fn(),
		upsertDirent: vi.fn(async () => null as bigint | null),
		deleteDirent: vi.fn(),
		listDirents: vi.fn(),
		moveDirent: vi.fn(),
		upsertBlob: upsertBlobMock,
		getBlob: getBlobMock,
		getBlobNoTx: getBlobNoTxMock,
		gcOrphanBlobs: vi.fn(),
		getBlobsForSandbox: vi.fn(async () => []),
		loadSubtreeInodes: vi.fn(),
		bulkIngest: vi.fn(),
		resolvePath: vi.fn(),
	} as unknown as SqlDialect<unknown>;

	return { fs: new SqlFs({ dialect, sandboxId: "s1" }), getBlobNoTxMock, getBlobMock, upsertBlobMock, createInodeMock };
}

function inExec<T>(fn: () => Promise<T>): Promise<T> {
	return execContext.run({ maxFileBytes: LIMIT }, fn);
}

describe("SqlFs exec file-size ceiling — reads", () => {
	let fs: SqlFs;
	let getBlobNoTxMock: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		const made = makeFs([dirEntry("/", 1n), fileEntry("/big.txt", 2n, LIMIT + 1), fileEntry("/exact.txt", 3n, LIMIT)]);
		fs = made.fs;
		getBlobNoTxMock = made.getBlobNoTxMock;
		await fs.ready();
	});

	it("rejects readFile of an over-cap file with EFBIG", async () => {
		await expect(inExec(() => fs.readFile("/big.txt"))).rejects.toMatchObject({ code: "EFBIG" });
	});

	it("rejects readFileBuffer of an over-cap file with EFBIG", async () => {
		await expect(inExec(() => fs.readFileBuffer("/big.txt"))).rejects.toMatchObject({ code: "EFBIG" });
	});

	it("does not fetch the blob for an over-cap read", async () => {
		await expect(inExec(() => fs.readFileBuffer("/big.txt"))).rejects.toThrow();

		expect(getBlobNoTxMock).not.toHaveBeenCalled();
	});

	it("allows a read of exactly the cap", async () => {
		await expect(inExec(() => fs.readFileBuffer("/exact.txt"))).resolves.toEqual(new Uint8Array(0));
	});

	// Negative guard: the cap must apply ONLY to script-issued calls. The HTTP GET /files
	// route and MCP fs_export call this same method with no execContext, and a 50 MiB file
	// written through PUT has to remain downloadable.
	it("allows an over-cap read outside exec scope", async () => {
		await expect(fs.readFileBuffer("/big.txt")).resolves.toEqual(new Uint8Array(0));
		expect(getBlobNoTxMock).toHaveBeenCalledTimes(1);
	});
});

describe("SqlFs exec file-size ceiling — writes", () => {
	let fs: SqlFs;
	let upsertBlobMock: ReturnType<typeof vi.fn>;
	let getBlobMock: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		const made = makeFs([dirEntry("/", 1n), fileEntry("/grown.txt", 2n, LIMIT - 4)]);
		fs = made.fs;
		upsertBlobMock = made.upsertBlobMock;
		getBlobMock = made.getBlobMock;
		await fs.ready();
	});

	it("rejects writeFile of over-cap content with EFBIG", async () => {
		const content = new Uint8Array(LIMIT + 1);

		await expect(inExec(() => fs.writeFile("/out.bin", content))).rejects.toMatchObject({ code: "EFBIG" });
	});

	it("writes nothing when writeFile trips the cap", async () => {
		await expect(inExec(() => fs.writeFile("/out.bin", new Uint8Array(LIMIT + 1)))).rejects.toThrow();

		expect(upsertBlobMock).not.toHaveBeenCalled();
		expect(fs.getAllPaths()).not.toContain("/out.bin");
	});

	it("allows writeFile of exactly the cap", async () => {
		await expect(inExec(() => fs.writeFile("/out.bin", new Uint8Array(LIMIT)))).resolves.toBeUndefined();
	});

	// Negative guard: PUT/PATCH/writeFiles reach writeFile with their own (much looser)
	// caps already enforced upstream, and must not inherit this one.
	it("allows an over-cap writeFile outside exec scope", async () => {
		await expect(fs.writeFile("/out.bin", new Uint8Array(LIMIT + 1))).resolves.toBeUndefined();
		expect(fs.getAllPaths()).toContain("/out.bin");
	});

	it("rejects an append whose RESULT crosses the cap, counting the existing bytes", async () => {
		// 1020 existing + 8 appended = 1028 > 1024, though the appended chunk alone is tiny.
		await expect(inExec(() => fs.appendFile("/grown.txt", new Uint8Array(8)))).rejects.toMatchObject({
			code: "EFBIG",
		});
	});

	it("does not read the base blob for an over-cap append", async () => {
		await expect(inExec(() => fs.appendFile("/grown.txt", new Uint8Array(8)))).rejects.toThrow();

		expect(getBlobMock).not.toHaveBeenCalled();
	});

	it("allows an append whose result stays at the cap", async () => {
		await expect(inExec(() => fs.appendFile("/grown.txt", new Uint8Array(4)))).resolves.toBeUndefined();
		expect(getBlobMock).toHaveBeenCalledTimes(1);
	});

	// Negative guard for the append path specifically — the resulting-size arithmetic must
	// not leak out of exec scope onto the PATCH edit path, which rewrites whole files.
	it("allows an over-cap append outside exec scope", async () => {
		await expect(fs.appendFile("/grown.txt", new Uint8Array(8))).resolves.toBeUndefined();
	});
});

describe("SqlFs exec file-size ceiling — context tagging", () => {
	let fs: SqlFs;

	beforeEach(async () => {
		const made = makeFs([dirEntry("/", 1n), fileEntry("/a.txt", 2n, LIMIT + 1), fileEntry("/b.txt", 3n, LIMIT + 2)]);
		fs = made.fs;
		await fs.ready();
	});

	// The throw alone is not enough: bash swallows a read rejection into a phantom ENOENT, so
	// `execWithRuntimeThrottle` re-throws what is recorded here. A cap that only threw would
	// leave every `cat`/`wc`/`grep` reporting a file that plainly exists as missing.
	it("records the error on the exec context as well as throwing it", async () => {
		const ctx = { maxFileBytes: LIMIT } as { maxFileBytes: number; exceeded?: Error };

		await expect(execContext.run(ctx, () => fs.readFileBuffer("/a.txt"))).rejects.toThrow();

		expect((ctx.exceeded as Error & { code: string }).code).toBe("EFBIG");
		expect(ctx.exceeded?.message).toContain("'/a.txt'");
	});

	it("keeps the first trip when a script trips the cap twice", async () => {
		const ctx = { maxFileBytes: LIMIT } as { maxFileBytes: number; exceeded?: Error };

		await execContext.run(ctx, async () => {
			await fs.readFileBuffer("/a.txt").catch(() => {});
			await fs.readFileBuffer("/b.txt").catch(() => {});
		});

		expect(ctx.exceeded?.message).toContain("'/a.txt'");
		expect(ctx.exceeded?.message).not.toContain("'/b.txt'");
	});

	it("leaves the context untouched when the call stays under the cap", async () => {
		const ctx = { maxFileBytes: LIMIT } as { maxFileBytes: number; exceeded?: Error };
		const made = makeFs([dirEntry("/", 1n), fileEntry("/ok.txt", 4n, 8)]);
		await made.fs.ready();

		await execContext.run(ctx, () => made.fs.readFileBuffer("/ok.txt"));

		expect(ctx.exceeded).toBeUndefined();
	});
});

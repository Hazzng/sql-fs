/**
 * Unit tests for SqlFs background content-cache prewarm (PR 3).
 * ACs covered: 1, 3, 4, 7, 8.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqlFs } from "./sql-fs.js";
import type { PathCacheEntry, SqlDialect } from "./types.js";
import { INODE_KIND } from "./types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const now = new Date("2026-01-01T00:00:00Z");

function sha(byte: number): Uint8Array {
	return new Uint8Array(32).fill(byte);
}

function makeBytes(size: number, fill = 0xab): Uint8Array {
	return new Uint8Array(size).fill(fill);
}

function fileEntry(path: string, inodeId: bigint, size = 10): { path: string } & PathCacheEntry {
	return {
		path,
		inodeId,
		kind: INODE_KIND.FILE,
		mode: 0o644,
		size,
		mtime: now,
		contentSha256: sha(Number(inodeId)),
		symlinkTarget: null,
	};
}

interface MakeDialectOpts {
	prewarmGate?: Promise<void>;
	prewarmResult?: Array<{ inodeId: bigint; sha256: Uint8Array; data: Uint8Array }>;
	prewarmThrows?: boolean;
	blobData?: Uint8Array;
}

/**
 * Returns a dialect stub plus `waitForPrewarm()` — a function that resolves
 * when the most recently started prewarm task settles (fulfilled or rejected).
 * This avoids adding any @internal accessor to SqlFs.
 */
function makeDialect(opts: MakeDialectOpts = {}): {
	dialect: SqlDialect<unknown>;
	getBlobsForSandboxMock: ReturnType<typeof vi.fn>;
	getBlobNoTxMock: ReturnType<typeof vi.fn>;
	waitForPrewarm: () => Promise<void>;
} {
	let lastSettled: Promise<void> = Promise.resolve();

	const getBlobsForSandboxMock = vi.fn(() => {
		const p = (async () => {
			if (opts.prewarmGate) await opts.prewarmGate;
			if (opts.prewarmThrows) throw new Error("prewarm dialect failure");
			return opts.prewarmResult ?? [];
		})();
		// Track settlement without suppressing the rejection seen by SqlFs
		lastSettled = p.then(
			() => {},
			() => {},
		);
		return p;
	});

	const getBlobNoTxMock = vi.fn(async () => opts.blobData ?? new Uint8Array([0x01]));

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
		getBlobNoTx: getBlobNoTxMock,
		getBlobsForSandbox: getBlobsForSandboxMock,
		gcOrphanBlobs: vi.fn(),
		loadSubtreeInodes: vi.fn(),
		bulkIngest: vi.fn(),
		resolvePath: vi.fn(),
		sandboxExists: vi.fn(),
		listSandboxes: vi.fn(),
		getSandboxMeta: vi.fn(),
	} as unknown as SqlDialect<unknown>;

	return {
		dialect,
		getBlobsForSandboxMock,
		getBlobNoTxMock,
		waitForPrewarm: () => lastSettled,
	};
}

// ── AC1: ready() returns before prewarm completes ─────────────────────────────

describe("SqlFs.ready() — returns before prewarm completes (AC1)", () => {
	it("resolves while getBlobsForSandbox is still pending", async () => {
		let resolveGate!: () => void;
		const gate = new Promise<void>((r) => {
			resolveGate = r;
		});
		const { dialect, getBlobsForSandboxMock, waitForPrewarm } = makeDialect({ prewarmGate: gate });
		const fs = new SqlFs({ dialect, sandboxId: "s1" });

		// ready() must resolve without waiting for the blocked prewarm
		await expect(fs.ready()).resolves.toBeUndefined();
		// getBlobsForSandbox was called but hasn't returned yet
		expect(getBlobsForSandboxMock).toHaveBeenCalledOnce();

		resolveGate();
		await waitForPrewarm();
	});

	it("prewarm completes and populates cache after ready() returns", async () => {
		const data = makeBytes(8);
		const prewarmResult = [{ inodeId: 1n, sha256: sha(1), data }];
		const { dialect, waitForPrewarm } = makeDialect({ prewarmResult });
		const fs = new SqlFs({ dialect, sandboxId: "s1" });

		await fs.ready();
		await waitForPrewarm();

		expect(fs._contentCacheHas(1n)).toBe(true);
	});
});

// ── AC3: byte cap respected ───────────────────────────────────────────────────

describe("SqlFs prewarm — byte cap respected (AC3)", () => {
	it("populates only entries returned by getBlobsForSandbox into contentCache", async () => {
		const entries = [
			{ inodeId: 1n, sha256: sha(1), data: makeBytes(10) },
			{ inodeId: 2n, sha256: sha(2), data: makeBytes(10) },
			{ inodeId: 3n, sha256: sha(3), data: makeBytes(10) },
		];
		const { dialect, waitForPrewarm } = makeDialect({ prewarmResult: entries });
		const fs = new SqlFs({ dialect, sandboxId: "s1" });

		await fs.ready();
		await waitForPrewarm();

		expect(fs._contentCacheHas(1n)).toBe(true);
		expect(fs._contentCacheHas(2n)).toBe(true);
		expect(fs._contentCacheHas(3n)).toBe(true);
		expect(fs._contentCacheHas(4n)).toBe(false);
	});

	it("skips zero-byte entries from getBlobsForSandbox", async () => {
		const entries = [
			{ inodeId: 1n, sha256: sha(1), data: new Uint8Array(0) },
			{ inodeId: 2n, sha256: sha(2), data: makeBytes(5) },
		];
		const { dialect, waitForPrewarm } = makeDialect({ prewarmResult: entries });
		const fs = new SqlFs({ dialect, sandboxId: "s1" });

		await fs.ready();
		await waitForPrewarm();

		expect(fs._contentCacheHas(1n)).toBe(false);
		expect(fs._contentCacheHas(2n)).toBe(true);
	});
});

// ── AC4: prewarm failure is non-fatal ─────────────────────────────────────────

describe("SqlFs prewarm — non-fatal on dialect error (AC4)", () => {
	let errSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		errSpy.mockRestore();
	});

	it("ready() resolves even when getBlobsForSandbox throws", async () => {
		const { dialect } = makeDialect({ prewarmThrows: true });
		const fs = new SqlFs({ dialect, sandboxId: "s1" });
		await expect(fs.ready()).resolves.toBeUndefined();
	});

	it("logs a content_prewarm_error JSON line on failure", async () => {
		const { dialect, waitForPrewarm } = makeDialect({ prewarmThrows: true });
		const fs = new SqlFs({ dialect, sandboxId: "s1" });
		await fs.ready();
		await waitForPrewarm();

		expect(errSpy).toHaveBeenCalled();
		const call = errSpy.mock.calls[0]?.[0] as string;
		expect(JSON.parse(call).event).toBe("content_prewarm_error");
	});

	it("falls through to getBlobNoTx when prewarm failed", async () => {
		const blobData = new Uint8Array([0xde, 0xad]);
		const { dialect, getBlobNoTxMock, waitForPrewarm } = makeDialect({ prewarmThrows: true, blobData });
		(dialect.loadAllPaths as ReturnType<typeof vi.fn>).mockResolvedValue([fileEntry("/file.txt", 1n)]);

		const fs = new SqlFs({ dialect, sandboxId: "s1" });
		await fs.ready();
		await waitForPrewarm();
		await Promise.resolve(); // flush any trailing microtasks

		const result = await fs.readFileBuffer("/file.txt");
		expect(result).toEqual(blobData);
		expect(getBlobNoTxMock).toHaveBeenCalledOnce();
	});
});

// ── AC7: concurrent reads coalesce onto one prewarm ───────────────────────────

describe("SqlFs prewarm — concurrent reads coalesce (AC7)", () => {
	it("awaits in-flight prewarm and reads from cache without calling getBlobNoTx", async () => {
		let resolveGate!: () => void;
		const gate = new Promise<void>((r) => {
			resolveGate = r;
		});

		const fileData = makeBytes(8, 0xab);
		const prewarmResult = [{ inodeId: 1n, sha256: sha(1), data: fileData }];
		const { dialect, getBlobNoTxMock } = makeDialect({
			prewarmGate: gate,
			prewarmResult,
			blobData: fileData,
		});
		(dialect.loadAllPaths as ReturnType<typeof vi.fn>).mockResolvedValue([fileEntry("/file.txt", 1n)]);

		const fs = new SqlFs({ dialect, sandboxId: "s1" });
		await fs.ready(); // prewarm starts, blocked on gate

		const reads = Array.from({ length: 5 }, () => fs.readFileBuffer("/file.txt"));

		resolveGate();
		const results = await Promise.all(reads);

		for (const r of results) {
			expect(r).toEqual(fileData);
		}
		expect(getBlobNoTxMock).not.toHaveBeenCalled();
	});

	it("falls through to getBlobNoTx for files not covered by prewarm cap", async () => {
		const fileData1 = makeBytes(5, 0x11);
		const fileData2 = makeBytes(5, 0x22);
		const prewarmResult = [{ inodeId: 1n, sha256: sha(1), data: fileData1 }];

		const { dialect, getBlobNoTxMock, waitForPrewarm } = makeDialect({
			prewarmResult,
			blobData: fileData2,
		});
		(dialect.loadAllPaths as ReturnType<typeof vi.fn>).mockResolvedValue([
			fileEntry("/f1.txt", 1n),
			fileEntry("/f2.txt", 2n),
		]);

		const fs = new SqlFs({ dialect, sandboxId: "s1" });
		await fs.ready();
		await waitForPrewarm();

		expect(await fs.readFileBuffer("/f1.txt")).toEqual(fileData1);
		expect(getBlobNoTxMock).not.toHaveBeenCalled();

		expect(await fs.readFileBuffer("/f2.txt")).toEqual(fileData2);
		expect(getBlobNoTxMock).toHaveBeenCalledOnce();
	});
});

// ── AC8: reload() re-prewarms ─────────────────────────────────────────────────

describe("SqlFs.reload() — retriggers prewarm (AC8)", () => {
	it("starts a new prewarm after reload clears contentCache", async () => {
		const fileData = makeBytes(8, 0xcc);
		const prewarmResult = [{ inodeId: 1n, sha256: sha(1), data: fileData }];
		const { dialect, getBlobsForSandboxMock, waitForPrewarm } = makeDialect({ prewarmResult });
		(dialect.loadAllPaths as ReturnType<typeof vi.fn>).mockResolvedValue([fileEntry("/file.txt", 1n)]);

		const fs = new SqlFs({ dialect, sandboxId: "s1" });
		await fs.ready();
		await waitForPrewarm();
		expect(getBlobsForSandboxMock).toHaveBeenCalledTimes(1);
		expect(fs._contentCacheHas(1n)).toBe(true);

		await fs.reload();
		await waitForPrewarm();
		expect(getBlobsForSandboxMock).toHaveBeenCalledTimes(2);
		expect(fs._contentCacheHas(1n)).toBe(true);
	});

	it("queues a follow-up prewarm when reload runs during an in-flight prewarm", async () => {
		let resolveGate!: () => void;
		const gate = new Promise<void>((r) => {
			resolveGate = r;
		});
		const fileData = makeBytes(8, 0xdd);
		const prewarmResult = [{ inodeId: 1n, sha256: sha(1), data: fileData }];
		const { dialect, getBlobsForSandboxMock, waitForPrewarm } = makeDialect({ prewarmGate: gate, prewarmResult });
		(dialect.loadAllPaths as ReturnType<typeof vi.fn>).mockResolvedValue([fileEntry("/file.txt", 1n)]);

		const fs = new SqlFs({ dialect, sandboxId: "s1" });
		await fs.ready();
		expect(getBlobsForSandboxMock).toHaveBeenCalledTimes(1);

		await fs.reload();
		expect(getBlobsForSandboxMock).toHaveBeenCalledTimes(1);

		resolveGate();
		await vi.waitFor(() => {
			expect(getBlobsForSandboxMock).toHaveBeenCalledTimes(2);
		});
		await waitForPrewarm();
		expect(fs._contentCacheHas(1n)).toBe(true);
	});
});

// ── Single-flight guard ───────────────────────────────────────────────────────

describe("SqlFs prewarm — single-flight guard", () => {
	it("does not start a second prewarm while one is already in flight", async () => {
		let resolveGate!: () => void;
		const gate = new Promise<void>((r) => {
			resolveGate = r;
		});
		const { dialect, getBlobsForSandboxMock, waitForPrewarm } = makeDialect({ prewarmGate: gate });
		const fs = new SqlFs({ dialect, sandboxId: "s1" });

		await fs.ready(); // starts prewarm, blocked on gate
		expect(getBlobsForSandboxMock).toHaveBeenCalledTimes(1);

		resolveGate();
		await waitForPrewarm();
		expect(getBlobsForSandboxMock).toHaveBeenCalledTimes(1);
	});
});

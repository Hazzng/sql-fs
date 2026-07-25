import { beforeEach, describe, expect, it, vi } from "vitest";
import { SqlFs } from "../sql-fs.js";
import type { PathCacheEntry, SqlDialect } from "../types.js";

const now = new Date("2026-01-01T00:00:00Z");

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
		contentSha256: new Uint8Array(32),
		symlinkTarget: null,
	};
}

function makeDialect(): {
	dialect: SqlDialect<unknown>;
	setSandboxContextWithLockMock: ReturnType<typeof vi.fn>;
	writeFileCompositeMock: ReturnType<typeof vi.fn>;
	mkdirCompositeMock: ReturnType<typeof vi.fn>;
	rmCompositeMock: ReturnType<typeof vi.fn>;
	mvCompositeMock: ReturnType<typeof vi.fn>;
	createInodeMock: ReturnType<typeof vi.fn>;
	upsertBlobMock: ReturnType<typeof vi.fn>;
	upsertDirentMock: ReturnType<typeof vi.fn>;
	insertDirentMock: ReturnType<typeof vi.fn>;
	deleteDirentMock: ReturnType<typeof vi.fn>;
	decrementNlinkMock: ReturnType<typeof vi.fn>;
	deleteInodeMock: ReturnType<typeof vi.fn>;
	moveDirentMock: ReturnType<typeof vi.fn>;
	getBlobMock: ReturnType<typeof vi.fn>;
	getSandboxVersionMock: ReturnType<typeof vi.fn>;
	bulkIngestMock: ReturnType<typeof vi.fn>;
} {
	const setSandboxContextWithLockMock = vi.fn();
	const getSandboxVersionMock = vi.fn(async () => 40n);
	const bulkIngestMock = vi.fn(async () => new Map<string, PathCacheEntry>());
	const writeFileCompositeMock = vi.fn(async () => 10n);
	const mkdirCompositeMock = vi.fn(async () => 10n);
	const rmCompositeMock = vi.fn(async () => 10n);
	const mvCompositeMock = vi.fn(async () => undefined);
	const createInodeMock = vi.fn(async () => 10n);
	const upsertBlobMock = vi.fn(async () => undefined);
	const upsertDirentMock = vi.fn(async () => null as bigint | null);
	const insertDirentMock = vi.fn(async () => undefined);
	const deleteDirentMock = vi.fn(async () => 4n);
	const decrementNlinkMock = vi.fn(async () => 0);
	const deleteInodeMock = vi.fn(async () => undefined);
	const moveDirentMock = vi.fn(async () => undefined);
	const getBlobMock = vi.fn(async () => null as Uint8Array | null);

	const dialect = {
		connect: vi.fn(),
		disconnect: vi.fn(),
		transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
		setSandboxContext: vi.fn(),
		setSandboxContextWithLock: setSandboxContextWithLockMock,
		getSandboxVersion: getSandboxVersionMock,
		loadAllPaths: vi.fn(async () => [
			dirEntry("/", 1n),
			dirEntry("/home", 2n),
			dirEntry("/home/user", 3n),
			fileEntry("/home/user/existing.txt", 4n, 20),
			dirEntry("/other", 5n),
		]),
		createSandbox: vi.fn(),
		deleteSandbox: vi.fn(),
		createInode: createInodeMock,
		getInode: vi.fn(),
		updateInode: vi.fn(),
		deleteInode: deleteInodeMock,
		incrementNlink: vi.fn(),
		decrementNlink: decrementNlinkMock,
		insertDirent: insertDirentMock,
		upsertDirent: upsertDirentMock,
		deleteDirent: deleteDirentMock,
		listDirents: vi.fn(),
		moveDirent: moveDirentMock,
		upsertBlob: upsertBlobMock,
		getBlob: getBlobMock,
		gcOrphanBlobs: vi.fn(),
		getBlobsForSandbox: vi.fn(async () => []),
		loadSubtreeInodes: vi.fn(async () => [3n, 4n]),
		bulkIngest: bulkIngestMock,
		resolvePath: vi.fn(),
		writeFileComposite: writeFileCompositeMock,
		mkdirComposite: mkdirCompositeMock,
		rmComposite: rmCompositeMock,
		mvComposite: mvCompositeMock,
	} as unknown as SqlDialect<unknown>;

	return {
		dialect,
		setSandboxContextWithLockMock,
		writeFileCompositeMock,
		mkdirCompositeMock,
		rmCompositeMock,
		mvCompositeMock,
		createInodeMock,
		upsertBlobMock,
		upsertDirentMock,
		insertDirentMock,
		deleteDirentMock,
		decrementNlinkMock,
		deleteInodeMock,
		moveDirentMock,
		getBlobMock,
		getSandboxVersionMock,
		bulkIngestMock,
	};
}

describe("SqlFs mutation scope — database epoch plumbing", () => {
	it("captures the leased epoch once and threads each successful next epoch", async () => {
		const m = makeDialect();
		const events: string[] = [];
		m.getSandboxVersionMock.mockImplementation(async () => {
			events.push("capture");
			return 40n;
		});
		m.getBlobMock.mockImplementation(async () => {
			events.push("blob-read");
			return new Uint8Array(0);
		});
		m.writeFileCompositeMock
			.mockImplementationOnce(async () => ({ inodeId: 10n, nextEpoch: 41n }) as never)
			.mockImplementationOnce(async () => ({ inodeId: 11n, nextEpoch: 42n }) as never);
		const fs = new SqlFs({ dialect: m.dialect, sandboxId: "s1" });
		await fs.ready();

		fs.beginScriptScope();
		await fs.appendFile("/home/user/existing.txt", "one");
		await fs.writeFile("/home/user/second.txt", "two");
		await fs.endScriptScope();

		expect(m.getSandboxVersionMock).toHaveBeenCalledOnce();
		expect(events.indexOf("capture")).toBeGreaterThanOrEqual(0);
		expect(events.indexOf("capture")).toBeLessThan(events.indexOf("blob-read"));
		expect(m.writeFileCompositeMock.mock.calls[0]).toContain(40n);
		expect(m.writeFileCompositeMock.mock.calls[1]).toContain(41n);
	});

	it("threads the scope epoch through every composite writer and bulk ingest", async () => {
		const m = makeDialect();
		const fs = new SqlFs({ dialect: m.dialect, sandboxId: "s1" });
		await fs.ready();
		fs.beginScriptScope();

		await fs.writeFile("/home/user/epoch-write.txt", "one");
		await fs.appendFile("/home/user/epoch-write.txt", "two");
		await fs.mkdir("/home/user/epoch-dir");
		await fs.rm("/home/user/existing.txt");
		await fs.mv("/home/user/epoch-write.txt", "/other/epoch-move.txt");
		await fs.bulkIngest([{ path: "/home/user/epoch-bulk.txt", content: new Uint8Array([1]), mode: 0o644 }]);
		await fs.endScriptScope();

		expect(m.getSandboxVersionMock).toHaveBeenCalledOnce();
		for (const calls of [
			m.writeFileCompositeMock.mock.calls,
			m.mkdirCompositeMock.mock.calls,
			m.rmCompositeMock.mock.calls,
			m.mvCompositeMock.mock.calls,
			m.bulkIngestMock.mock.calls,
		]) {
			expect(calls.length).toBeGreaterThan(0);
			expect(calls.flat()).toContain(40n);
		}
	});

	it("threads the epoch through every sequential fallback when composites are unavailable", async () => {
		const m = makeDialect();
		m.dialect.writeFileComposite = undefined;
		m.dialect.mkdirComposite = undefined;
		m.dialect.rmComposite = undefined;
		m.dialect.mvComposite = undefined;
		const fs = new SqlFs({ dialect: m.dialect, sandboxId: "s1" });
		await fs.ready();
		fs.beginScriptScope();

		await fs.writeFile("/home/user/fallback-write.txt", "one");
		await fs.mkdir("/home/user/fallback-dir");
		await fs.rm("/home/user/existing.txt");
		await fs.mv("/home/user/fallback-write.txt", "/other/fallback-move.txt");
		await fs.endScriptScope();

		expect(m.getSandboxVersionMock).toHaveBeenCalledOnce();
		for (const calls of [
			m.createInodeMock.mock.calls,
			m.upsertDirentMock.mock.calls,
			m.insertDirentMock.mock.calls,
			m.deleteDirentMock.mock.calls,
			m.moveDirentMock.mock.calls,
		]) {
			expect(calls.length).toBeGreaterThan(0);
			expect(calls.flat()).toContain(40n);
		}
	});
});

// ── writeFile composite ──────────────────────────────────────────────────────

describe("SqlFs.writeFile — composite path", () => {
	let fs: SqlFs;
	let m: ReturnType<typeof makeDialect>;

	beforeEach(async () => {
		m = makeDialect();
		fs = new SqlFs({ dialect: m.dialect, sandboxId: "s1" });
		await fs.ready();
	});

	it("calls writeFileComposite instead of sequential methods", async () => {
		await fs.writeFile("/home/user/new.txt", "hello");

		expect(m.writeFileCompositeMock).toHaveBeenCalledOnce();
		expect(m.upsertBlobMock).not.toHaveBeenCalled();
		expect(m.createInodeMock).not.toHaveBeenCalled();
		expect(m.upsertDirentMock).not.toHaveBeenCalled();
	});

	it("skips setSandboxContextWithLock", async () => {
		await fs.writeFile("/home/user/new.txt", "hello");

		expect(m.setSandboxContextWithLockMock).not.toHaveBeenCalled();
	});

	it("passes correct arguments to writeFileComposite", async () => {
		const content = "hello world";
		await fs.writeFile("/home/user/new.txt", content);

		expect(m.writeFileCompositeMock).toHaveBeenCalledWith(
			expect.anything(),
			"s1",
			3n,
			"new.txt",
			0o644,
			new TextEncoder().encode(content).length,
			expect.any(Uint8Array),
			expect.any(Uint8Array),
		);
	});

	it("updates pathCache after composite write", async () => {
		await fs.writeFile("/home/user/new.txt", "hello");

		expect(fs.getAllPaths()).toContain("/home/user/new.txt");
	});

	it("evicts old inode from pathCache on overwrite", async () => {
		await fs.writeFile("/home/user/existing.txt", "new content");

		expect(fs.getAllPaths()).toContain("/home/user/existing.txt");
		expect(m.writeFileCompositeMock).toHaveBeenCalledOnce();
	});
});

// ── appendFile composite ─────────────────────────────────────────────────────

describe("SqlFs.appendFile — composite path", () => {
	let fs: SqlFs;
	let m: ReturnType<typeof makeDialect>;

	beforeEach(async () => {
		m = makeDialect();
		fs = new SqlFs({ dialect: m.dialect, sandboxId: "s1" });
		await fs.ready();
	});

	it("calls writeFileComposite for the write transaction", async () => {
		await fs.appendFile("/home/user/new.log", "line1\n");

		expect(m.writeFileCompositeMock).toHaveBeenCalledOnce();
		expect(m.upsertBlobMock).not.toHaveBeenCalled();
		expect(m.createInodeMock).not.toHaveBeenCalled();
	});

	it("reads existing blob before composite write when file exists", async () => {
		const existingContent = new TextEncoder().encode("hello");
		m.getBlobMock.mockResolvedValueOnce(existingContent);

		await fs.appendFile("/home/user/existing.txt", " world");

		expect(m.getBlobMock).toHaveBeenCalledOnce();
		expect(m.writeFileCompositeMock).toHaveBeenCalledOnce();
	});
});

// ── mkdir composite ──────────────────────────────────────────────────────────

describe("SqlFs.mkdir — composite path", () => {
	let fs: SqlFs;
	let m: ReturnType<typeof makeDialect>;

	beforeEach(async () => {
		m = makeDialect();
		fs = new SqlFs({ dialect: m.dialect, sandboxId: "s1" });
		await fs.ready();
	});

	it("calls mkdirComposite instead of sequential methods", async () => {
		await fs.mkdir("/home/user/projects");

		expect(m.mkdirCompositeMock).toHaveBeenCalledOnce();
		expect(m.createInodeMock).not.toHaveBeenCalled();
		expect(m.insertDirentMock).not.toHaveBeenCalled();
	});

	it("skips setSandboxContextWithLock", async () => {
		await fs.mkdir("/home/user/projects");

		expect(m.setSandboxContextWithLockMock).not.toHaveBeenCalled();
	});

	it("passes correct arguments to mkdirComposite", async () => {
		await fs.mkdir("/home/user/projects");

		expect(m.mkdirCompositeMock).toHaveBeenCalledWith(expect.anything(), "s1", 3n, "projects", 0o755);
	});

	it("updates pathCache after composite mkdir", async () => {
		await fs.mkdir("/home/user/projects");

		expect(fs.getAllPaths()).toContain("/home/user/projects");
	});

	it("recursive mkdir does NOT use mkdirComposite", async () => {
		let idCounter = 10n;
		m.createInodeMock.mockImplementation(async () => idCounter++);

		await fs.mkdir("/home/user/a/b", { recursive: true });

		expect(m.mkdirCompositeMock).not.toHaveBeenCalled();
		expect(m.createInodeMock).toHaveBeenCalled();
	});
});

// ── rm composite ─────────────────────────────────────────────────────────────

describe("SqlFs.rm — composite path", () => {
	let fs: SqlFs;
	let m: ReturnType<typeof makeDialect>;

	beforeEach(async () => {
		m = makeDialect();
		fs = new SqlFs({ dialect: m.dialect, sandboxId: "s1" });
		await fs.ready();
	});

	it("calls rmComposite instead of sequential methods", async () => {
		await fs.rm("/home/user/existing.txt");

		expect(m.rmCompositeMock).toHaveBeenCalledOnce();
		expect(m.deleteDirentMock).not.toHaveBeenCalled();
		expect(m.decrementNlinkMock).not.toHaveBeenCalled();
		expect(m.deleteInodeMock).not.toHaveBeenCalled();
	});

	it("skips setSandboxContextWithLock", async () => {
		await fs.rm("/home/user/existing.txt");

		expect(m.setSandboxContextWithLockMock).not.toHaveBeenCalled();
	});

	it("passes correct arguments to rmComposite", async () => {
		await fs.rm("/home/user/existing.txt");

		expect(m.rmCompositeMock).toHaveBeenCalledWith(expect.anything(), "s1", 3n, "existing.txt");
	});

	it("removes entry from pathCache after composite rm", async () => {
		await fs.rm("/home/user/existing.txt");

		expect(fs.getAllPaths()).not.toContain("/home/user/existing.txt");
	});

	it("recursive rm does NOT use rmComposite", async () => {
		await fs.rm("/home/user", { recursive: true });

		expect(m.rmCompositeMock).not.toHaveBeenCalled();
		expect(m.deleteDirentMock).toHaveBeenCalled();
	});
});

// ── mv composite ─────────────────────────────────────────────────────────────

describe("SqlFs.mv — composite path", () => {
	let fs: SqlFs;
	let m: ReturnType<typeof makeDialect>;

	beforeEach(async () => {
		m = makeDialect();
		fs = new SqlFs({ dialect: m.dialect, sandboxId: "s1" });
		await fs.ready();
	});

	it("calls mvComposite instead of sequential methods", async () => {
		await fs.mv("/home/user/existing.txt", "/home/user/renamed.txt");

		expect(m.mvCompositeMock).toHaveBeenCalledOnce();
		expect(m.moveDirentMock).not.toHaveBeenCalled();
		expect(m.decrementNlinkMock).not.toHaveBeenCalled();
		expect(m.deleteInodeMock).not.toHaveBeenCalled();
	});

	it("skips setSandboxContextWithLock", async () => {
		await fs.mv("/home/user/existing.txt", "/home/user/renamed.txt");

		expect(m.setSandboxContextWithLockMock).not.toHaveBeenCalled();
	});

	it("passes correct arguments to mvComposite", async () => {
		await fs.mv("/home/user/existing.txt", "/other/moved.txt");

		expect(m.mvCompositeMock).toHaveBeenCalledWith(expect.anything(), "s1", 3n, "existing.txt", 5n, "moved.txt");
	});

	it("updates pathCache after composite mv", async () => {
		await fs.mv("/home/user/existing.txt", "/home/user/renamed.txt");

		expect(fs.getAllPaths()).not.toContain("/home/user/existing.txt");
		expect(fs.getAllPaths()).toContain("/home/user/renamed.txt");
	});

	it("mv directory updates subtree paths in pathCache", async () => {
		await fs.mv("/home/user", "/other/user");

		const paths = fs.getAllPaths();
		expect(paths).not.toContain("/home/user");
		expect(paths).not.toContain("/home/user/existing.txt");
		expect(paths).toContain("/other/user");
		expect(paths).toContain("/other/user/existing.txt");
	});
});

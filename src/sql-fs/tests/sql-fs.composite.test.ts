import type { Redis } from "ioredis";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../api/session-manager.js";
import { versionKey } from "../redis-path-snapshot.js";
import { SqlFs } from "../sql-fs.js";
import type { PathCacheEntry, SqlDialect } from "../types.js";

const now = new Date("2026-01-01T00:00:00Z");

class VersionRedis {
	readonly values = new Map<string, string>();

	async set(key: string, value: string, ..._args: unknown[]): Promise<"OK"> {
		this.values.set(key, value);
		return "OK";
	}

	async getex(key: string, ..._args: unknown[]): Promise<string | null> {
		return this.values.get(key) ?? null;
	}

	async incr(key: string): Promise<number> {
		const next = Number(this.values.get(key) ?? "0") + 1;
		this.values.set(key, String(next));
		return next;
	}

	async expire(_key: string, _seconds: number): Promise<number> {
		return 1;
	}

	async del(key: string): Promise<number> {
		return this.values.delete(key) ? 1 : 0;
	}

	async eval(_script: string, _numKeys: number, ..._args: string[]): Promise<number> {
		return 1;
	}
}

function asRedis(redis: VersionRedis): Redis {
	return redis as unknown as Redis;
}

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
	bulkIngestMock: ReturnType<typeof vi.fn>;
} {
	const setSandboxContextWithLockMock = vi.fn();
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
		bulkIngestMock,
	};
}

function findEpochs(value: unknown, result: bigint[] = [], seen = new Set<object>()): bigint[] {
	if (typeof value === "bigint") {
		if (value >= 40n && value <= 50n) result.push(value);
		return result;
	}
	if (value === null || typeof value !== "object" || seen.has(value)) return result;
	seen.add(value);
	for (const item of Array.isArray(value) ? value : Object.values(value)) findEpochs(item, result, seen);
	return result;
}

function makeEpochDialect(): ReturnType<typeof makeDialect> & {
	state: { expected: bigint; calls: bigint[]; missing: number; events: string[] };
} {
	const m = makeDialect();
	const state = { expected: 40n, calls: [] as bigint[], missing: 0, events: [] as string[] };
	m.setSandboxContextWithLockMock.mockImplementation(async () => {
		state.events.push("lease");
	});
	const observe = (result: unknown): ReturnType<typeof vi.fn> =>
		vi.fn(async (...args: unknown[]) => {
			const token = args.flatMap((arg) => findEpochs(arg)).at(-1);
			if (token === undefined) state.missing++;
			else {
				state.calls.push(token);
				if (token === state.expected) state.expected++;
			}
			return result;
		});
	m.writeFileCompositeMock.mockImplementation(observe(10n));
	m.mkdirCompositeMock.mockImplementation(observe(11n));
	m.rmCompositeMock.mockImplementation(observe(4n));
	m.mvCompositeMock.mockImplementation(observe(undefined));
	m.bulkIngestMock.mockImplementation(observe(new Map<string, PathCacheEntry>()));
	m.createInodeMock.mockImplementation(observe(10n));
	m.upsertBlobMock.mockImplementation(observe(undefined));
	m.upsertDirentMock.mockImplementation(observe(null));
	m.insertDirentMock.mockImplementation(observe(undefined));
	m.deleteDirentMock.mockImplementation(observe(undefined));
	m.decrementNlinkMock.mockImplementation(observe(0));
	m.deleteInodeMock.mockImplementation(observe(undefined));
	m.moveDirentMock.mockImplementation(observe(undefined));
	return Object.assign(m, { state });
}

describe("SqlFs mutation scope — database epoch plumbing", () => {
	it("captures once on the leased path before append reads its base and advances successful publications", async () => {
		const m = makeEpochDialect();
		m.getBlobMock.mockImplementation(async () => {
			m.state.events.push("base-read");
			return new Uint8Array(0);
		});
		const fs = new SqlFs({ dialect: m.dialect, sandboxId: "s1" });
		await fs.ready();
		fs.beginScriptScope();
		await fs.appendFile("/home/user/existing.txt", "one");
		await fs.writeFile("/home/user/second.txt", "two");
		await fs.endScriptScope();
		expect(m.state.events.indexOf("lease")).toBeLessThan(m.state.events.indexOf("base-read"));
		expect(m.state.calls).toEqual([40n, 41n]);
	});

	it("threads the current epoch through composite and bulk publication routes", async () => {
		const m = makeEpochDialect();
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
		expect(m.state.calls).toEqual([40n, 41n, 42n, 43n, 44n, 45n]);
	});

	it("threads the current epoch through every sequential fallback route", async () => {
		const m = makeEpochDialect();
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
		expect(m.state.calls.length).toBeGreaterThanOrEqual(4);
		expect(m.state.calls).toEqual([...m.state.calls].sort((a, b) => Number(a - b)));
	});

	it("keeps the Postgres epoch separate from SessionManager's Redis version", async () => {
		const m = makeDialect();
		const fs = new SqlFs({ dialect: m.dialect, sandboxId: "s1" });
		await fs.ready();
		const redis = new VersionRedis();
		const manager = new SessionManager({
			createFs: vi.fn(async () => fs as never),
			redis: asRedis(redis),
			rwlockEnabled: false,
		});

		await manager.withSession("default", "s1", async () => {
			await fs.writeFile("/home/user/redis-separation.txt", "content");
		});

		expect(redis.values.get(versionKey("default", "s1"))).toBe("1");
		expect(redis.values.get(versionKey("default", "s1"))).not.toBe("40");
	});

	it("preserves reset-on-recreate cache semantics without an incarnation token", async () => {
		const redis = new VersionRedis();
		const makeFs = (): object => ({
			getAllPaths: () => [],
			reload: async () => undefined,
			wasDirty: () => false,
			clearDirty: () => undefined,
			poisoned: () => false,
		});
		let createCount = 0;
		const manager = new SessionManager({
			createFs: vi.fn(async () => {
				createCount++;
				return makeFs() as never;
			}),
			destroySandboxFn: vi.fn(async () => undefined),
			redis: asRedis(redis),
			rwlockEnabled: false,
		});

		await manager.withSession("default", "recreated", async () => undefined);
		await manager.destroy("default", "recreated");
		expect(redis.values.get(versionKey("default", "recreated"))).toBe("DESTROYED");

		await manager.withSession("default", "recreated", async () => undefined);
		expect(createCount).toBe(2);
		expect(redis.values.has(versionKey("default", "recreated"))).toBe(false);
		expect(manager.getSession("default", "recreated")?.lastSeenVersion).toBe(0);
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

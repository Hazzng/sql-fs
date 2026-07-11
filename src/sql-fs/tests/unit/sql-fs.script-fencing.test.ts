import { beforeEach, describe, expect, it, vi } from "vitest";
import { SqlFs } from "../../sql-fs.js";
import type { PathCacheEntry, SqlDialect } from "../../types.js";

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
		contentSha256: new Uint8Array(32).fill(0xab),
		symlinkTarget: null,
	};
}

function makeDialect() {
	const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({ txId: 1 }));
	const setSandboxContextWithLock = vi.fn(async () => undefined);
	const writeFileComposite = vi.fn(async () => 11n);
	const mkdirComposite = vi.fn(async () => 12n);
	const rmComposite = vi.fn(async () => 13n);
	const mvComposite = vi.fn(async () => undefined);
	const dialect: SqlDialect<unknown> = {
		connect: vi.fn(),
		disconnect: vi.fn(),
		transaction,
		setSandboxContext: vi.fn(async () => undefined),
		setSandboxContextWithLock,
		loadAllPaths: vi.fn(async () => [dirEntry("/", 1n), dirEntry("/home", 2n), dirEntry("/home/user", 3n), fileEntry("/home/user/file.txt", 4n, 4)]),
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
		getBlob: vi.fn(async () => new TextEncoder().encode("seed")),
		getBlobNoTx: vi.fn(),
		gcOrphanBlobs: vi.fn(),
		getBlobsForSandbox: vi.fn(async () => []),
		loadSubtreeInodes: vi.fn(),
		bulkIngest: vi.fn(),
		resolvePath: vi.fn(),
		writeFileComposite,
		mkdirComposite,
		rmComposite,
		mvComposite,
	} as SqlDialect<unknown>;
	return { dialect, transaction, setSandboxContextWithLock, writeFileComposite, mkdirComposite, rmComposite, mvComposite };
}

type FencedState = {
	currentVersion: number;
	files: Map<string, string>;
	txs: unknown[];
};

function makeFencedDialect(state: FencedState) {
	const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
		const tx = { txId: state.txs.length + 1 };
		state.txs.push(tx);
		return fn(tx);
	});
	const setSandboxContextWithLock = vi.fn(async () => undefined);
	const writeFileComposite = vi.fn(async (_tx: unknown, _sandboxId: string, _parentId: bigint, name: string, _mode: number, _size: number, _sha256: Uint8Array, data: Uint8Array, sandboxVersion?: number) => {
		if (sandboxVersion !== state.currentVersion) {
			throw Object.assign(new Error("ECOHERENCE: sandbox version changed; write suppressed"), { code: "ECOHERENCE" });
		}
		state.files.set(`/home/user/${name}`, new TextDecoder().decode(data));
		return 99n;
	});
	const mkdirComposite = vi.fn(async () => 12n);
	const rmComposite = vi.fn(async () => 13n);
	const mvComposite = vi.fn(async () => undefined);
	const dialect: SqlDialect<unknown> = {
		connect: vi.fn(),
		disconnect: vi.fn(),
		transaction,
		setSandboxContext: vi.fn(async () => undefined),
		setSandboxContextWithLock,
		loadAllPaths: vi.fn(async () => [dirEntry("/", 1n), dirEntry("/home", 2n), dirEntry("/home/user", 3n), fileEntry("/home/user/file.txt", 4n, state.files.get("/home/user/file.txt")?.length ?? 0)]),
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
		getBlob: vi.fn(async () => new TextEncoder().encode(state.files.get("/home/user/file.txt") ?? "seed")),
		getBlobNoTx: vi.fn(),
		gcOrphanBlobs: vi.fn(),
		getBlobsForSandbox: vi.fn(async () => []),
		loadSubtreeInodes: vi.fn(),
		bulkIngest: vi.fn(),
		resolvePath: vi.fn(),
		writeFileComposite,
		mkdirComposite,
		rmComposite,
		mvComposite,
	} as SqlDialect<unknown>;
	return { dialect, transaction, setSandboxContextWithLock, writeFileComposite, mkdirComposite, rmComposite, mvComposite };
}

describe("SqlFs script fencing", () => {
	let fs: SqlFs;
	let m: ReturnType<typeof makeDialect>;

	beforeEach(async () => {
		m = makeDialect();
		fs = new SqlFs({ dialect: m.dialect, sandboxId: "s-fence", sandboxVersion: 41 });
		await fs.ready();
		m.transaction.mockClear();
		m.setSandboxContextWithLock.mockClear();
	});

	it("threads the pinned epoch into the script transaction and composite writes", async () => {
		fs.beginScriptScope();
		await fs.writeFile("/home/user/a.txt", "alpha");
		await fs.appendFile("/home/user/a.txt", "-beta");
		await fs.mkdir("/home/user/projects");
		await fs.rm("/home/user/a.txt");
		await fs.mv("/home/user/projects", "/home/user/renamed-projects");

		expect(m.transaction).toHaveBeenCalledOnce();
		expect(m.setSandboxContextWithLock).toHaveBeenCalledWith(expect.anything(), "s-fence", 41);
		expect(m.writeFileComposite).toHaveBeenNthCalledWith(1, expect.anything(), "s-fence", expect.anything(), "a.txt", expect.anything(), expect.anything(), expect.anything(), expect.anything(), 41);
		expect(m.writeFileComposite).toHaveBeenNthCalledWith(2, expect.anything(), "s-fence", expect.anything(), "a.txt", expect.anything(), expect.anything(), expect.anything(), expect.anything(), 41);
		expect(m.mkdirComposite).toHaveBeenCalledWith(expect.anything(), "s-fence", expect.anything(), "projects", expect.anything(), 41);
		expect(m.rmComposite).toHaveBeenCalledWith(expect.anything(), "s-fence", expect.anything(), "a.txt", 41);
		expect(m.mvComposite).toHaveBeenCalledWith(expect.anything(), "s-fence", expect.anything(), "projects", expect.anything(), expect.anything(), 41);
		await fs.endScriptScope();
	});

	it("rejects a stale fenced write after the lease is superseded, while a fresh append survives", async () => {
		const state: FencedState = { currentVersion: 41, files: new Map([["/home/user/file.txt", "seed"]]), txs: [] };
		const { dialect } = makeFencedDialect(state);
		const stale = new SqlFs({ dialect, sandboxId: "s-fence", sandboxVersion: 41 });
		const fresh = new SqlFs({ dialect, sandboxId: "s-fence", sandboxVersion: 42 });
		await Promise.all([stale.ready(), fresh.ready()]);

		stale.beginScriptScope();
		fresh.beginScriptScope();

		state.currentVersion = 42;

		await expect(stale.writeFile("/home/user/file.txt", "from-a")).rejects.toMatchObject({ code: "ECOHERENCE" });
		await fresh.appendFile("/home/user/file.txt", "-from-b");
		await Promise.all([stale.abortScriptScope(), fresh.endScriptScope()]);

		expect(state.files.get("/home/user/file.txt")).toBe("seed-from-b");
		expect(dialect.writeFileComposite).toHaveBeenCalledTimes(2);
		expect(dialect.writeFileComposite.mock.calls[0]![8]).toBe(41);
		expect(dialect.writeFileComposite.mock.calls[1]![8]).toBe(42);
	});

	it("keeps the fenced path compatible with transaction pooling by reusing the opened script tx", async () => {
		const state: FencedState = { currentVersion: 41, files: new Map([["/home/user/file.txt", "seed"]]), txs: [] };
		const { dialect } = makeFencedDialect(state);
		const pooled = new SqlFs({ dialect, sandboxId: "s-fence", sandboxVersion: 41 });
		await pooled.ready();

		pooled.beginScriptScope();
		await pooled.writeFile("/home/user/a.txt", "alpha");
		await pooled.appendFile("/home/user/file.txt", "-beta");
		await pooled.mkdir("/home/user/projects");
		await pooled.endScriptScope();

		expect(state.txs).toHaveLength(1);
		expect(dialect.writeFileComposite).toHaveBeenCalledTimes(2);
		expect(dialect.mkdirComposite).toHaveBeenCalledTimes(1);
		const firstTx = dialect.writeFileComposite.mock.calls[0]![0];
		const secondTx = dialect.writeFileComposite.mock.calls[1]![0];
		expect(firstTx).toBe(secondTx);
		expect(dialect.mkdirComposite.mock.calls[0]![0]).toBe(firstTx);
	});
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SqlFs } from "../../sql-fs.js";
import type { PathCacheEntry, SqlDialect } from "../../types.js";

const now = new Date("2026-01-01T00:00:00Z");

function dirEntry(path: string, inodeId: bigint): { path: string } & PathCacheEntry {
	return { path, inodeId, kind: 2, mode: 0o755, size: 0, mtime: now, contentSha256: null, symlinkTarget: null };
}

function makeDialect() {
	const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({}));
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
		loadAllPaths: vi.fn(async () => [dirEntry("/", 1n), dirEntry("/home", 2n), dirEntry("/home/user", 3n)]),
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
		getBlob: vi.fn(),
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
		await fs.mkdir("/home/user/projects");
		await fs.rm("/home/user/a.txt");
		await fs.mv("/home/user/projects", "/home/user/renamed-projects");

		expect(m.transaction).toHaveBeenCalledOnce();
		expect(m.setSandboxContextWithLock).toHaveBeenCalledWith(expect.anything(), "s-fence", 41);
		expect(m.writeFileComposite).toHaveBeenCalledWith(expect.anything(), "s-fence", expect.anything(), "a.txt", expect.anything(), expect.anything(), expect.anything(), expect.anything(), 41);
		expect(m.mkdirComposite).toHaveBeenCalledWith(expect.anything(), "s-fence", expect.anything(), "projects", expect.anything(), 41);
		expect(m.rmComposite).toHaveBeenCalledWith(expect.anything(), "s-fence", expect.anything(), "a.txt", 41);
		expect(m.mvComposite).toHaveBeenCalledWith(expect.anything(), "s-fence", expect.anything(), "projects", expect.anything(), expect.anything(), 41);
		await fs.endScriptScope();
	});
});

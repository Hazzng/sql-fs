import { beforeEach, describe, expect, it, vi } from "vitest";
import { SqlFs } from "../sql-fs.js";
import type { PathCacheEntry, SqlDialect } from "../types.js";

const now = new Date("2026-01-01T00:00:00Z");

function dirEntry(path: string, inodeId: bigint): { path: string } & PathCacheEntry {
	return { path, inodeId, kind: 2, mode: 0o755, size: 0, mtime: now, contentSha256: null, symlinkTarget: null };
}

function fileEntry(path: string, inodeId: bigint, size = 5): { path: string } & PathCacheEntry {
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

function makeDialect(): SqlDialect<unknown> {
	let nextInodeId = 100n;
	return {
		connect: vi.fn(),
		disconnect: vi.fn(),
		transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
		setSandboxContext: vi.fn(),
		setSandboxContextWithLock: vi.fn(),
		loadAllPaths: vi.fn(async () => [
			dirEntry("/", 1n),
			dirEntry("/home", 2n),
			dirEntry("/home/user", 3n),
			fileEntry("/home/user/file.txt", 4n),
			fileEntry("/home/user/other.txt", 5n),
		]),
		createSandbox: vi.fn(),
		deleteSandbox: vi.fn(),
		createInode: vi.fn(async () => {
			nextInodeId += 1n;
			return nextInodeId;
		}),
		getInode: vi.fn(),
		updateInode: vi.fn(),
		deleteInode: vi.fn(),
		incrementNlink: vi.fn(),
		decrementNlink: vi.fn(async () => 0),
		insertDirent: vi.fn(),
		upsertDirent: vi.fn(async () => null),
		deleteDirent: vi.fn(async () => 4n),
		listDirents: vi.fn(),
		moveDirent: vi.fn(),
		upsertBlob: vi.fn(),
		getBlob: vi.fn(async () => new Uint8Array(0)),
		getBlobNoTx: vi.fn(async () => new Uint8Array(0)),
		gcOrphanBlobs: vi.fn(),
		getBlobsForSandbox: vi.fn(async () => []),
		loadSubtreeInodes: vi.fn(async () => [3n, 4n, 5n]),
		bulkIngest: vi.fn(),
		resolvePath: vi.fn(),
		writeFileComposite: vi.fn(async () => 100n),
	} as unknown as SqlDialect<unknown>;
}

describe("SqlFs script-tx — lazy activation", () => {
	let dialect: SqlDialect<unknown>;
	let fs: SqlFs;

	beforeEach(async () => {
		dialect = makeDialect();
		fs = new SqlFs({ dialect, sandboxId: "s-tx" });
		await fs.ready();
		(dialect.transaction as ReturnType<typeof vi.fn>).mockClear();
		(dialect.setSandboxContextWithLock as ReturnType<typeof vi.fn>).mockClear();
	});

	it("beginScriptScope is synchronous and sets scriptScopeActive", () => {
		expect(fs.scriptScopeActive).toBe(false);
		fs.beginScriptScope();
		expect(fs.scriptScopeActive).toBe(true);
	});

	it("after beginScriptScope, scriptTxOpen is false (no tx yet)", () => {
		fs.beginScriptScope();
		expect(fs.scriptTxOpen).toBe(false);
	});

	it("read-only ops during scope do not open a tx", async () => {
		fs.beginScriptScope();
		await fs.exists("/home/user/file.txt");
		await fs.stat("/home/user/file.txt");
		fs.getAllPaths();
		expect(fs.scriptTxOpen).toBe(false);
		expect(dialect.transaction).not.toHaveBeenCalled();
		await fs.endScriptScope();
	});

	it("first writeFile during scope opens tx lazily", async () => {
		fs.beginScriptScope();
		await fs.writeFile("/home/user/new.txt", "data");
		expect(fs.scriptTxOpen).toBe(true);
		expect(dialect.transaction).toHaveBeenCalledOnce();
		expect(dialect.setSandboxContextWithLock).toHaveBeenCalledOnce();
		await fs.endScriptScope();
	});

	it("second writeFile reuses the same tx (transaction called once)", async () => {
		fs.beginScriptScope();
		await fs.writeFile("/home/user/a.txt", "1");
		await fs.writeFile("/home/user/b.txt", "2");
		expect(dialect.transaction).toHaveBeenCalledOnce();
		expect(dialect.setSandboxContextWithLock).toHaveBeenCalledOnce();
		await fs.endScriptScope();
	});

	it("mv during scope reuses tx", async () => {
		fs.beginScriptScope();
		await fs.writeFile("/home/user/tmp.txt", "x");
		(dialect.transaction as ReturnType<typeof vi.fn>).mockClear();
		await fs.mv("/home/user/file.txt", "/home/user/renamed.txt");
		expect(dialect.transaction).not.toHaveBeenCalled();
		await fs.endScriptScope();
	});

	it("rm during scope reuses tx", async () => {
		fs.beginScriptScope();
		await fs.writeFile("/home/user/tmp.txt", "x");
		(dialect.transaction as ReturnType<typeof vi.fn>).mockClear();
		await fs.rm("/home/user/other.txt");
		expect(dialect.transaction).not.toHaveBeenCalled();
		await fs.endScriptScope();
	});

	it("mkdir during scope reuses tx", async () => {
		fs.beginScriptScope();
		await fs.writeFile("/home/user/tmp.txt", "x");
		(dialect.transaction as ReturnType<typeof vi.fn>).mockClear();
		await fs.mkdir("/home/user/subdir");
		expect(dialect.transaction).not.toHaveBeenCalled();
		await fs.endScriptScope();
	});

	it("readFile after write piggybacks on open script-tx (no new transaction)", async () => {
		fs.beginScriptScope();
		await fs.writeFile("/home/user/new.txt", "hello");
		(dialect.transaction as ReturnType<typeof vi.fn>).mockClear();
		await fs.readFile("/home/user/new.txt");
		expect(dialect.transaction).not.toHaveBeenCalled();
		await fs.endScriptScope();
	});
});

describe("SqlFs script-tx — commit path", () => {
	let dialect: SqlDialect<unknown>;
	let fs: SqlFs;

	beforeEach(async () => {
		dialect = makeDialect();
		fs = new SqlFs({ dialect, sandboxId: "s-tx" });
		await fs.ready();
	});

	it("endScriptScope when no tx opened: no-op", async () => {
		fs.beginScriptScope();
		await fs.endScriptScope();
		expect(fs.scriptScopeActive).toBe(false);
		expect(fs.scriptTxOpen).toBe(false);
	});

	it("endScriptScope with tx resolves held promise (commit)", async () => {
		fs.beginScriptScope();
		await fs.writeFile("/home/user/a.txt", "data");
		expect(fs.scriptTxOpen).toBe(true);
		await fs.endScriptScope();
		expect(fs.scriptScopeActive).toBe(false);
		expect(fs.scriptTxOpen).toBe(false);
	});

	it("after endScriptScope, next writeFile opens its own tx", async () => {
		fs.beginScriptScope();
		await fs.writeFile("/home/user/a.txt", "1");
		await fs.endScriptScope();

		(dialect.transaction as ReturnType<typeof vi.fn>).mockClear();
		await fs.writeFile("/home/user/b.txt", "2");
		expect(dialect.transaction).toHaveBeenCalledOnce();
	});

	it("pathCache reflects writes after commit", async () => {
		fs.beginScriptScope();
		await fs.writeFile("/home/user/new.txt", "hello");
		await fs.endScriptScope();
		expect(fs.getAllPaths()).toContain("/home/user/new.txt");
	});
});

describe("SqlFs script-tx — terminal fencing conflict", () => {
	it("rolls back staged work, poisons the scope, and suppresses commit", async () => {
		const dialect = makeDialect();
		const state = { committed: false, rolledBack: false };
		const fencingError = Object.assign(new Error("sandbox fencing conflict"), { code: "EFENCED" });
		const writeFileComposite = vi.fn().mockResolvedValueOnce(10n).mockRejectedValue(fencingError);
		dialect.writeFileComposite = writeFileComposite;
		dialect.transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
			try {
				const result = await fn({});
				state.committed = true;
				return result;
			} catch (error) {
				state.rolledBack = true;
				throw error;
			}
		}) as unknown as SqlDialect<unknown>["transaction"];

		const fs = new SqlFs({ dialect, sandboxId: "s-fence" });
		await fs.ready();
		fs.beginScriptScope();
		await fs.writeFile("/home/user/staged.txt", "before conflict");
		await expect(fs.writeFile("/home/user/conflict.txt", "fenced")).rejects.toMatchObject({ code: "EFENCED" });
		writeFileComposite.mockResolvedValue(12n);
		await expect(fs.writeFile("/home/user/after-conflict.txt", "blocked")).rejects.toThrow();
		expect(fs.poisoned()).toBe(true);

		await expect(fs.endScriptScope()).rejects.toThrow();
		expect(state.rolledBack).toBe(true);
		expect(state.committed).toBe(false);
		expect(fs.getAllPaths()).not.toContain("/home/user/staged.txt");
	});
});

describe("SqlFs script-tx — abort path (rollback recovery)", () => {
	let dialect: SqlDialect<unknown>;
	let fs: SqlFs;

	beforeEach(async () => {
		dialect = makeDialect();
		fs = new SqlFs({ dialect, sandboxId: "s-tx" });
		await fs.ready();
	});

	it("abortScriptScope when no tx opened: no-op, no reload", async () => {
		const reloadSpy = vi.spyOn(fs, "reload");
		fs.beginScriptScope();
		await fs.abortScriptScope();
		expect(fs.scriptScopeActive).toBe(false);
		expect(reloadSpy).not.toHaveBeenCalled();
	});

	it("abortScriptScope with tx: reload() and clearDirty() called", async () => {
		fs.beginScriptScope();
		await fs.writeFile("/home/user/a.txt", "data");
		expect(fs.wasDirty()).toBe(true);

		await fs.abortScriptScope();
		expect(fs.scriptScopeActive).toBe(false);
		expect(fs.scriptTxOpen).toBe(false);
		expect(fs.wasDirty()).toBe(false);
	});

	it("after abort: pathCache matches the reloaded DB state", async () => {
		fs.beginScriptScope();
		await fs.writeFile("/home/user/phantom.txt", "ghost");
		expect(fs.getAllPaths()).toContain("/home/user/phantom.txt");

		await fs.abortScriptScope();
		expect(fs.getAllPaths()).not.toContain("/home/user/phantom.txt");
		expect(fs.getAllPaths()).toContain("/home/user/file.txt");
	});

	it("after abort: next writeFile opens its own tx", async () => {
		fs.beginScriptScope();
		await fs.writeFile("/home/user/a.txt", "x");
		await fs.abortScriptScope();

		(dialect.transaction as ReturnType<typeof vi.fn>).mockClear();
		await fs.writeFile("/home/user/b.txt", "y");
		expect(dialect.transaction).toHaveBeenCalledOnce();
	});
});

describe("SqlFs script-tx — error handling", () => {
	let dialect: SqlDialect<unknown>;
	let fs: SqlFs;

	beforeEach(async () => {
		dialect = makeDialect();
		fs = new SqlFs({ dialect, sandboxId: "s-tx" });
		await fs.ready();
	});

	it("beginScriptScope when already active throws", () => {
		fs.beginScriptScope();
		expect(() => fs.beginScriptScope()).toThrow("beginScriptScope: a script scope is already active");
	});

	it("endScriptScope when not active: no-op", async () => {
		await fs.endScriptScope();
		expect(fs.scriptScopeActive).toBe(false);
	});

	it("abortScriptScope when not active: no-op", async () => {
		await fs.abortScriptScope();
		expect(fs.scriptScopeActive).toBe(false);
	});

	it("dirty flag set during scope, cleared by abort", async () => {
		fs.beginScriptScope();
		await fs.writeFile("/home/user/a.txt", "x");
		expect(fs.wasDirty()).toBe(true);
		await fs.abortScriptScope();
		expect(fs.wasDirty()).toBe(false);
	});
});

// Audit H7: when the script-tx COMMIT fails, Postgres rolls the transaction
// back. endScriptScope must discard the in-memory mutations (reload + clearDirty)
// and rethrow, so the session never publishes a version/snapshot of state that
// is not actually in Postgres.
describe("SqlFs script-tx — COMMIT failure recovery (H7)", () => {
	function makeFailableDialect(): { dialect: SqlDialect<unknown>; state: { failNextCommit: boolean } } {
		const dialect = makeDialect();
		const state = { failNextCommit: false };
		dialect.transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
			const result = await fn({});
			if (state.failNextCommit) {
				state.failNextCommit = false;
				throw new Error("COMMIT failed");
			}
			return result;
		}) as unknown as SqlDialect<unknown>["transaction"];
		return { dialect, state };
	}

	it("COMMIT failure reloads committed state, clears dirty, and rethrows", async () => {
		const { dialect, state } = makeFailableDialect();
		const fs = new SqlFs({ dialect, sandboxId: "s-tx" });
		await fs.ready();

		fs.beginScriptScope();
		await fs.writeFile("/home/user/phantom.txt", "ghost");
		expect(fs.wasDirty()).toBe(true);
		expect(fs.getAllPaths()).toContain("/home/user/phantom.txt");

		state.failNextCommit = true;
		await expect(fs.endScriptScope()).rejects.toThrow(/COMMIT failed/);

		// The uncommitted mutation is discarded; dirty is cleared so no version/
		// snapshot of the rolled-back state is published.
		expect(fs.wasDirty()).toBe(false);
		expect(fs.getAllPaths()).not.toContain("/home/user/phantom.txt");
		expect(fs.getAllPaths()).toContain("/home/user/file.txt");
		expect(fs.scriptScopeActive).toBe(false);
		expect(fs.scriptTxOpen).toBe(false);
		// Recovery reload succeeded, so the cache is NOT poisoned.
		expect(fs.poisoned()).toBe(false);
	});
});

// F1: when BOTH the COMMIT and the recovery reload fail (correlated PG outage),
// the in-memory caches keep the uncommitted "phantom" mutations and #dirty stays
// true. endScriptScope must mark the cache poisoned so publishVersionIfDirty
// refuses to authenticate the lie under a fresh version stamp.
describe("SqlFs script-tx — poisoned cache after correlated PG failure (F1)", () => {
	/**
	 * Both the COMMIT (via `transaction`) and the recovery reload (via
	 * `loadAllPaths`) fail while `failPg` is set, modelling a single PG outage
	 * that knocks out the write commit and the recovery read alike.
	 */
	function makePoisoningDialect(): { dialect: SqlDialect<unknown>; state: { failPg: boolean } } {
		const dialect = makeDialect();
		const state = { failPg: false };
		const baseLoadAllPaths = dialect.loadAllPaths as ReturnType<typeof vi.fn>;
		dialect.transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
			const result = await fn({});
			if (state.failPg) {
				throw new Error("COMMIT failed");
			}
			return result;
		}) as unknown as SqlDialect<unknown>["transaction"];
		dialect.loadAllPaths = vi.fn(async (tx: unknown) => {
			if (state.failPg) {
				throw new Error("loadAllPaths failed");
			}
			return baseLoadAllPaths(tx);
		}) as unknown as SqlDialect<unknown>["loadAllPaths"];
		return { dialect, state };
	}

	it("poisons the cache when the recovery reload also fails", async () => {
		const { dialect, state } = makePoisoningDialect();
		const fs = new SqlFs({ dialect, sandboxId: "s-tx" });
		await fs.ready();
		expect(fs.poisoned()).toBe(false);

		fs.beginScriptScope();
		await fs.writeFile("/home/user/phantom.txt", "ghost");
		expect(fs.wasDirty()).toBe(true);
		expect(fs.getAllPaths()).toContain("/home/user/phantom.txt");

		// Same outage fails the COMMIT and the recovery reload.
		state.failPg = true;
		await expect(fs.endScriptScope()).rejects.toThrow(/COMMIT failed/);

		// Recovery reload threw, so the phantom mutation is still in cache and the
		// cache is poisoned. #dirty stays true (reload that would clear it failed).
		expect(fs.poisoned()).toBe(true);
		expect(fs.wasDirty()).toBe(true);
		expect(fs.getAllPaths()).toContain("/home/user/phantom.txt");
	});

	it("publishVersionIfDirty skips INCR and throws ECOHERENCE while poisoned", async () => {
		const { dialect, state } = makePoisoningDialect();
		const fs = new SqlFs({ dialect, sandboxId: "s-tx" });
		await fs.ready();

		fs.beginScriptScope();
		await fs.writeFile("/home/user/phantom.txt", "ghost");
		state.failPg = true;
		await expect(fs.endScriptScope()).rejects.toThrow(/COMMIT failed/);
		expect(fs.poisoned()).toBe(true);

		// Mirror publishVersionIfDirty's poison guard (session-manager.ts). The
		// guard runs BEFORE the dirty gate and BEFORE redis.incr.
		const redis = { incr: vi.fn(async (_key: string) => 1) };
		const session = { lastSeenVersion: 7, publishPending: true };

		const publish = async (): Promise<void> => {
			if (fs.poisoned()) {
				session.lastSeenVersion = -1;
				session.publishPending = false;
				throw Object.assign(new Error("ECOHERENCE: cache poisoned by failed reload; publish suppressed"), {
					code: "ECOHERENCE",
				});
			}
			await redis.incr("vfs:t:ver:s-tx");
		};

		await expect(publish()).rejects.toMatchObject({ code: "ECOHERENCE" });
		expect(redis.incr).not.toHaveBeenCalled();
		expect(session.lastSeenVersion).toBe(-1);
		expect(session.publishPending).toBe(false);
	});

	it("a successful reload clears the poison", async () => {
		const { dialect, state } = makePoisoningDialect();
		const fs = new SqlFs({ dialect, sandboxId: "s-tx" });
		await fs.ready();

		fs.beginScriptScope();
		await fs.writeFile("/home/user/phantom.txt", "ghost");
		state.failPg = true;
		await expect(fs.endScriptScope()).rejects.toThrow(/COMMIT failed/);
		expect(fs.poisoned()).toBe(true);

		// PG recovers; the next reload succeeds and clears the poison + phantom.
		state.failPg = false;
		await fs.reload();
		expect(fs.poisoned()).toBe(false);
		expect(fs.getAllPaths()).not.toContain("/home/user/phantom.txt");
	});
});

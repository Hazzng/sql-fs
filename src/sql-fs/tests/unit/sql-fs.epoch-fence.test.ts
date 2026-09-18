/**
 * #131 / #170 — the writer fencing epoch, in isolation from Postgres.
 *
 * `appendFile` takes its base from the in-memory pathCache before any lock and
 * `getBlob` is content-addressed, so a writer whose lease lapsed can rebuild a
 * file from a base another replica has already superseded. The epoch is what
 * makes that visible to the database: it is pinned when the cache is loaded,
 * stamped into every composite write, and advanced in lockstep with the
 * `sandboxes.version` bump the composite's own CTE applies.
 *
 * These tests pin the SqlFs half of that contract — what gets stamped, when it
 * advances, and what a fenced verdict does to the surrounding script scope. The
 * SQL half (zero rows ⇒ nothing written) is in the integration suite, which
 * needs a real Postgres to be worth anything.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SqlFs } from "../../sql-fs.js";
import type { PathCacheEntry, SqlDialect } from "../../types.js";

const now = new Date("2026-01-01T00:00:00Z");

function dirEntry(path: string, inodeId: bigint): { path: string } & PathCacheEntry {
	return { path, inodeId, kind: 2, mode: 0o755, size: 0, mtime: now, contentSha256: null, symlinkTarget: null };
}

function fileEntry(path: string, inodeId: bigint): { path: string } & PathCacheEntry {
	return {
		path,
		inodeId,
		kind: 1,
		mode: 0o644,
		size: 5,
		mtime: now,
		contentSha256: new Uint8Array(32).fill(7),
		symlinkTarget: null,
	};
}

function estaleepoch(): Error {
	return Object.assign(new Error("ESTALEEPOCH: fenced"), { code: "ESTALEEPOCH" });
}

interface Harness {
	readonly dialect: SqlDialect<unknown>;
	readonly writeFileComposite: ReturnType<typeof vi.fn>;
	readonly mkdirComposite: ReturnType<typeof vi.fn>;
	readonly rmComposite: ReturnType<typeof vi.fn>;
	readonly mvComposite: ReturnType<typeof vi.fn>;
	readonly getSandboxVersion: ReturnType<typeof vi.fn>;
	/**
	 * Outcome per transaction: `true` where the callback returned (the dialect
	 * would COMMIT), `false` where it threw (ROLLBACK). Keyed by the tx handle so
	 * the script transaction can be told apart from the cache-reload reads that
	 * `abortScriptScope` issues on the way out.
	 */
	readonly outcomes: Map<object, boolean>;
	/**
	 * Tx handles that took the advisory lock — i.e. the script transactions.
	 * `#openScriptTx` is the only caller of `setSandboxContextWithLock` here, so
	 * this isolates the scope's own transaction from the plain read transactions
	 * that `ready()` and the abort-path `reload()` open.
	 */
	readonly scriptTxs: Set<object>;
}

function makeHarness(): Harness {
	const outcomes = new Map<object, boolean>();
	const scriptTxs = new Set<object>();
	const writeFileComposite = vi.fn(async () => 10n);
	const mkdirComposite = vi.fn(async () => 11n);
	const rmComposite = vi.fn(async () => 12n);
	const mvComposite = vi.fn(async () => undefined);
	const getSandboxVersion = vi.fn(async () => 7n as bigint | null);

	const dialect = {
		connect: vi.fn(),
		disconnect: vi.fn(),
		transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
			const tx = {};
			try {
				const result = await fn(tx);
				outcomes.set(tx, true);
				return result;
			} catch (err) {
				outcomes.set(tx, false);
				throw err;
			}
		}),
		setSandboxContext: vi.fn(),
		setSandboxContextWithLock: vi.fn(async (tx: unknown) => {
			scriptTxs.add(tx as object);
		}),
		getSandboxVersion,
		loadAllPaths: vi.fn(async () => [
			dirEntry("/", 1n),
			dirEntry("/home", 2n),
			dirEntry("/home/user", 3n),
			fileEntry("/home/user/a.txt", 4n),
			fileEntry("/home/user/b.txt", 5n),
		]),
		createSandbox: vi.fn(),
		deleteSandbox: vi.fn(),
		createInode: vi.fn(),
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
		getBlob: vi.fn(async () => new TextEncoder().encode("base\n")),
		gcOrphanBlobs: vi.fn(),
		getBlobsForSandbox: vi.fn(async () => []),
		loadSubtreeInodes: vi.fn(async () => []),
		bulkIngest: vi.fn(),
		resolvePath: vi.fn(),
		writeFileComposite,
		mkdirComposite,
		rmComposite,
		mvComposite,
	} as unknown as SqlDialect<unknown>;

	return {
		dialect,
		writeFileComposite,
		mkdirComposite,
		rmComposite,
		mvComposite,
		getSandboxVersion,
		outcomes,
		scriptTxs,
	};
}

/** COMMIT (`true`) / ROLLBACK (`false`) verdicts for the script transactions. */
function scriptTxOutcomes(h: Harness): (boolean | "still open")[] {
	return [...h.scriptTxs].map((tx) => h.outcomes.get(tx) ?? "still open");
}

/** Last `expectedEpoch` argument seen by a composite mock. */
function stampedEpoch(mock: ReturnType<typeof vi.fn>): unknown {
	const call = mock.mock.calls.at(-1);
	if (call === undefined) throw new Error("composite was never called");
	return call.at(-1);
}

describe("SqlFs epoch pinning", () => {
	let fs: SqlFs;
	let h: Harness;

	beforeEach(async () => {
		h = makeHarness();
		fs = new SqlFs({ dialect: h.dialect, sandboxId: "s1" });
		await fs.ready();
	});

	it("reads the epoch in the same call that loads the pathCache", () => {
		expect(h.getSandboxVersion).toHaveBeenCalledTimes(1);
		expect(h.getSandboxVersion).toHaveBeenCalledWith(expect.anything(), "s1");
	});

	it("stamps the pinned epoch into writeFileComposite", async () => {
		await fs.writeFile("/home/user/new.txt", "hello");
		expect(stampedEpoch(h.writeFileComposite)).toBe(7n);
	});

	it("stamps the pinned epoch into appendFile's composite", async () => {
		await fs.appendFile("/home/user/a.txt", "more");
		expect(stampedEpoch(h.writeFileComposite)).toBe(7n);
	});

	it("stamps the pinned epoch into mkdirComposite", async () => {
		await fs.mkdir("/home/user/dir");
		expect(stampedEpoch(h.mkdirComposite)).toBe(7n);
	});

	it("stamps the pinned epoch into rmComposite", async () => {
		await fs.rm("/home/user/a.txt");
		expect(stampedEpoch(h.rmComposite)).toBe(7n);
	});

	it("stamps the pinned epoch into mvComposite", async () => {
		await fs.mv("/home/user/a.txt", "/home/user/moved.txt");
		expect(stampedEpoch(h.mvComposite)).toBe(7n);
	});

	it("advances the stamp once per composite so later writes in one transaction match the row it already bumped", async () => {
		fs.beginScriptScope();
		await fs.writeFile("/home/user/one.txt", "1");
		expect(stampedEpoch(h.writeFileComposite)).toBe(7n);
		await fs.writeFile("/home/user/two.txt", "2");
		expect(stampedEpoch(h.writeFileComposite)).toBe(8n);
		await fs.mkdir("/home/user/three");
		expect(stampedEpoch(h.mkdirComposite)).toBe(9n);
		await fs.endScriptScope();
	});

	it("re-pins from the database on reload", async () => {
		h.getSandboxVersion.mockResolvedValueOnce(42n);
		await fs.reload();
		await fs.writeFile("/home/user/new.txt", "hello");
		expect(stampedEpoch(h.writeFileComposite)).toBe(42n);
	});

	it("leaves the stamp where it was when a composite is fenced out, so the next attempt is still fenced", async () => {
		h.writeFileComposite.mockRejectedValueOnce(estaleepoch());
		await expect(fs.writeFile("/home/user/new.txt", "hello")).rejects.toThrow("ESTALEEPOCH");
		await fs.writeFile("/home/user/new.txt", "hello");
		// Not 8n: a rejected fence bumped nothing in the database either.
		expect(stampedEpoch(h.writeFileComposite)).toBe(7n);
	});

	it("falls back to the unfenced sentinel when the dialect exposes no epoch", async () => {
		const bare = makeHarness();
		// biome-ignore lint/performance/noDelete: removing the optional member is the case under test.
		delete (bare.dialect as { getSandboxVersion?: unknown }).getSandboxVersion;
		const noEpochFs = new SqlFs({ dialect: bare.dialect, sandboxId: "s1" });
		await noEpochFs.ready();
		await noEpochFs.writeFile("/home/user/new.txt", "hello");
		expect(stampedEpoch(bare.writeFileComposite)).toBeNull();
	});
});

describe("SqlFs script scope — fenced verdict", () => {
	let fs: SqlFs;
	let h: Harness;

	beforeEach(async () => {
		h = makeHarness();
		fs = new SqlFs({ dialect: h.dialect, sandboxId: "s1" });
		await fs.ready();
	});

	it("rolls the scope back instead of committing when the script swallowed the fenced write (#170)", async () => {
		h.writeFileComposite.mockRejectedValueOnce(estaleepoch());
		fs.beginScriptScope();
		// Exactly what bash does with a failed command in a script without `set -e`:
		// the command reports an error, the script carries on and exits 0.
		await expect(fs.appendFile("/home/user/a.txt", "A-line\n")).rejects.toThrow("ESTALEEPOCH");

		await expect(fs.endScriptScope()).rejects.toThrow("ESTALEEPOCH");
		// The fence is a zero-row UPDATE, not a raised SQL error, so the script
		// transaction was still committable — committing it is the silent-success
		// failure mode that made #170 exit 0 with the line gone.
		expect(scriptTxOutcomes(h)).toEqual([false]);
	});

	it("refuses every later operation in a fenced scope", async () => {
		h.writeFileComposite.mockRejectedValueOnce(estaleepoch());
		fs.beginScriptScope();
		await expect(fs.writeFile("/home/user/new.txt", "x")).rejects.toThrow("ESTALEEPOCH");

		await expect(fs.mkdir("/home/user/dir")).rejects.toThrow("ESTALEEPOCH");
		expect(h.mkdirComposite).not.toHaveBeenCalled();
		expect(() => fs.getAllPaths()).toThrow("ESTALEEPOCH");

		await fs.abortScriptScope();
	});

	// Negative guard: a session with no fence verdict at all passes this on the
	// pre-#131 code too. It is here so a sticky verdict cannot wedge a warm
	// session for the rest of its life, not to prove the fix.
	it("clears the verdict so the next scope on the same session starts clean", async () => {
		h.writeFileComposite.mockRejectedValueOnce(estaleepoch());
		fs.beginScriptScope();
		await expect(fs.writeFile("/home/user/new.txt", "x")).rejects.toThrow("ESTALEEPOCH");
		await fs.abortScriptScope();

		fs.beginScriptScope();
		await expect(fs.writeFile("/home/user/new.txt", "x")).resolves.toBeUndefined();
		await expect(fs.endScriptScope()).resolves.toBeUndefined();
	});

	// Negative guard: a scope that was never fenced must still commit. Passes on
	// the pre-#131 code too — it is here to catch an over-broad fence, not to
	// prove the fix.
	it("commits a scope that was never fenced", async () => {
		fs.beginScriptScope();
		await fs.writeFile("/home/user/new.txt", "x");
		await expect(fs.endScriptScope()).resolves.toBeUndefined();
		expect(scriptTxOutcomes(h)).toEqual([true]);
	});
});

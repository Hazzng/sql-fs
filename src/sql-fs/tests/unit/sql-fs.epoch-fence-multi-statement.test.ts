/**
 * #192 — the epoch fence on the mutations that are NOT one composite CTE.
 *
 * `bulkIngest`, `mkdir -p`, `rm -r`, `cp`, `link`, `symlink`, `chmod` and
 * `utimes` issue a variable number of statements, so they cannot gate a `fence`
 * CTE the way the composites do. They take the same fence as a separate first
 * statement instead, which only fences anything if it really is first: a bump
 * issued after the writes would leave the damage done and lean entirely on the
 * rollback.
 *
 * So these tests assert ORDER, not just the throw — a fenced mutation must
 * reach the dialect as the bump and nothing else. A test that only checked
 * "SqlFs rejected" would pass on code that writes first and fences afterwards,
 * because SqlFs rolls the scope back either way.
 *
 * The SQL half (zero rows ⇒ ESTALEEPOCH, counter untouched) is in
 * `integration/epoch-fence-multi-statement.integration.test.ts`.
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

/** Every dialect method that writes. Used to assert that a fenced op issues none of them. */
const MUTATORS = [
	"createInode",
	"updateInode",
	"deleteInode",
	"incrementNlink",
	"decrementNlink",
	"insertDirent",
	"upsertDirent",
	"deleteDirent",
	"moveDirent",
	"upsertBlob",
	"bulkIngest",
	"mkdirComposite",
	"rmComposite",
	"writeFileComposite",
	"mvComposite",
] as const;

interface Harness {
	readonly dialect: SqlDialect<unknown>;
	readonly bumpSandboxVersion: ReturnType<typeof vi.fn>;
	readonly writeFileComposite: ReturnType<typeof vi.fn>;
	/** Dialect method names in call order — "bump" plus every entry of MUTATORS. */
	readonly calls: string[];
	/** COMMIT (`true`) / ROLLBACK (`false`) per tx handle. */
	readonly outcomes: Map<object, boolean>;
	readonly scriptTxs: Set<object>;
}

function makeHarness(): Harness {
	const calls: string[] = [];
	const outcomes = new Map<object, boolean>();
	const scriptTxs = new Set<object>();
	const record =
		<T>(name: string, result: T) =>
		async (): Promise<T> => {
			calls.push(name);
			return result;
		};
	const bumpSandboxVersion = vi.fn(async () => {
		calls.push("bump");
	});

	let nextInodeId = 100n;
	const writeFileComposite = vi.fn(async () => {
		calls.push("writeFileComposite");
		return 200n;
	});
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
		getSandboxVersion: vi.fn(async () => 7n as bigint | null),
		bumpSandboxVersion,
		loadAllPaths: vi.fn(async () => [
			dirEntry("/", 1n),
			dirEntry("/home", 2n),
			dirEntry("/home/user", 3n),
			fileEntry("/home/user/a.txt", 4n),
			dirEntry("/home/user/tree", 5n),
			fileEntry("/home/user/tree/leaf.txt", 6n),
		]),
		createSandbox: vi.fn(),
		deleteSandbox: vi.fn(),
		getInode: vi.fn(),
		createInode: vi.fn(async () => {
			calls.push("createInode");
			nextInodeId += 1n;
			return nextInodeId;
		}),
		updateInode: record("updateInode", undefined),
		deleteInode: record("deleteInode", undefined),
		incrementNlink: record("incrementNlink", undefined),
		decrementNlink: record("decrementNlink", 0),
		insertDirent: record("insertDirent", undefined),
		upsertDirent: record("upsertDirent", null),
		deleteDirent: record("deleteDirent", 4n),
		moveDirent: record("moveDirent", undefined),
		listDirents: vi.fn(),
		upsertBlob: record("upsertBlob", undefined),
		bulkIngest: vi.fn(async () => {
			calls.push("bulkIngest");
			return new Map<string, PathCacheEntry>();
		}),
		getBlob: vi.fn(async () => new TextEncoder().encode("base\n")),
		gcOrphanBlobs: vi.fn(),
		getBlobsForSandbox: vi.fn(async () => []),
		loadSubtreeInodes: vi.fn(async () => []),
		resolvePath: vi.fn(),
		// The production shape: the four composites exist, so writeFile/appendFile/
		// mkdir/rm/mv route through `#fencedComposite` and everything below is the
		// genuinely uncovered set.
		writeFileComposite,
		mkdirComposite: vi.fn(async () => {
			calls.push("mkdirComposite");
			return 201n;
		}),
		rmComposite: vi.fn(async () => {
			calls.push("rmComposite");
			return 202n;
		}),
		mvComposite: vi.fn(async () => {
			calls.push("mvComposite");
		}),
	} as unknown as SqlDialect<unknown>;

	return { dialect, bumpSandboxVersion, writeFileComposite, calls, outcomes, scriptTxs };
}

/** The mutations #192 found outside the fence, each as a callable on a fresh SqlFs. */
const OPS: ReadonlyArray<readonly [string, (fs: SqlFs) => Promise<void>]> = [
	["bulkIngest", (fs) => fs.bulkIngest([{ path: "/home/user/in.txt", content: new Uint8Array([1]), mode: 0o644 }])],
	["mkdir -p", (fs) => fs.mkdir("/home/user/deep/er", { recursive: true })],
	["rm -r", (fs) => fs.rm("/home/user/tree", { recursive: true })],
	["cp", (fs) => fs.cp("/home/user/a.txt", "/home/user/copy.txt")],
	["cp -r", (fs) => fs.cp("/home/user/tree", "/home/user/tree2", { recursive: true })],
	["link", (fs) => fs.link("/home/user/a.txt", "/home/user/hard.txt")],
	["symlink", (fs) => fs.symlink("/home/user/a.txt", "/home/user/soft.txt")],
	["chmod", (fs) => fs.chmod("/home/user/a.txt", 0o600)],
	["utimes", (fs) => fs.utimes("/home/user/a.txt", now, now)],
];

describe("SqlFs epoch fence — multi-statement mutations (#192)", () => {
	let fs: SqlFs;
	let h: Harness;

	beforeEach(async () => {
		h = makeHarness();
		// symlink is EPERM-by-default in production; enabled here so the path is
		// exercised rather than silently skipped.
		fs = new SqlFs({ dialect: h.dialect, sandboxId: "s1", allowSymlinks: true });
		await fs.ready();
		h.calls.length = 0;
	});

	for (const [name, op] of OPS) {
		it(`${name} bumps the pinned epoch before it issues any mutating statement`, async () => {
			await op(fs);
			expect(h.bumpSandboxVersion).toHaveBeenCalledWith(expect.anything(), "s1", 7n);
			// `mkdir -p` bumps once per segment it creates, so the count varies; what
			// must hold everywhere is that the fence leads and real writes follow.
			expect(h.calls[0]).toBe("bump");
			expect(h.calls.filter((c) => (MUTATORS as readonly string[]).includes(c)).length).toBeGreaterThan(0);
		});

		it(`${name} issues no mutating statement at all once the fence rejects`, async () => {
			h.bumpSandboxVersion.mockImplementationOnce(async () => {
				h.calls.push("bump");
				throw estaleepoch();
			});
			await expect(op(fs)).rejects.toThrow("ESTALEEPOCH");
			// The point of the ordering: the writes are unreachable, not merely
			// rolled back. Nothing here depends on anyone honouring a ROLLBACK.
			expect(h.calls).toEqual(["bump"]);
			expect(h.calls.filter((c) => (MUTATORS as readonly string[]).includes(c))).toEqual([]);
		});
	}

	it("advances the pin so a composite that follows an unfenced-path mutation matches the row it bumped", async () => {
		await fs.chmod("/home/user/a.txt", 0o600);
		await fs.writeFile("/home/user/after.txt", "x");
		// 8n, not 7n: chmod moved sandboxes.version, so a writer still stamping 7n
		// would be fenced out by its own predecessor.
		expect(h.writeFileComposite.mock.calls.at(-1)?.at(-1)).toBe(8n);
	});

	it("spends one epoch per segment mkdir -p actually creates", async () => {
		await fs.mkdir("/home/user/x/y/z", { recursive: true });
		expect(h.bumpSandboxVersion.mock.calls.map((c) => c[2])).toEqual([7n, 8n, 9n]);
	});

	// Negative guard: passes on the pre-#192 code too (which bumped nothing ever).
	// It is here so the fix cannot start spending epochs on a no-op, not to prove
	// the fix.
	it("spends no epoch on a mkdir -p that creates nothing", async () => {
		await fs.mkdir("/home/user/tree", { recursive: true });
		expect(h.bumpSandboxVersion).not.toHaveBeenCalled();
		expect(h.calls).toEqual([]);
	});

	it("rolls the scope back instead of committing when the script swallowed a fenced chmod", async () => {
		h.bumpSandboxVersion.mockRejectedValueOnce(estaleepoch());
		fs.beginScriptScope();
		// bash without `set -e`: the command fails, the script carries on, exit 0.
		await expect(fs.chmod("/home/user/a.txt", 0o600)).rejects.toThrow("ESTALEEPOCH");
		await expect(fs.endScriptScope()).rejects.toThrow("ESTALEEPOCH");
		expect([...h.scriptTxs].map((tx) => h.outcomes.get(tx) ?? "still open")).toEqual([false]);
	});

	it("refuses every later operation in a scope fenced by an unfenced-path mutation", async () => {
		h.bumpSandboxVersion.mockRejectedValueOnce(estaleepoch());
		fs.beginScriptScope();
		await expect(fs.link("/home/user/a.txt", "/home/user/hard.txt")).rejects.toThrow("ESTALEEPOCH");
		await expect(fs.writeFile("/home/user/next.txt", "x")).rejects.toThrow("ESTALEEPOCH");
		expect(h.writeFileComposite).not.toHaveBeenCalled();
		await fs.abortScriptScope();
	});

	it("leaves the pin where it was when a mutation is fenced, so the next attempt is still fenced", async () => {
		h.bumpSandboxVersion.mockRejectedValueOnce(estaleepoch());
		await expect(fs.chmod("/home/user/a.txt", 0o600)).rejects.toThrow("ESTALEEPOCH");
		await fs.chmod("/home/user/a.txt", 0o600);
		expect(h.bumpSandboxVersion.mock.calls.map((c) => c[2])).toEqual([7n, 7n]);
	});

	// Negative guard: a dialect that exposes no bump (mocks, a future backend
	// without the counter) must keep working unfenced rather than throwing. Passes
	// on the pre-#192 code too — it is here to catch an over-broad fix.
	it("runs the mutation unfenced when the dialect exposes no bump", async () => {
		const bare = makeHarness();
		// biome-ignore lint/performance/noDelete: removing the optional member is the case under test.
		delete (bare.dialect as { bumpSandboxVersion?: unknown }).bumpSandboxVersion;
		const noBump = new SqlFs({ dialect: bare.dialect, sandboxId: "s1" });
		await noBump.ready();
		bare.calls.length = 0;
		await noBump.chmod("/home/user/a.txt", 0o600);
		expect(bare.calls).toEqual(["updateInode"]);
	});
});

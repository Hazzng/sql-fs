/**
 * #192: every mutation — not just the four composites — reaches its dialect
 * carrier with the sandbox id and the pinned epoch, and the pin bookkeeping
 * around those writes stays consistent.
 *
 * The dialect half (the fence-and-advance CTEs themselves) is covered by
 * `integration/epoch-fence-coverage.integration.test.ts`; a fake dialect cannot
 * execute SQL, so what is asserted here is the half SqlFs owns: which arguments
 * each path hands the dialect, and what it records afterwards.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SqlFs } from "../../sql-fs.js";
import type { PathCacheEntry, SqlDialect } from "../../types.js";

const now = new Date("2026-01-01T00:00:00Z");
const SANDBOX = "s-fence";

function dirEntry(path: string, inodeId: bigint): { path: string } & PathCacheEntry {
	return { path, inodeId, kind: 2, mode: 0o755, size: 0, mtime: now, contentSha256: null, symlinkTarget: null };
}

function fileEntry(path: string, inodeId: bigint): { path: string } & PathCacheEntry {
	return {
		path,
		inodeId,
		kind: 1,
		mode: 0o644,
		size: 3,
		mtime: now,
		contentSha256: new Uint8Array(32).fill(0xab),
		symlinkTarget: null,
	};
}

interface Fake {
	dialect: SqlDialect<unknown>;
	/** Mirrors `sandboxes.version`: every carrier advances it, as the real CTEs do. */
	version: () => bigint;
	calls: string[];
}

/**
 * `withComposites: false` models a dialect that exposes none of the four
 * composites — the non-composite `writeFile`/`appendFile`/`mkdir`/`rm`/`mv`
 * fallbacks, unreachable on Postgres but the shape a second dialect arrives in.
 */
function makeFake(opts?: { withComposites?: boolean; startVersion?: bigint }): Fake {
	const withComposites = opts?.withComposites ?? true;
	let version = opts?.startVersion ?? 0n;
	let nextInodeId = 100n;
	const calls: string[] = [];
	const bump =
		(name: string) =>
		async (..._args: unknown[]) => {
			calls.push(name);
			version += 1n;
		};
	const dialect = {
		connect: vi.fn(),
		disconnect: vi.fn(),
		transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
		setSandboxContext: vi.fn(),
		setSandboxContextWithLock: vi.fn(),
		loadAllPaths: vi.fn(async () => [
			dirEntry("/", 1n),
			dirEntry("/home", 2n),
			dirEntry("/home/tree", 3n),
			fileEntry("/home/tree/leaf.txt", 4n),
			fileEntry("/home/file.txt", 5n),
		]),
		createSandbox: vi.fn(),
		deleteSandbox: vi.fn(),
		getSandboxEpoch: vi.fn(async () => {
			calls.push("getSandboxEpoch");
			return version;
		}),
		createInode: vi.fn(async () => {
			calls.push("createInode");
			version += 1n;
			nextInodeId += 1n;
			return nextInodeId;
		}),
		getInode: vi.fn(),
		updateInode: vi.fn(bump("updateInode")),
		deleteInode: vi.fn(),
		incrementNlink: vi.fn(bump("incrementNlink")),
		decrementNlink: vi.fn(async () => 0),
		insertDirent: vi.fn(),
		upsertDirent: vi.fn(async () => null),
		deleteDirent: vi.fn(async () => {
			calls.push("deleteDirent");
			version += 1n;
			return 4n;
		}),
		listDirents: vi.fn(),
		moveDirent: vi.fn(bump("moveDirent")),
		upsertBlob: vi.fn(),
		commitBlob: vi.fn(),
		getBlob: vi.fn(async () => new Uint8Array(0)),
		getBlobNoTx: vi.fn(async () => new Uint8Array(0)),
		gcOrphanBlobs: vi.fn(),
		getBlobsForSandbox: vi.fn(async () => []),
		loadSubtreeInodes: vi.fn(async () => []),
		bulkIngest: vi.fn(async () => {
			calls.push("bulkIngest");
			version += 1n;
			return new Map<string, PathCacheEntry>();
		}),
		resolvePath: vi.fn(),
		...(withComposites
			? {
					writeFileComposite: vi.fn(async () => {
						calls.push("writeFileComposite");
						version += 1n;
						return 201n;
					}),
					mkdirComposite: vi.fn(async () => {
						calls.push("mkdirComposite");
						version += 1n;
						return 202n;
					}),
					rmComposite: vi.fn(async () => {
						calls.push("rmComposite");
						version += 1n;
						return 4n;
					}),
					mvComposite: vi.fn(async () => {
						calls.push("mvComposite");
						version += 1n;
					}),
				}
			: {}),
	} as unknown as SqlDialect<unknown>;
	return { dialect, version: () => version, calls };
}

async function readyFs(fake: Fake, allowSymlinks = false): Promise<SqlFs> {
	const fs = new SqlFs({ dialect: fake.dialect, sandboxId: SANDBOX, allowSymlinks });
	await fs.ready();
	fake.calls.length = 0;
	return fs;
}

function mock(dialect: SqlDialect<unknown>, name: string): ReturnType<typeof vi.fn> {
	return (dialect as unknown as Record<string, ReturnType<typeof vi.fn>>)[name]!;
}

// ── The pinned epoch reaches every carrier ───────────────────────────────────

describe("#192 — non-composite writes carry the pinned epoch", () => {
	let fake: Fake;
	let fs: SqlFs;

	beforeEach(async () => {
		fake = makeFake({ startVersion: 7n });
		fs = await readyFs(fake, true);
	});

	/** Runs `op` inside a script scope pinned at 7 and returns the carrier's args. */
	async function scopedCall(name: string, op: () => Promise<void>): Promise<unknown[]> {
		fs.beginScriptScope();
		await op();
		const call = mock(fake.dialect, name).mock.calls[0];
		await fs.endScriptScope();
		return call as unknown[];
	}

	it("chmod passes sandboxId and the pinned epoch to updateInode", async () => {
		const args = await scopedCall("updateInode", () => fs.chmod("/home/file.txt", 0o600));
		expect(args).toEqual([expect.anything(), 5n, { mode: 0o600 }, SANDBOX, 7n]);
	});

	it("utimes passes sandboxId and the pinned epoch to updateInode", async () => {
		const mtime = new Date("2026-02-02T00:00:00Z");
		const args = await scopedCall("updateInode", () => fs.utimes("/home/file.txt", mtime, mtime));
		expect(args).toEqual([expect.anything(), 5n, { mtime }, SANDBOX, 7n]);
	});

	it("link passes sandboxId and the pinned epoch to incrementNlink", async () => {
		const args = await scopedCall("incrementNlink", () => fs.link("/home/file.txt", "/home/hard.txt"));
		expect(args).toEqual([expect.anything(), 5n, SANDBOX, 7n]);
	});

	it("symlink passes the pinned epoch to createInode", async () => {
		const args = await scopedCall("createInode", () => fs.symlink("/home/file.txt", "/home/soft.txt"));
		expect(args).toEqual([
			expect.anything(),
			{ sandboxId: SANDBOX, kind: 3, mode: 0o777, size: 14, symlinkTarget: "/home/file.txt" },
			7n,
		]);
	});

	it("cp of a single file passes the pinned epoch to createInode", async () => {
		const args = await scopedCall("createInode", () => fs.cp("/home/file.txt", "/home/copy.txt"));
		expect(args?.at(-1)).toBe(7n);
		expect(args?.at(-2)).toEqual(expect.objectContaining({ sandboxId: SANDBOX, kind: 1 }));
	});

	it("cp -r passes the pinned epoch on every created inode", async () => {
		fs.beginScriptScope();
		await fs.cp("/home/tree", "/home/tree-copy", { recursive: true });
		const calls = mock(fake.dialect, "createInode").mock.calls;
		await fs.endScriptScope();
		// /home/tree and /home/tree/leaf.txt
		expect(calls).toHaveLength(2);
		expect(calls.map((c) => c.at(-1))).toEqual([7n, 7n]);
	});

	it("mkdir -p passes the pinned epoch on every segment it creates", async () => {
		fs.beginScriptScope();
		await fs.mkdir("/home/a/b/c", { recursive: true });
		const calls = mock(fake.dialect, "createInode").mock.calls;
		await fs.endScriptScope();
		expect(calls).toHaveLength(3);
		expect(calls.map((c) => c.at(-1))).toEqual([7n, 7n, 7n]);
	});

	it("mkdir -p over an existing tree creates nothing and spends no epoch", async () => {
		fs.beginScriptScope();
		await fs.mkdir("/home/tree", { recursive: true });
		await fs.endScriptScope();
		expect(mock(fake.dialect, "createInode")).not.toHaveBeenCalled();
		expect(fake.version()).toBe(7n);
	});

	it("rm -r passes sandboxId and the pinned epoch on every unlink", async () => {
		fs.beginScriptScope();
		await fs.rm("/home/tree", { recursive: true });
		const calls = mock(fake.dialect, "deleteDirent").mock.calls;
		await fs.endScriptScope();
		// the subtree root, then its one child
		expect(calls).toHaveLength(2);
		expect(calls.map((c) => [c.at(-2), c.at(-1)])).toEqual([
			[SANDBOX, 7n],
			[SANDBOX, 7n],
		]);
	});

	it("bulkIngest passes sandboxId and the pinned epoch, once for the whole batch", async () => {
		fs.beginScriptScope();
		await fs.bulkIngest([
			{ path: "/home/i1.txt", content: new Uint8Array(1), mode: 0o644 },
			{ path: "/home/i2.txt", content: new Uint8Array(1), mode: 0o644 },
		]);
		const calls = mock(fake.dialect, "bulkIngest").mock.calls;
		await fs.endScriptScope();
		expect(calls).toHaveLength(1);
		expect(calls[0]?.at(-2)).toBe(SANDBOX);
		expect(calls[0]?.at(-1)).toBe(7n);
	});
});

// ── Non-composite fallbacks (a dialect without composites) ───────────────────

describe("#192 — the non-composite fallbacks are fenced too", () => {
	let fake: Fake;
	let fs: SqlFs;

	beforeEach(async () => {
		fake = makeFake({ withComposites: false, startVersion: 3n });
		fs = await readyFs(fake);
	});

	it("writeFile's fallback passes the pinned epoch to createInode", async () => {
		fs.beginScriptScope();
		await fs.writeFile("/home/new.txt", "x");
		const args = mock(fake.dialect, "createInode").mock.calls[0];
		await fs.endScriptScope();
		expect(args?.at(-1)).toBe(3n);
	});

	it("appendFile's fallback passes the pinned epoch to createInode", async () => {
		fs.beginScriptScope();
		await fs.appendFile("/home/file.txt", "x");
		const args = mock(fake.dialect, "createInode").mock.calls[0];
		await fs.endScriptScope();
		expect(args?.at(-1)).toBe(3n);
	});

	it("mkdir's fallback passes the pinned epoch to createInode", async () => {
		fs.beginScriptScope();
		await fs.mkdir("/home/plain");
		const args = mock(fake.dialect, "createInode").mock.calls[0];
		await fs.endScriptScope();
		expect(args?.at(-1)).toBe(3n);
	});

	it("rm's fallback passes sandboxId and the pinned epoch to deleteDirent", async () => {
		fs.beginScriptScope();
		await fs.rm("/home/file.txt");
		const args = mock(fake.dialect, "deleteDirent").mock.calls[0];
		await fs.endScriptScope();
		expect(args).toEqual([expect.anything(), 2n, "file.txt", SANDBOX, 3n]);
	});

	it("mv's fallback passes sandboxId and the pinned epoch to moveDirent", async () => {
		fs.beginScriptScope();
		await fs.mv("/home/file.txt", "/home/moved.txt");
		const args = mock(fake.dialect, "moveDirent").mock.calls[0];
		await fs.endScriptScope();
		expect(args).toEqual([expect.anything(), 2n, "file.txt", 2n, "moved.txt", SANDBOX, 3n]);
	});
});

// ── Pin bookkeeping: the bump must not fence the writer out of its own session ─

describe("#192 — pin bookkeeping around the advancing writes", () => {
	it("re-reads the epoch after a non-scoped write, so the next scope is not ESTALE", async () => {
		const fake = makeFake({ startVersion: 4n });
		const fs = await readyFs(fake);

		await fs.chmod("/home/file.txt", 0o600);

		// Read AFTER the write: a pin taken before it would be one behind the row
		// the mutation just advanced, and the scope below would open onto ESTALE.
		expect(fake.calls).toEqual(["updateInode", "getSandboxEpoch"]);
		expect(fake.version()).toBe(5n);

		fs.beginScriptScope();
		await expect(fs.writeFile("/home/after.txt", "x")).resolves.toBeUndefined();
		await fs.endScriptScope();
	});

	it("re-reads the epoch once at the end of a scope that advanced it non-compositely", async () => {
		const fake = makeFake({ startVersion: 4n });
		const fs = await readyFs(fake);

		fs.beginScriptScope();
		await fs.chmod("/home/file.txt", 0o600);
		const before = mock(fake.dialect, "getSandboxEpoch").mock.calls.length;
		await fs.endScriptScope();
		const after = mock(fake.dialect, "getSandboxEpoch").mock.calls.length;
		expect(after - before).toBe(1);

		// And the pin it published is the post-COMMIT one, so the next scope opens.
		fs.beginScriptScope();
		await expect(fs.writeFile("/home/after.txt", "x")).resolves.toBeUndefined();
		await fs.endScriptScope();
	});

	// Negative guard: the extra read is conditional, so a composite-only script
	// (the common case) must not start paying a round trip for this fix.
	it("does not re-read the epoch at the end of a composite-only scope", async () => {
		const fake = makeFake({ startVersion: 4n });
		const fs = await readyFs(fake);

		fs.beginScriptScope();
		await fs.writeFile("/home/only-composite.txt", "x");
		const before = mock(fake.dialect, "getSandboxEpoch").mock.calls.length;
		await fs.endScriptScope();
		expect(mock(fake.dialect, "getSandboxEpoch").mock.calls.length).toBe(before);
	});

	it("does not re-read the epoch at the end of a scope that wrote nothing", async () => {
		const fake = makeFake({ startVersion: 4n });
		const fs = await readyFs(fake);

		fs.beginScriptScope();
		await fs.readFile("/home/file.txt");
		const before = mock(fake.dialect, "getSandboxEpoch").mock.calls.length;
		await fs.endScriptScope();
		expect(mock(fake.dialect, "getSandboxEpoch").mock.calls.length).toBe(before);
	});

	it("aborts the scope when the end-of-scope epoch read fails", async () => {
		const fake = makeFake({ startVersion: 4n });
		const fs = await readyFs(fake);

		fs.beginScriptScope();
		await fs.chmod("/home/file.txt", 0o600);
		expect(fs.wasDirty()).toBe(true);
		mock(fake.dialect, "getSandboxEpoch").mockRejectedValueOnce(new Error("epoch read failed"));
		await expect(fs.endScriptScope()).rejects.toThrow(/epoch read failed/);
		expect(fs.scriptScopeActive).toBe(false);
		expect(fs.scriptTxOpen).toBe(false);
		expect(fs.wasDirty()).toBe(false);
	});

	it("a bump from a peer between two scopes still fences this session", async () => {
		const fake = makeFake({ startVersion: 4n });
		const fs = await readyFs(fake);

		await fs.chmod("/home/file.txt", 0o600);
		// Another replica commits to the same sandbox.
		mock(fake.dialect, "getSandboxEpoch").mockImplementation(async () => 99n);

		fs.beginScriptScope();
		await expect(fs.writeFile("/home/after.txt", "x")).rejects.toMatchObject({ code: "ESTALE" });
		await fs.abortScriptScope();
	});
});

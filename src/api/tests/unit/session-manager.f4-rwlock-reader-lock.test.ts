/**
 * Regression tests for F4 (issue #133): rwlockEnabled=false reader/writer race.
 *
 * (a) When rwlockEnabled=false, `withSessionRead` (→ withExecLockShared) must
 *     acquire the SAME legacy single-key SET-NX lock that flag-off writers take
 *     (`execLockKey`), not run bare. This restores reader/writer mutual exclusion
 *     cross-replica AND same-replica.
 * (b) `SqlFs.reload()` is a no-op while a script scope is open, so a concurrent
 *     reload can never clobber an open writer's uncommitted in-memory cache.
 *
 * The FakeRedis below honours the same string-key + ZSET surface used by
 * session-manager.exec-lock.test.ts.
 */

import type { Redis } from "ioredis";
import { InMemoryFs } from "just-bash";
import type { IFileSystem } from "just-bash";
import { describe, expect, it, vi } from "vitest";
import { SqlFs } from "../../../sql-fs/sql-fs.js";
import type { PathCacheEntry, SqlDialect } from "../../../sql-fs/types.js";
import { execLockKey } from "../../distributed-lock.js";
import { rwLockKeys } from "../../distributed-rw-lock.js";
import { SessionManager } from "../../session-manager.js";

// ── FakeRedis (string-key + ZSET aware) ─────────────────────────────────────────

interface StringEntry {
	value: string;
	expiresAt: number;
}

class FakeRedis {
	strings = new Map<string, StringEntry>();
	zsets = new Map<string, Map<string, number>>();

	private gcStrings(): void {
		const now = Date.now();
		for (const [k, e] of this.strings) if (e.expiresAt <= now) this.strings.delete(k);
	}

	async getex(_key: string): Promise<string | null> {
		// No version counter under test — pretend the sandbox has never been
		// written so ensureFreshCache never triggers a reload via mismatch.
		return null;
	}

	async set(key: string, value: string, _px: "PX", ms: number, _nx: "NX"): Promise<"OK" | null> {
		this.gcStrings();
		if (this.strings.has(key)) return null;
		this.strings.set(key, { value, expiresAt: Date.now() + ms });
		return "OK";
	}

	async eval(script: string, numKeys: number, ...args: string[]): Promise<unknown> {
		this.gcStrings();
		const keys = args.slice(0, numKeys);
		const argv = args.slice(numKeys);

		// RENEW_SCRIPT: get == token → pexpire
		if (script.includes("pexpire")) {
			const [key] = keys as [string];
			const [token, ms] = argv as [string, string];
			const entry = this.strings.get(key);
			if (entry?.value === token) {
				entry.expiresAt = Date.now() + Number(ms);
				return 1;
			}
			return 0;
		}
		// RELEASE_SCRIPT: get == token → del
		if (script.includes("del")) {
			const [key] = keys as [string];
			const [token] = argv as [string];
			const entry = this.strings.get(key);
			if (entry?.value === token) {
				this.strings.delete(key);
				return 1;
			}
			return 0;
		}
		throw new Error(`FakeRedis: unrecognised eval script: ${script.slice(0, 60)}`);
	}
}

function asRedis(f: FakeRedis): Redis {
	return f as unknown as Redis;
}

const T = "default";

function makeCreateFs(): (tenantId: string, sandboxId: string) => Promise<IFileSystem> {
	return vi.fn((_t: string, _s: string): Promise<IFileSystem> => Promise.resolve(new InMemoryFs()));
}

// ── (a) flag-off readers take the legacy single-key lock ────────────────────────

describe("F4 — rwlockEnabled=false readers take the legacy single-key lock", () => {
	it("withSessionRead holds execLockKey() (not bare) while fn runs", async () => {
		const redis = new FakeRedis();
		const sm = new SessionManager({ createFs: makeCreateFs(), redis: asRedis(redis), rwlockEnabled: false });
		await sm.getOrCreate(T, "sbx-ro");

		let lockHeld: StringEntry | undefined;
		await sm.withSessionRead(T, "sbx-ro", async () => {
			lockHeld = redis.strings.get(execLockKey(T, "sbx-ro"));
		});

		// The legacy single-key lock was held during fn and released after.
		expect(lockHeld).toBeDefined();
		expect(redis.strings.has(execLockKey(T, "sbx-ro"))).toBe(false);
		// The RW-lock keyspace must NOT be used in flag-off mode.
		expect(redis.zsets.has(rwLockKeys(T, "sbx-ro").readers)).toBe(false);
	});

	it("a flag-off writer and reader on the same sandbox are mutually exclusive", async () => {
		const redis = new FakeRedis();
		// Two managers sharing one Redis simulate two replicas during a flag-off
		// rolling deploy. The reader replica rehydrates its session from the
		// (mock) persistent store, exactly as production does.
		const writerSm = new SessionManager({ createFs: makeCreateFs(), redis: asRedis(redis), rwlockEnabled: false });
		const readerSm = new SessionManager({
			createFs: makeCreateFs(),
			redis: asRedis(redis),
			rwlockEnabled: false,
			getSandboxMetaFn: async () => ({ owner: null, name: null, python: false, javascript: false, network: false }),
		});

		const order: string[] = [];

		const writer = writerSm.withSession(T, "sbx-mx", async () => {
			order.push("w-start");
			await new Promise((r) => setTimeout(r, 60));
			order.push("w-end");
		});

		// Let the writer acquire the single-key lock first.
		await new Promise((r) => setTimeout(r, 5));

		const reader = readerSm.withSessionRead(T, "sbx-mx", async () => {
			order.push("r-start");
			order.push("r-end");
		});

		await Promise.all([writer, reader]);
		// The reader is excluded until the writer releases the legacy lock.
		expect(order).toEqual(["w-start", "w-end", "r-start", "r-end"]);
	});
});

// ── (b) reload() is a no-op while a script scope is open ─────────────────────────

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
		loadSubtreeInodes: vi.fn(async () => [3n, 4n]),
		bulkIngest: vi.fn(),
		resolvePath: vi.fn(),
	} as unknown as SqlDialect<unknown>;
}

describe("F4 — SqlFs.reload() guard during open script scope", () => {
	it("reload() is a no-op while a script scope is open and resumes after it closes", async () => {
		const dialect = makeDialect();
		const fs = new SqlFs({ dialect, sandboxId: "s-reload" });
		await fs.ready();
		const loadAllPaths = dialect.loadAllPaths as ReturnType<typeof vi.fn>;
		loadAllPaths.mockClear();

		const pathsBefore = fs.getAllPaths().sort();

		fs.beginScriptScope();
		// A concurrent reload (e.g. a same-replica reader's ensureFreshCache on a
		// Redis blip) must be suppressed while the writer's scope is open.
		await fs.reload();
		expect(loadAllPaths).not.toHaveBeenCalled();
		expect(fs.getAllPaths().sort()).toEqual(pathsBefore);

		await fs.endScriptScope();

		// Once the scope is closed, reload() works normally again.
		await fs.reload();
		expect(loadAllPaths).toHaveBeenCalledTimes(1);
	});
});

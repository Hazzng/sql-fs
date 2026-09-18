/**
 * A script-tx whose connection dies must fail every remaining operation in the scope.
 *
 * postgres.js binds the scope's `sql` to one connection object and the pool reconnects that same
 * object for the next root-`sql` query, so a later write would run on a live but transaction-less
 * connection and self-commit outside the scope. Load testing measured 599 of 600 files durable on
 * a bulk write that answered HTTP 500 — the inverse of the atomicity the route promises. Reachable
 * with no admin action: `idle_in_transaction_session_timeout` plus a script that pauses between
 * writes, since the scope pins one backend `idle in transaction` for the whole script.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SqlFs } from "../sql-fs.js";
import type { PathCacheEntry, SqlDialect } from "../types.js";

const now = new Date("2026-01-01T00:00:00Z");

function rootDir(): { path: string } & PathCacheEntry {
	return {
		path: "/",
		inodeId: 1n,
		kind: 2,
		mode: 0o755,
		size: 0,
		mtime: now,
		contentSha256: null,
		symlinkTarget: null,
	};
}

/**
 * `transaction` resolves normally until armed, so `ready()`'s own load works; once armed, the next
 * transaction is the script-tx and hangs until the test kills its connection.
 */
function makeDialect(): {
	dialect: SqlDialect<unknown>;
	arm: () => void;
	killConnection: (err: Error) => void;
} {
	let armed = false;
	let rejectTx: ((err: Error) => void) | undefined;
	const dialect = {
		connect: vi.fn(),
		disconnect: vi.fn(),
		transaction: vi.fn((fn: (tx: unknown) => Promise<unknown>) => {
			if (!armed) return fn({});
			armed = false;
			return new Promise((_resolve, reject) => {
				rejectTx = reject;
				void fn({});
			});
		}),
		setSandboxContext: vi.fn(),
		setSandboxContextWithLock: vi.fn(),
		loadAllPaths: vi.fn(async () => [rootDir()]),
		getBlobsForSandbox: vi.fn(async () => []),
		createSandbox: vi.fn(),
		deleteSandbox: vi.fn(),
		getSandboxEpoch: vi.fn(async () => 0n),
		createInode: vi.fn(async () => 101n),
		getInode: vi.fn(),
		loadSubtreeInodes: vi.fn(async () => []),
		bulkIngest: vi.fn(),
		resolvePath: vi.fn(),
		writeFileComposite: vi.fn(async () => 102n),
		commitBlob: vi.fn(),
	} as unknown as SqlDialect<unknown>;
	return {
		dialect,
		arm: () => {
			armed = true;
		},
		killConnection: (err) => rejectTx?.(err),
	};
}

/** Like `makeDialect`, but the script-tx's context statement parks until the test releases it. */
function makeGatedDialect(): {
	dialect: SqlDialect<unknown>;
	opening: Promise<void>;
	releaseContext: () => void;
} {
	let reached!: () => void;
	const opening = new Promise<void>((r) => {
		reached = r;
	});
	let release!: () => void;
	const parked = new Promise<void>((r) => {
		release = r;
	});
	const { dialect } = makeDialect();
	(dialect as { setSandboxContextWithLock: unknown }).setSandboxContextWithLock = vi.fn(async () => {
		reached();
		await parked;
	});
	(dialect as { transaction: unknown }).transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({}));
	return { dialect, opening, releaseContext: () => release() };
}

describe("script-tx connection loss", () => {
	let dialect: SqlDialect<unknown>;
	let arm: () => void;
	let killConnection: (err: Error) => void;
	let fs: SqlFs;

	beforeEach(async () => {
		({ dialect, arm, killConnection } = makeDialect());
		fs = new SqlFs({ dialect, sandboxId: "s-lost" });
		await fs.ready();
		arm();
	});

	it("refuses later writes instead of self-committing them outside the scope", async () => {
		fs.beginScriptScope();
		// Runs inside the live transaction, so it succeeds here and is lost to the rollback later.
		await fs.writeFile("/f1.txt", "a");
		const callsBeforeLoss = (dialect.writeFileComposite as ReturnType<typeof vi.fn>).mock.calls.length;

		killConnection(new Error("CONNECTION_CLOSED"));
		await new Promise((r) => setImmediate(r));

		// The write that used to reconnect the same connection object and autocommit.
		await expect(fs.writeFile("/f2.txt", "b")).rejects.toThrow("CONNECTION_CLOSED");
		// Proven at the dialect boundary: nothing further was handed to the dead connection.
		expect((dialect.writeFileComposite as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBeforeLoss);
	});

	it("reports failure from endScriptScope rather than committing a reopened transaction", async () => {
		fs.beginScriptScope();
		const first = fs.writeFile("/lost.txt", "a").catch(() => undefined);
		await new Promise((r) => setImmediate(r));
		killConnection(new Error("CONNECTION_CLOSED"));
		await first;

		await expect(fs.writeFile("/kept.txt", "b")).rejects.toThrow("CONNECTION_CLOSED");
		await expect(fs.endScriptScope()).rejects.toThrow("CONNECTION_CLOSED");
	});

	// Cache-served reads bypass the transaction helpers entirely, so without the same liveness check
	// they hand back mutations the rollback is about to erase.
	it("refuses cache-served reads once the transaction is gone", async () => {
		fs.beginScriptScope();
		await fs.writeFile("/f1.txt", "a");
		killConnection(new Error("CONNECTION_CLOSED"));
		await new Promise((r) => setImmediate(r));

		// Every one of these is served from the in-memory caches, not the dialect.
		await expect(fs.stat("/f1.txt")).rejects.toThrow("CONNECTION_CLOSED");
		await expect(fs.readFile("/f1.txt")).rejects.toThrow("CONNECTION_CLOSED");
		await expect(fs.readdir("/")).rejects.toThrow("CONNECTION_CLOSED");
		await expect(fs.exists("/f1.txt")).rejects.toThrow("CONNECTION_CLOSED");
		expect(() => fs.getAllPaths()).toThrow("CONNECTION_CLOSED");
	});

	// An abort can beat a queued open. If the statement then resolves and adopts its transaction,
	// the NEXT scope inherits a rolled-back handle and commits into a transaction that is gone.
	it("does not let a late-arriving open adopt into the next scope", async () => {
		const gated = makeGatedDialect();
		const fs2 = new SqlFs({ dialect: gated.dialect, sandboxId: "s-late" });
		await fs2.ready();

		fs2.beginScriptScope();
		const parked = fs2.writeFile("/parked.txt", "a").catch(() => undefined);
		await gated.opening;
		await fs2.abortScriptScope();

		// The queued statement lands only now, after the scope is gone.
		gated.releaseContext();
		await parked;
		await new Promise((r) => setImmediate(r));

		const opensBefore = (gated.dialect.transaction as ReturnType<typeof vi.fn>).mock.calls.length;
		fs2.beginScriptScope();
		await fs2.writeFile("/fresh.txt", "b").catch(() => undefined);
		// A transaction of its own, rather than the abandoned one.
		expect((gated.dialect.transaction as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(opensBefore);
	});

	it("starts clean on the next scope", async () => {
		fs.beginScriptScope();
		const first = fs.writeFile("/f1.txt", "a").catch(() => undefined);
		await new Promise((r) => setImmediate(r));
		killConnection(new Error("CONNECTION_CLOSED"));
		await first;
		await fs.endScriptScope().catch(() => undefined);

		// A fresh scope must not inherit the previous scope's failure.
		fs.beginScriptScope();
		expect(fs.scriptScopeActive).toBe(true);
		await expect(fs.endScriptScope()).resolves.toBeUndefined();
	});
});

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
		createInode: vi.fn(async () => 101n),
		getInode: vi.fn(),
		loadSubtreeInodes: vi.fn(async () => []),
		bulkIngest: vi.fn(),
		resolvePath: vi.fn(),
		writeFileComposite: vi.fn(async () => ({ inodeId: 102n, created: true })),
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

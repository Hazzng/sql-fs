/**
 * #169 M3/M4: what a condemned script scope must NOT do.
 *
 * `#scriptTxLost` is set by the driver-fault race and is sticky for the rest of the scope, but two
 * gaps let a condemned scope keep touching the database:
 *
 *  - M3: `endScriptScope` never checked it. Every later fs op throws via `#assertScriptTxAlive`,
 *    and bash swallows those into a nonzero exit rather than rejecting — so the exec path still
 *    calls `endScriptScope`, which COMMITTED the part of the script that had landed and reported
 *    success. The class doc for `#scriptTxLost` states the opposite invariant.
 *  - M4: `writeFile`/`appendFile` awaited `commitBlob` — a root-`sql` statement — BEFORE
 *    `#withBareTx` reached the liveness assert, so a write in a condemned scope still put a
 *    statement on the wire.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { reportDriverFault } from "../driver-fault.js";
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

/** Verbatim from a live crash of the FAULT load-test replica. */
function driverFault(): TypeError {
	const err = new TypeError("Cannot read properties of null (reading 'write')");
	err.stack = [
		"TypeError: Cannot read properties of null (reading 'write')",
		"    at Immediate.nextWrite (file:///app/node_modules/postgres/src/connection.js:255:22)",
		"    at process.processImmediate (node:internal/timers:505:21)",
	].join("\n");
	return err;
}

interface Recorder {
	/** One entry per SCRIPT transaction whose callback returned (COMMIT). */
	readonly committed: string[];
	/** One entry per SCRIPT transaction whose callback threw (ROLLBACK). */
	readonly rolledBack: string[];
	readonly commitBlobCalls: () => number;
}

function makeDialect(): { dialect: SqlDialect<unknown>; record: Recorder; armStuckWrite: () => void } {
	let stuck = false;
	const committed: string[] = [];
	const rolledBack: string[] = [];
	const commitBlob = vi.fn(async () => {});
	// Only the script transaction takes the advisory lock, so this is what tells it apart from
	// the plain read transactions `reload()` issues on the same fake.
	const scriptTxs = new WeakSet<object>();
	const dialect = {
		connect: vi.fn(),
		disconnect: vi.fn(),
		// A real transaction commits when the callback returns and rolls back when it throws;
		// the script-tx callback parks on `endPromise`, so this is what distinguishes the two.
		transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
			const tx = {};
			try {
				const out = await fn(tx);
				if (scriptTxs.has(tx)) committed.push("commit");
				return out;
			} catch (err) {
				if (scriptTxs.has(tx)) rolledBack.push("rollback");
				throw err;
			}
		}),
		setSandboxContext: vi.fn(),
		getSandboxEpoch: vi.fn(async () => 0n),
		setSandboxContextWithLock: vi.fn(async (tx: object) => {
			scriptTxs.add(tx);
		}),
		loadAllPaths: vi.fn(async () => [rootDir()]),
		getBlobsForSandbox: vi.fn(async () => []),
		createSandbox: vi.fn(),
		deleteSandbox: vi.fn(),
		createInode: vi.fn(async () => 101n),
		getInode: vi.fn(),
		loadSubtreeInodes: vi.fn(async () => []),
		bulkIngest: vi.fn(),
		resolvePath: vi.fn(),
		writeFileComposite: vi.fn(() => (stuck ? new Promise<never>(() => {}) : Promise.resolve(102n))),
		commitBlob,
	} as unknown as SqlDialect<unknown>;
	return {
		dialect,
		record: { committed, rolledBack, commitBlobCalls: () => commitBlob.mock.calls.length },
		armStuckWrite: () => {
			stuck = true;
		},
	};
}

describe("a script scope condemned by a driver fault", () => {
	let dialect: SqlDialect<unknown>;
	let record: Recorder;
	let armStuckWrite: () => void;
	let fs: SqlFs;

	beforeEach(async () => {
		({ dialect, record, armStuckWrite } = makeDialect());
		fs = new SqlFs({ dialect, sandboxId: "s-driver-fault-scope" });
		await fs.ready();
		vi.useFakeTimers();
	});

	/** Opens a scope, starts a write the driver drops, and lets the fault condemn it. */
	async function condemnScope(): Promise<void> {
		fs.beginScriptScope();
		armStuckWrite();
		const stuck = fs.writeFile("/f1.txt", "a");
		const assertion = expect(stuck).rejects.toMatchObject({ code: "EDRIVERFAULT" });
		await vi.advanceTimersByTimeAsync(0);
		reportDriverFault(driverFault());
		await vi.advanceTimersByTimeAsync(5_000);
		await assertion;
		vi.useRealTimers();
	}

	it("rolls back instead of committing when endScriptScope is called", async () => {
		await condemnScope();

		await expect(fs.endScriptScope()).rejects.toMatchObject({ code: "EDRIVERFAULT" });

		expect(record.committed).toEqual([]); // the script transaction never committed
		expect(record.rolledBack).toEqual(["rollback"]);
		expect(fs.scriptScopeActive).toBe(false);
		expect(fs.scriptTxOpen).toBe(false);
	});

	it("leaves the next scope usable after the condemned one ends", async () => {
		await condemnScope();
		await expect(fs.endScriptScope()).rejects.toMatchObject({ code: "EDRIVERFAULT" });

		fs.beginScriptScope();
		await expect(fs.endScriptScope()).resolves.toBeUndefined();
	});

	it("puts no commitBlob statement on the wire for a write in the condemned scope", async () => {
		await condemnScope();
		const before = record.commitBlobCalls();

		await expect(fs.writeFile("/f2.txt", "b")).rejects.toMatchObject({ code: "EDRIVERFAULT" });
		await expect(fs.appendFile("/f2.txt", "c")).rejects.toMatchObject({ code: "EDRIVERFAULT" });

		expect(record.commitBlobCalls()).toBe(before);
	});
});

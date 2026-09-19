/**
 * A driver fault (#169) that lands while SqlFs is awaiting the driver must fail the operation.
 *
 * `postgres.js` throws out of its own socket-write path INSTEAD of rejecting the query it was
 * writing, so that query's promise never settles — not on connection close (that handler already
 * ran), not on the exec timeout's AbortSignal (the await is not abortable). Sibling case to
 * `sql-fs.script-tx-lost.test.ts`: there the connection loss arrives as a rejection and the scope
 * fails closed on its own; here nothing ever arrives, which is the shape that turns a suppressed
 * crash into a silent 120-second hang.
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

/** `writeFileComposite` parks forever once armed — the query the driver dropped on the floor. */
function makeDialect(): { dialect: SqlDialect<unknown>; armStuckWrite: () => void } {
	let stuck = false;
	const dialect = {
		connect: vi.fn(),
		disconnect: vi.fn(),
		transaction: vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn({})),
		setSandboxContext: vi.fn(),
		getSandboxEpoch: vi.fn(async () => 0n),
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
		writeFileComposite: vi.fn(() => (stuck ? new Promise<never>(() => {}) : Promise.resolve(102n))),
		commitBlob: vi.fn(),
	} as unknown as SqlDialect<unknown>;
	return {
		dialect,
		armStuckWrite: () => {
			stuck = true;
		},
	};
}

describe("driver fault during a SqlFs operation", () => {
	let dialect: SqlDialect<unknown>;
	let armStuckWrite: () => void;
	let fs: SqlFs;

	beforeEach(async () => {
		({ dialect, armStuckWrite } = makeDialect());
		fs = new SqlFs({ dialect, sandboxId: "s-driver-fault" });
		await fs.ready();
		vi.useFakeTimers();
	});

	it("fails a write the driver dropped instead of leaving it pending", async () => {
		armStuckWrite();
		const stuck = fs.writeFile("/f.txt", "a");
		const assertion = expect(stuck).rejects.toMatchObject({ code: "EDRIVERFAULT" });
		await vi.advanceTimersByTimeAsync(0);

		reportDriverFault(driverFault());
		await vi.advanceTimersByTimeAsync(5_000);

		await assertion;
		vi.useRealTimers();
	});

	// The scope's transaction is on a connection that is at best suspect, so the rest of the script
	// must fail closed rather than reopen and commit half of it — same verdict as #scriptTxLost.
	it("makes the verdict sticky for the rest of a script scope", async () => {
		fs.beginScriptScope();
		armStuckWrite();
		const stuck = fs.writeFile("/f1.txt", "a");
		const assertion = expect(stuck).rejects.toMatchObject({ code: "EDRIVERFAULT" });
		await vi.advanceTimersByTimeAsync(0);

		reportDriverFault(driverFault());
		await vi.advanceTimersByTimeAsync(5_000);
		await assertion;

		vi.useRealTimers();
		// Cache-served reads and further writes are both refused, and no further statement reaches
		// the dialect.
		const callsAfterLoss = (dialect.writeFileComposite as ReturnType<typeof vi.fn>).mock.calls.length;
		await expect(fs.writeFile("/f2.txt", "b")).rejects.toMatchObject({ code: "EDRIVERFAULT" });
		await expect(fs.readFile("/f1.txt")).rejects.toMatchObject({ code: "EDRIVERFAULT" });
		expect((dialect.writeFileComposite as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterLoss);
	});

	it("leaves an unaffected later scope working", async () => {
		fs.beginScriptScope();
		armStuckWrite();
		const stuck = fs.writeFile("/f1.txt", "a");
		const assertion = expect(stuck).rejects.toMatchObject({ code: "EDRIVERFAULT" });
		await vi.advanceTimersByTimeAsync(0);
		reportDriverFault(driverFault());
		await vi.advanceTimersByTimeAsync(5_000);
		await assertion;

		vi.useRealTimers();
		await fs.abortScriptScope();

		fs.beginScriptScope();
		expect(fs.scriptScopeActive).toBe(true);
		await expect(fs.endScriptScope()).resolves.toBeUndefined();
	});
});

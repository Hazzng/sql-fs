/**
 * Recogniser + grace-window unit tests for the #169 driver-fault guard.
 *
 * The process-level half (does the replica survive?) is NOT testable here — vitest owns
 * `uncaughtException` — and lives in `driver-fault.guard.test.ts` as child processes.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { isDriverSocketFault, raceDriverFault, reportDriverFault } from "../driver-fault.js";

/** Verbatim from a live crash of the FAULT load-test replica (`scripts/loadtest/.run/fault.log`). */
const REAL_STACK = [
	"TypeError: Cannot read properties of null (reading 'write')",
	"    at Immediate.nextWrite (file:///app/node_modules/.pnpm/postgres@3.4.9/node_modules/postgres/src/connection.js:255:22)",
	"    at process.processImmediate (node:internal/timers:505:21)",
].join("\n");

function withStack<E extends Error>(err: E, stack: string): E {
	err.stack = stack;
	return err;
}

const realFault = (): TypeError =>
	withStack(new TypeError("Cannot read properties of null (reading 'write')"), REAL_STACK);

afterEach(() => {
	vi.useRealTimers();
});

describe("isDriverSocketFault", () => {
	it("recognises the driver's setImmediate socket-write fault", () => {
		expect(isDriverSocketFault(realFault())).toBe(true);
	});

	it("recognises the synchronous execute -> write(Sync) variant of the same frame", () => {
		const stack = [
			"TypeError: Cannot read properties of null (reading 'write')",
			"    at nextWrite (/app/node_modules/postgres/src/connection.js:255:22)",
			"    at write (/app/node_modules/postgres/src/connection.js:249:14)",
			"    at execute (/app/node_modules/postgres/src/connection.js:179:24)",
		].join("\n");
		expect(
			isDriverSocketFault(withStack(new TypeError("Cannot read properties of null (reading 'write')"), stack)),
		).toBe(true);
	});

	it("rejects the same message and class thrown from our own code", () => {
		const stack = [
			"TypeError: Cannot read properties of null (reading 'write')",
			"    at writeChunk (/app/dist/sql-fs/sql-fs.js:1234:18)",
		].join("\n");
		expect(
			isDriverSocketFault(withStack(new TypeError("Cannot read properties of null (reading 'write')"), stack)),
		).toBe(false);
	});

	it("rejects a non-TypeError raised through the same driver frame", () => {
		expect(isDriverSocketFault(withStack(new Error("boom"), REAL_STACK))).toBe(false);
	});

	it("rejects a driver error from a different driver frame", () => {
		const stack = [
			"Error: CONNECTION_CLOSED",
			"    at closed (/app/node_modules/postgres/src/connection.js:453:20)",
		].join("\n");
		expect(isDriverSocketFault(withStack(new Error("CONNECTION_CLOSED"), stack))).toBe(false);
	});

	it("rejects a stack that merely mentions nextWrite in the message", () => {
		const err = withStack(
			new TypeError("nextWrite (postgres/src/connection.js:255) failed"),
			"TypeError: x\n    at foo (/app/x.js:1:1)",
		);
		expect(isDriverSocketFault(err)).toBe(false);
	});

	it("rejects non-errors", () => {
		expect(isDriverSocketFault("Cannot read properties of null (reading 'write')")).toBe(false);
		expect(isDriverSocketFault(undefined)).toBe(false);
		expect(isDriverSocketFault({ stack: REAL_STACK })).toBe(false);
	});
});

describe("raceDriverFault", () => {
	it("passes a resolved value straight through", async () => {
		await expect(raceDriverFault(async () => 42)).resolves.toBe(42);
	});

	it("passes a rejection straight through", async () => {
		await expect(raceDriverFault(async () => Promise.reject(new Error("db said no")))).rejects.toThrow("db said no");
	});

	it("fails a never-settling call with EDRIVERFAULT once the grace window expires", async () => {
		vi.useFakeTimers();
		const stuck = raceDriverFault(() => new Promise<never>(() => {}));
		const assertion = expect(stuck).rejects.toMatchObject({ code: "EDRIVERFAULT" });

		reportDriverFault(realFault());
		await vi.advanceTimersByTimeAsync(5_000);

		await assertion;
	});

	// The whole point of the grace window: a fault on one connection must not fail a healthy query
	// that is still on the wire on another, because that query may commit anyway.
	it("lets a call that settles inside the grace window succeed after a fault", async () => {
		vi.useFakeTimers();
		let settle!: (v: string) => void;
		const result = raceDriverFault(
			() =>
				new Promise<string>((r) => {
					settle = r;
				}),
		);

		reportDriverFault(realFault());
		await vi.advanceTimersByTimeAsync(100);
		settle("committed");

		await expect(result).resolves.toBe("committed");
	});

	it("does not fail a call when no fault is reported", async () => {
		vi.useFakeTimers();
		let settle!: (v: string) => void;
		const result = raceDriverFault(
			() =>
				new Promise<string>((r) => {
					settle = r;
				}),
		);

		await vi.advanceTimersByTimeAsync(60_000);
		settle("fine");

		await expect(result).resolves.toBe("fine");
	});

	it("unsubscribes when the call settles, so a later fault cannot resurrect it", async () => {
		vi.useFakeTimers();
		await expect(raceDriverFault(async () => "done")).resolves.toBe("done");

		// No waiter is left: reporting must be a no-op rather than throwing into a dead listener.
		expect(() => reportDriverFault(realFault())).not.toThrow();
		await vi.advanceTimersByTimeAsync(60_000);
	});
});

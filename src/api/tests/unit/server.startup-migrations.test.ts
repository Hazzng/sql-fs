/**
 * #169 M5: boot migrations must be raced against a driver fault.
 *
 * Before the guard, a driver fault during `runMigrations` was an uncaught exception: the process
 * died with exit 1 and the orchestrator restarted it. With the guard absorbing that frame and
 * nothing settling the query the driver dropped, an unraced `runMigrations` never returns — the
 * replica never reaches `listen`, so there is no health check to fail and no restart. Suppressing
 * the crash without racing the await turns a loud failure into a silent hang, which is the exact
 * invariant this change states.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Never settles: the shape of a query postgres.js threw out of its socket write instead of rejecting. */
const hangingMigrations = vi.fn(() => new Promise<void>(() => {}));

vi.mock("../../migrations.js", () => ({
	runMigrations: (...args: unknown[]) => hangingMigrations(...(args as [])),
}));

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

describe("runStartupMigrations", () => {
	beforeEach(() => {
		hangingMigrations.mockClear();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
	});

	it("fails with EDRIVERFAULT instead of hanging forever when the driver drops the query", async () => {
		const { runStartupMigrations } = await import("../../server.js");
		const { reportDriverFault } = await import("../../../sql-fs/driver-fault.js");

		const booting = runStartupMigrations();
		const assertion = expect(booting).rejects.toMatchObject({ code: "EDRIVERFAULT" });
		await vi.advanceTimersByTimeAsync(0);

		reportDriverFault(driverFault());
		await vi.advanceTimersByTimeAsync(5_000);

		await assertion;
		expect(hangingMigrations).toHaveBeenCalledTimes(1);
	});

	it("skips migrations entirely when SKIP_STARTUP_MIGRATIONS is set", async () => {
		vi.stubEnv("SKIP_STARTUP_MIGRATIONS", "true");
		const { runStartupMigrations } = await import("../../server.js");

		await expect(runStartupMigrations()).resolves.toBeUndefined();
		expect(hangingMigrations).not.toHaveBeenCalled();
	});
});

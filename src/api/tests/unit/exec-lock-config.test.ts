/**
 * Issue #173: the exec-lock acquire window must outlast the lease it waits on,
 * and its default must stay inside realistic ingress timeouts.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
	DEFAULT_ACQUIRE_TIMEOUT_MS,
	type ExecLockOptions,
	assertAcquireTimeoutAboveLeases,
	loadExecLockOptions,
} from "../../exec-lock-config.js";

const ENV_VARS = [
	"REDIS_EXEC_LOCK_LEASE_MS",
	"REDIS_EXEC_LOCK_RENEW_MS",
	"REDIS_EXEC_LOCK_ACQUIRE_TIMEOUT_MS",
	"REDIS_EXEC_LOCK_ACQUIRE_RETRY_MS",
	"REDIS_RWLOCK_READER_LEASE_MS",
] as const;

afterEach(() => {
	for (const name of ENV_VARS) delete process.env[name];
});

const opts = (over: Partial<ExecLockOptions> = {}): ExecLockOptions => ({
	leaseMs: 60_000,
	renewMs: 20_000,
	acquireTimeoutMs: 75_000,
	acquireRetryMs: 50,
	readerLeaseMs: 60_000,
	...over,
});

describe("loadExecLockOptions", () => {
	it("defaults the acquire timeout to 75s", () => {
		expect(loadExecLockOptions().acquireTimeoutMs).toBe(75_000);
	});

	it("exports the same default it applies", () => {
		expect(DEFAULT_ACQUIRE_TIMEOUT_MS).toBe(75_000);
	});

	it("returns the full default option set when no env var is set", () => {
		expect(loadExecLockOptions()).toEqual({
			leaseMs: 60_000,
			renewMs: 20_000,
			acquireTimeoutMs: 75_000,
			acquireRetryMs: 50,
			readerLeaseMs: 60_000,
		});
	});

	it("honors an explicit acquire timeout above the lease", () => {
		process.env.REDIS_EXEC_LOCK_ACQUIRE_TIMEOUT_MS = "120000";
		expect(loadExecLockOptions().acquireTimeoutMs).toBe(120_000);
	});

	it("refuses to boot when the acquire timeout is below the configured lease", () => {
		process.env.REDIS_EXEC_LOCK_LEASE_MS = "90000";
		expect(() => loadExecLockOptions()).toThrow(/must be strictly greater than REDIS_EXEC_LOCK_LEASE_MS/);
	});

	it("refuses to boot when the acquire timeout is below the configured reader lease", () => {
		process.env.REDIS_RWLOCK_READER_LEASE_MS = "90000";
		expect(() => loadExecLockOptions()).toThrow(/must be strictly greater than REDIS_RWLOCK_READER_LEASE_MS/);
	});
});

describe("assertAcquireTimeoutAboveLeases", () => {
	it("accepts an acquire timeout one millisecond above both leases", () => {
		expect(() => assertAcquireTimeoutAboveLeases(opts({ acquireTimeoutMs: 60_001 }))).not.toThrow();
	});

	it("throws when the acquire timeout equals the lease", () => {
		expect(() => assertAcquireTimeoutAboveLeases(opts({ acquireTimeoutMs: 60_000 }))).toThrow(
			/REDIS_EXEC_LOCK_ACQUIRE_TIMEOUT_MS \(60000\) must be strictly greater than REDIS_EXEC_LOCK_LEASE_MS \(60000\)/,
		);
	});

	it("throws when the acquire timeout is below the lease", () => {
		expect(() => assertAcquireTimeoutAboveLeases(opts({ acquireTimeoutMs: 30_000, readerLeaseMs: 1_000 }))).toThrow(
			/must be strictly greater than REDIS_EXEC_LOCK_LEASE_MS \(60000\)/,
		);
	});

	it("throws when the acquire timeout equals the reader lease", () => {
		expect(() =>
			assertAcquireTimeoutAboveLeases(opts({ leaseMs: 1_000, readerLeaseMs: 60_000, acquireTimeoutMs: 60_000 })),
		).toThrow(/must be strictly greater than REDIS_RWLOCK_READER_LEASE_MS \(60000\)/);
	});

	it("attaches the ERR_ACQUIRE_TIMEOUT_INVARIANT code", () => {
		try {
			assertAcquireTimeoutAboveLeases(opts({ acquireTimeoutMs: 1_000 }));
			expect.unreachable("should have thrown");
		} catch (err) {
			expect((err as { code?: string }).code).toBe("ERR_ACQUIRE_TIMEOUT_INVARIANT");
		}
	});

	it("explains that a shorter window makes crashed-holder recovery impossible", () => {
		expect(() => assertAcquireTimeoutAboveLeases(opts({ acquireTimeoutMs: 1_000 }))).toThrow(
			/crashed holder's lock is only reaped when its lease expires/,
		);
	});
});

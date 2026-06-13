/**
 * F5 regression: a Redis outage must make the lock *acquire* path fast-fail
 * within a short error budget (not the 300 s acquire timeout), drive the
 * process-wide circuit breaker open, and NOT regress the renew/release paths
 * (which must keep tolerating transient errors so leases aren't dropped and
 * keys aren't leaked).
 */

import type { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetRedisCircuitBreakerForTest } from "../../../redis/circuit-breaker.js";
import { LockAcquireTimeoutError, execLockKey, withDistributedLock } from "../../distributed-lock.js";

/** Redis fake that throws a connection-class error on every command (sustained outage). */
class DeadRedis {
	calls = 0;
	async set(): Promise<never> {
		this.calls += 1;
		throw new Error("connect ECONNREFUSED 127.0.0.1:6390");
	}
	async eval(): Promise<never> {
		this.calls += 1;
		throw new Error("connect ECONNREFUSED 127.0.0.1:6390");
	}
}

/**
 * Redis fake that throws for the first `failFor` commands, then succeeds. Used to
 * prove renew/release still tolerate a transient blip without dropping the lease.
 */
class FlakyRedis {
	store = new Map<string, string>();
	private remaining: number;
	constructor(failFor: number) {
		this.remaining = failFor;
	}
	async set(key: string, value: string): Promise<"OK" | null> {
		if (this.remaining-- > 0) throw new Error("ECONNREFUSED");
		if (this.store.has(key)) return null;
		this.store.set(key, value);
		return "OK";
	}
	async eval(script: string, _n: number, key: string, token: string, ms?: string): Promise<number> {
		if (this.remaining-- > 0) throw new Error("ECONNREFUSED");
		if (script.includes("del")) {
			if (this.store.get(key) === token) {
				this.store.delete(key);
				return 1;
			}
			return 0;
		}
		if (this.store.get(key) === token && ms !== undefined) return 1;
		return 0;
	}
}

function asRedis(x: unknown): Redis {
	return x as Redis;
}

const KEY = execLockKey("default", "sbx-f5");

describe("distributed-lock acquire circuit breaker (F5)", () => {
	beforeEach(() => {
		resetRedisCircuitBreakerForTest();
	});
	afterEach(() => {
		resetRedisCircuitBreakerForTest();
		vi.useRealTimers();
	});

	it("acquire fast-fails with LockAcquireTimeoutError within the error budget, NOT the 300s acquireTimeout", async () => {
		const r = new DeadRedis();
		const start = Date.now();
		await expect(
			withDistributedLock(asRedis(r), KEY, async () => "never", {
				// Real-world defaults: 300 s acquire timeout, but a 200 ms error budget.
				acquireTimeoutMs: 300_000,
				errorBudgetMs: 200,
				acquireRetryMs: 10,
			}),
		).rejects.toBeInstanceOf(LockAcquireTimeoutError);
		const elapsed = Date.now() - start;
		// Must give up on the error budget, not the 300 s acquire timeout.
		expect(elapsed).toBeLessThan(5_000);
	});

	it("opens the process-wide breaker after K consecutive failures so the NEXT acquire fast-fails immediately", async () => {
		const r = new DeadRedis();
		// First acquire burns through ≥5 failures (threshold) and opens the breaker.
		await expect(
			withDistributedLock(asRedis(r), KEY, async () => "x", {
				acquireTimeoutMs: 300_000,
				errorBudgetMs: 1_000,
				acquireRetryMs: 5,
			}),
		).rejects.toBeInstanceOf(LockAcquireTimeoutError);
		expect(r.calls).toBeGreaterThanOrEqual(5);

		// Breaker is now open: the next acquire must fast-fail without retrying.
		const callsBefore = r.calls;
		const start = Date.now();
		await expect(
			withDistributedLock(asRedis(r), KEY, async () => "x", {
				acquireTimeoutMs: 300_000,
				errorBudgetMs: 1_000,
				acquireRetryMs: 5,
			}),
		).rejects.toBeInstanceOf(LockAcquireTimeoutError);
		// Open breaker short-circuits before touching Redis at all.
		expect(r.calls).toBe(callsBefore);
		expect(Date.now() - start).toBeLessThan(200);
	});

	it("renew tolerates a transient blip without dropping the lease (H4 preserved)", async () => {
		// First acquire SET succeeds (failFor=0 on acquire), but the first renew
		// eval throws once, then heals — the lock must survive.
		const r = new FlakyRedis(0);
		// Force the first renew to throw by flipping remaining after acquire.
		const result = await withDistributedLock(
			asRedis(r),
			KEY,
			async () => {
				// Inject one transient renew failure.
				(r as unknown as { remaining: number }).remaining = 1;
				await new Promise((res) => setTimeout(res, 80));
				return "ok";
			},
			{ leaseMs: 5_000, renewMs: 20, acquireTimeoutMs: 5_000, acquireRetryMs: 10, errorBudgetMs: 50 },
		);
		// The lock was held to completion despite the transient renew error.
		expect(result).toBe("ok");
	});

	it("release logs but does not throw on a transient Redis error (no key leak escalation)", async () => {
		const r = new FlakyRedis(0);
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const result = await withDistributedLock(
			asRedis(r),
			KEY,
			async () => {
				// Make the release eval throw.
				(r as unknown as { remaining: number }).remaining = 1;
				return "done";
			},
			{ leaseMs: 5_000, renewMs: 4_000, acquireTimeoutMs: 5_000, acquireRetryMs: 10, errorBudgetMs: 50 },
		);
		expect(result).toBe("done");
		const logged = errSpy.mock.calls.some((c) => String(c[0]).includes("lock_release_error"));
		expect(logged).toBe(true);
		errSpy.mockRestore();
	});

	it("a transient acquire blip that heals (below the breaker threshold) recovers within the error budget", async () => {
		// 3 thrown errors (< default threshold 5) then the SET succeeds: the
		// breaker never opens and a successful acquire resets the failure run and
		// closes any half-open state. (Full open→half-open→close timing is covered
		// deterministically in circuit-breaker.test.ts.)
		const r = new FlakyRedis(3);
		const result = await withDistributedLock(asRedis(r), KEY, async () => 7, {
			acquireTimeoutMs: 5_000,
			// Budget generous enough to outlast 3 retries at 5 ms each.
			errorBudgetMs: 1_000,
			acquireRetryMs: 5,
		});
		expect(result).toBe(7);
	});
});

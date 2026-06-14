/**
 * F9d unit tests: bounded acquire jitter + tunable retry interval.
 *
 * Covers:
 *  - `jitteredDelayMs` stays within `[retryMs/2, retryMs]` across many samples.
 *  - A configured `acquireRetryMs` is honored: acquire still succeeds when the
 *    lock frees, and still times out at `acquireTimeoutMs` when it does not.
 *  - The circuit-breaker fast-fail path is unaffected by jitter.
 */

import type { Redis } from "ioredis";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetRedisCircuitBreakerForTest } from "../../../redis/circuit-breaker.js";
import { LockAcquireTimeoutError, execLockKey, jitteredDelayMs, withDistributedLock } from "../../distributed-lock.js";

interface Entry {
	value: string;
	expiresAt: number;
}

/** Minimal token-aware Redis fake (mirrors distributed-lock.test.ts). */
class FakeRedis {
	store = new Map<string, Entry>();
	/** When true, every `set` (acquire) throws — simulates a connection-class error. */
	failSet = false;

	private gc(): void {
		const now = Date.now();
		for (const [k, e] of this.store) {
			if (e.expiresAt <= now) this.store.delete(k);
		}
	}

	async set(key: string, value: string, _px: "PX", ms: number, _nx: "NX"): Promise<"OK" | null> {
		if (this.failSet) throw new Error("redis set failed");
		this.gc();
		if (this.store.has(key)) return null;
		this.store.set(key, { value, expiresAt: Date.now() + ms });
		return "OK";
	}

	async eval(script: string, _numKeys: number, key: string, token: string, ms?: string): Promise<number> {
		this.gc();
		if (script.includes("del")) {
			const entry = this.store.get(key);
			if (entry?.value === token) {
				this.store.delete(key);
				return 1;
			}
			return 0;
		}
		const entry = this.store.get(key);
		if (entry?.value === token && ms !== undefined) {
			entry.expiresAt = Date.now() + Number(ms);
			return 1;
		}
		return 0;
	}
}

function asRedis(f: FakeRedis): Redis {
	return f as unknown as Redis;
}

const KEY = execLockKey("default", "sbx-jitter");

describe("jitteredDelayMs", () => {
	it("stays within [retryMs/2, retryMs] across many samples", () => {
		const retryMs = 50;
		for (let i = 0; i < 10_000; i++) {
			const d = jitteredDelayMs(retryMs);
			expect(d).toBeGreaterThanOrEqual(retryMs / 2);
			expect(d).toBeLessThanOrEqual(retryMs);
		}
	});

	it("hits the lower bound (retryMs/2) when random() returns 0", () => {
		const spy = vi.spyOn(Math, "random").mockReturnValue(0);
		expect(jitteredDelayMs(50)).toBe(25);
		spy.mockRestore();
	});

	it("approaches the upper bound (retryMs) as random() → 1", () => {
		const spy = vi.spyOn(Math, "random").mockReturnValue(0.999999);
		expect(jitteredDelayMs(50)).toBeCloseTo(50, 2);
		expect(jitteredDelayMs(50)).toBeLessThanOrEqual(50);
		spy.mockRestore();
	});

	it("scales with retryMs (different base → different bounds)", () => {
		const spy = vi.spyOn(Math, "random").mockReturnValue(0);
		expect(jitteredDelayMs(200)).toBe(100);
		spy.mockRestore();
	});
});

describe("acquireRetryMs is honored under jitter", () => {
	afterEach(() => {
		vi.useRealTimers();
		resetRedisCircuitBreakerForTest();
	});

	it("acquire still succeeds once the lock frees (jittered retries)", async () => {
		const r = new FakeRedis();
		let releaseFirst!: () => void;
		const hold = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});

		const first = withDistributedLock(asRedis(r), KEY, async () => hold, {
			leaseMs: 5_000,
			renewMs: 4_000,
			acquireTimeoutMs: 5_000,
			acquireRetryMs: 20,
		});
		await new Promise((res) => setTimeout(res, 20));

		const second = withDistributedLock(asRedis(r), KEY, async () => "got-it", {
			leaseMs: 5_000,
			renewMs: 4_000,
			acquireTimeoutMs: 5_000,
			acquireRetryMs: 20,
		});

		// Let the second caller poll a few jittered cycles, then release the first.
		await new Promise((res) => setTimeout(res, 80));
		releaseFirst();
		await first;
		await expect(second).resolves.toBe("got-it");
		expect(r.store.has(KEY)).toBe(false);
	});

	it("acquire still times out at acquireTimeoutMs when the lock never frees", async () => {
		const r = new FakeRedis();
		// Plant a foreign, long-lived lock so the caller can never acquire.
		r.store.set(KEY, { value: "stranger", expiresAt: Date.now() + 60_000 });

		const start = Date.now();
		await expect(
			withDistributedLock(asRedis(r), KEY, async () => "nope", {
				leaseMs: 5_000,
				renewMs: 4_000,
				acquireTimeoutMs: 120,
				acquireRetryMs: 20,
			}),
		).rejects.toBeInstanceOf(LockAcquireTimeoutError);
		// Should not return materially before the deadline (jitter only reshapes
		// the poll cadence, it does not shorten the overall timeout).
		expect(Date.now() - start).toBeGreaterThanOrEqual(110);
	});
});

describe("circuit-breaker path unaffected by jitter", () => {
	afterEach(() => {
		resetRedisCircuitBreakerForTest();
	});

	it("fast-fails on persistent thrown acquire errors via the error budget", async () => {
		const r = new FakeRedis();
		r.failSet = true; // every acquire attempt throws (connection-class error)
		await expect(
			withDistributedLock(asRedis(r), KEY, async () => "nope", {
				leaseMs: 5_000,
				renewMs: 4_000,
				acquireTimeoutMs: 60_000, // huge — only the error budget should cut it short
				acquireRetryMs: 5,
				errorBudgetMs: 50,
			}),
		).rejects.toBeInstanceOf(LockAcquireTimeoutError);
	});
});

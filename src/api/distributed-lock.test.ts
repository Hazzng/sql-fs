/**
 * Unit tests for the Redis-backed distributed lock helper.
 * Uses a small in-process fake that honors token semantics + PX expiry,
 * so we can exercise acquire/release/renew without a real Redis.
 */

import type { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LockAcquireTimeoutError, LockLostError, execLockKey, withDistributedLock } from "./distributed-lock.js";

interface Entry {
	value: string;
	expiresAt: number;
}

/**
 * Minimal Redis fake covering only the surface the distributed lock uses:
 *   - SET key value PX ms NX
 *   - EVAL RELEASE_SCRIPT 1 key token
 *   - EVAL RENEW_SCRIPT 1 key token ms
 * Token semantics are preserved — only the holder can release or renew.
 */
class FakeRedis {
	store = new Map<string, Entry>();
	/** When true, next eval throws — simulates Redis connection error. */
	failEval = false;
	/** When true, RENEW eval returns 0 (owner mismatch-like failure). */
	forceRenewLost = false;

	private gc(): void {
		const now = Date.now();
		for (const [k, e] of this.store) {
			if (e.expiresAt <= now) this.store.delete(k);
		}
	}

	async set(key: string, value: string, _px: "PX", ms: number, _nx: "NX"): Promise<"OK" | null> {
		this.gc();
		if (this.store.has(key)) return null;
		this.store.set(key, { value, expiresAt: Date.now() + ms });
		return "OK";
	}

	async eval(script: string, _numKeys: number, key: string, token: string, ms?: string): Promise<number> {
		if (this.failEval) throw new Error("redis eval failed");
		this.gc();
		if (script.includes("del")) {
			const entry = this.store.get(key);
			if (entry?.value === token) {
				this.store.delete(key);
				return 1;
			}
			return 0;
		}
		// renew
		if (this.forceRenewLost) return 0;
		const entry = this.store.get(key);
		if (entry?.value === token && ms !== undefined) {
			entry.expiresAt = Date.now() + Number(ms);
			return 1;
		}
		return 0;
	}

	/** Simulate expiry by evicting a key now. */
	evict(key: string): void {
		this.store.delete(key);
	}
}

function fake(): FakeRedis {
	return new FakeRedis();
}
function asRedis(f: FakeRedis): Redis {
	return f as unknown as Redis;
}

const KEY = execLockKey("default", "sbx-test");

describe("withDistributedLock", () => {
	beforeEach(() => {
		vi.useRealTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("basic acquire + release: key is absent after fn returns", async () => {
		const r = fake();
		const result = await withDistributedLock(asRedis(r), KEY, async () => 42);
		expect(result).toBe(42);
		expect(r.store.has(KEY)).toBe(false);
	});

	it("contention: two concurrent calls on the same key serialize", async () => {
		const r = fake();
		const order: string[] = [];

		const first = withDistributedLock(
			asRedis(r),
			KEY,
			async () => {
				order.push("first-start");
				await new Promise((res) => setTimeout(res, 80));
				order.push("first-end");
			},
			{ acquireRetryMs: 10, leaseMs: 1000, renewMs: 900, acquireTimeoutMs: 5_000 },
		);

		// Give the first call a tick to acquire before we launch the second
		await new Promise((r) => setTimeout(r, 5));

		const second = withDistributedLock(
			asRedis(r),
			KEY,
			async () => {
				order.push("second-start");
			},
			{ acquireRetryMs: 10, leaseMs: 1000, renewMs: 900, acquireTimeoutMs: 5_000 },
		);

		await Promise.all([first, second]);
		expect(order).toEqual(["first-start", "first-end", "second-start"]);
	});

	it("acquire timeout: second caller throws LockAcquireTimeoutError", async () => {
		const r = fake();
		let releaseFirst!: () => void;
		const hold = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});

		const first = withDistributedLock(
			asRedis(r),
			KEY,
			async () => {
				await hold;
			},
			{ leaseMs: 5_000, renewMs: 4_000, acquireTimeoutMs: 1_000, acquireRetryMs: 20 },
		);

		// Give first a chance to grab the lock
		await new Promise((r) => setTimeout(r, 20));

		await expect(
			withDistributedLock(asRedis(r), KEY, async () => "nope", {
				leaseMs: 5_000,
				renewMs: 4_000,
				acquireTimeoutMs: 150,
				acquireRetryMs: 20,
			}),
		).rejects.toBeInstanceOf(LockAcquireTimeoutError);

		releaseFirst();
		await first;
	});

	it("heartbeat extends the lease so a long-running fn completes", async () => {
		const r = fake();
		// leaseMs shorter than the fn duration; renewMs shorter than leaseMs keeps the key alive.
		const result = await withDistributedLock(
			asRedis(r),
			KEY,
			async () => {
				await new Promise((res) => setTimeout(res, 250));
				return "ok";
			},
			{ leaseMs: 100, renewMs: 40, acquireTimeoutMs: 5_000, acquireRetryMs: 10 },
		);
		expect(result).toBe("ok");
		expect(r.store.has(KEY)).toBe(false);
	});

	it("heartbeat failure surfaces as LockLostError", async () => {
		const r = fake();
		r.forceRenewLost = true;
		await expect(
			withDistributedLock(
				asRedis(r),
				KEY,
				async () => {
					// Long enough for at least one renew tick to run and mark as lost.
					await new Promise((res) => setTimeout(res, 80));
					return "never";
				},
				{ leaseMs: 5_000, renewMs: 20, acquireTimeoutMs: 5_000, acquireRetryMs: 10 },
			),
		).rejects.toBeInstanceOf(LockLostError);
	});

	it("release is no-op when the key is owned by a different token", async () => {
		const r = fake();
		// Manually plant a lock owned by a different token
		r.store.set(KEY, { value: "stranger-token", expiresAt: Date.now() + 10_000 });

		const first = withDistributedLock(asRedis(r), KEY, async () => "noop", {
			leaseMs: 500,
			renewMs: 400,
			acquireTimeoutMs: 50,
			acquireRetryMs: 10,
		});

		await expect(first).rejects.toBeInstanceOf(LockAcquireTimeoutError);
		// Stranger's lock untouched.
		expect(r.store.get(KEY)?.value).toBe("stranger-token");
	});

	it("exception in fn still releases the lock", async () => {
		const r = fake();
		await expect(
			withDistributedLock(asRedis(r), KEY, async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(r.store.has(KEY)).toBe(false);
	});

	describe("option validation", () => {
		it("rejects renewMs >= leaseMs (mutex invariant)", async () => {
			await expect(
				withDistributedLock(asRedis(fake()), KEY, async () => "ok", {
					leaseMs: 1_000,
					renewMs: 1_000,
				}),
			).rejects.toThrow(/renewMs .* must be strictly less than leaseMs/);

			await expect(
				withDistributedLock(asRedis(fake()), KEY, async () => "ok", {
					leaseMs: 1_000,
					renewMs: 2_000,
				}),
			).rejects.toThrow(/renewMs .* must be strictly less than leaseMs/);
		});

		it("rejects non-positive leaseMs, renewMs, acquireRetryMs", async () => {
			await expect(withDistributedLock(asRedis(fake()), KEY, async () => "ok", { leaseMs: 0 })).rejects.toThrow(
				/leaseMs must be > 0/,
			);

			await expect(withDistributedLock(asRedis(fake()), KEY, async () => "ok", { renewMs: 0 })).rejects.toThrow(
				/renewMs must be > 0/,
			);

			await expect(withDistributedLock(asRedis(fake()), KEY, async () => "ok", { acquireRetryMs: 0 })).rejects.toThrow(
				/acquireRetryMs must be > 0/,
			);
		});

		it("rejects negative acquireTimeoutMs", async () => {
			await expect(
				withDistributedLock(asRedis(fake()), KEY, async () => "ok", { acquireTimeoutMs: -1 }),
			).rejects.toThrow(/acquireTimeoutMs must be >= 0/);
		});

		it("accepts the defaults unchanged", async () => {
			// Should not throw — defaults satisfy every invariant.
			const result = await withDistributedLock(asRedis(fake()), KEY, async () => "ok");
			expect(result).toBe("ok");
		});
	});

	it("logs but does not throw when release eval fails", async () => {
		const r = fake();
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const fnDone = new Promise<void>((resolve) => {
			// Cause the very next eval (the release) to fail
			setTimeout(() => {
				r.failEval = true;
				resolve();
			}, 10);
		});
		const result = await withDistributedLock(
			asRedis(r),
			KEY,
			async () => {
				await fnDone;
				return "ok";
			},
			{ leaseMs: 5_000, renewMs: 4_000, acquireTimeoutMs: 5_000, acquireRetryMs: 10 },
		);
		expect(result).toBe("ok");
		// At least one call that contains lock_release_error
		const loggedRelease = errSpy.mock.calls.some((c) => String(c[0]).includes("lock_release_error"));
		expect(loggedRelease).toBe(true);
		errSpy.mockRestore();
	});
});

/**
 * Unit tests for the Redis-backed distributed RW lock.
 * Uses an in-process fake that honours ZSET semantics + TTL scores so we can
 * exercise every Lua-script branch without a real Redis.
 */

import type { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	LockAcquireTimeoutError,
	LockLostError,
	type RWLockKeys,
	rwLockKeys,
	withDistributedRWLock,
} from "../../distributed-rw-lock.js";

// ── FakeRedis ─────────────────────────────────────────────────────────────────

interface StringEntry {
	value: string;
	expiresAt: number;
}

/**
 * Minimal Redis fake covering only the surface the RW lock uses:
 *   - SET key value PX ms NX
 *   - EVAL with the Lua scripts (identified by content keywords)
 *   - Direct ZADD / ZSCORE / ZREM / ZCARD for test helpers
 */
class FakeRedis {
	strings = new Map<string, StringEntry>();
	zsets = new Map<string, Map<string, number>>(); // key -> (member -> score)

	/** When truthy, all eval calls throw. */
	failEval = false;
	/** When truthy, RENEW_EXCLUSIVE returns 0 (simulates flag lost). */
	forceExclusiveRenewLost = false;
	/** When truthy, RENEW_SHARED returns 0. */
	forceSharedRenewLost = false;

	// ── helpers ──────────────────────────────────────────────────────────────

	private gcStrings(): void {
		const now = Date.now();
		for (const [k, e] of this.strings) if (e.expiresAt <= now) this.strings.delete(k);
	}

	getZset(key: string): Map<string, number> {
		let z = this.zsets.get(key);
		if (!z) {
			z = new Map();
			this.zsets.set(key, z);
		}
		return z;
	}

	/** Reap expired entries from a ZSET (score = expireAt). */
	private reapZset(key: string, nowMs: number): void {
		const z = this.zsets.get(key);
		if (!z) return;
		for (const [m, score] of z) if (score <= nowMs) z.delete(m);
	}

	// ── Redis interface stubs ─────────────────────────────────────────────────

	async set(key: string, value: string, _px: "PX", ms: number, _nx: "NX"): Promise<"OK" | null> {
		this.gcStrings();
		if (this.strings.has(key)) return null;
		this.strings.set(key, { value, expiresAt: Date.now() + ms });
		return "OK";
	}

	/** Direct ZADD for test helpers only (not used by the lock internally). */
	async zadd(key: string, score: number, member: string): Promise<number> {
		const z = this.getZset(key);
		const existed = z.has(member) ? 0 : 1;
		z.set(member, score);
		return existed;
	}

	/** Direct ZSCORE for test helpers. */
	async zscore(key: string, member: string): Promise<string | null> {
		const z = this.zsets.get(key);
		const score = z?.get(member);
		return score !== undefined ? String(score) : null;
	}

	/** Direct ZCARD for test helpers. */
	async zcard(key: string): Promise<number> {
		return this.zsets.get(key)?.size ?? 0;
	}

	/** Evict a string key to simulate expiry. */
	evict(key: string): void {
		this.strings.delete(key);
	}

	// ── eval dispatcher ───────────────────────────────────────────────────────

	async eval(script: string, numKeys: number, ...args: string[]): Promise<unknown> {
		if (this.failEval) throw new Error("redis eval failed");
		this.gcStrings();

		const keys = args.slice(0, numKeys);
		const argv = args.slice(numKeys);

		// ACQUIRE_SHARED_SCRIPT — contains ZREMRANGEBYSCORE + EXISTS check
		if (script.includes("ZREMRANGEBYSCORE") && script.includes("EXISTS")) {
			const [writerKey, readersKey] = keys as [string, string];
			const [token, nowStr, expireAtStr] = argv as [string, string, string];
			const now = Number(nowStr);
			this.reapZset(readersKey, now);
			if (this.strings.has(writerKey)) return 0;
			const z = this.getZset(readersKey);
			z.set(token, Number(expireAtStr));
			return 1;
		}

		// RELEASE_SHARED_SCRIPT — contains ZREM (only)
		if (script.includes("ZREM") && !script.includes("ZREMRANGEBYSCORE")) {
			const [readersKey] = keys as [string];
			const [token] = argv as [string];
			const z = this.zsets.get(readersKey);
			if (z?.has(token)) {
				z.delete(token);
				return 1;
			}
			return 0;
		}

		// RENEW_SHARED_SCRIPT — contains ZSCORE
		if (script.includes("ZSCORE")) {
			if (this.forceSharedRenewLost) return 0;
			const [readersKey] = keys as [string];
			const [token, expireAtStr] = argv as [string, string];
			const z = this.zsets.get(readersKey);
			if (z?.has(token)) {
				z.set(token, Number(expireAtStr));
				return 1;
			}
			return 0;
		}

		// ACQUIRE_EXCLUSIVE_FLAG_SCRIPT — contains SET … NX
		if (script.includes("SET") && script.includes("NX")) {
			const [writerKey] = keys as [string];
			const [token, leaseMsStr] = argv as [string, string];
			if (this.strings.has(writerKey)) return null;
			this.strings.set(writerKey, { value: token, expiresAt: Date.now() + Number(leaseMsStr) });
			return "OK";
		}

		// CHECK_READERS_DRAINED_SCRIPT — contains GET + ZREMRANGEBYSCORE + ZCARD
		if (script.includes("ZCARD")) {
			const [writerKey, readersKey] = keys as [string, string];
			const [token, nowStr] = argv as [string, string];
			const entry = this.strings.get(writerKey);
			if (entry?.value !== token) return -1;
			this.reapZset(readersKey, Number(nowStr));
			return this.zsets.get(readersKey)?.size ?? 0;
		}

		// RENEW_EXCLUSIVE_SCRIPT — contains pexpire
		if (script.includes("pexpire")) {
			if (this.forceExclusiveRenewLost) return 0;
			const [writerKey] = keys as [string];
			const [token, leaseMsStr] = argv as [string, string];
			const entry = this.strings.get(writerKey);
			if (entry?.value === token) {
				entry.expiresAt = Date.now() + Number(leaseMsStr);
				return 1;
			}
			return 0;
		}

		// RELEASE_EXCLUSIVE_SCRIPT — contains del
		if (script.includes("del")) {
			const [writerKey] = keys as [string];
			const [token] = argv as [string];
			const entry = this.strings.get(writerKey);
			if (entry?.value === token) {
				this.strings.delete(writerKey);
				return 1;
			}
			return 0;
		}

		throw new Error(`FakeRedis: unrecognised eval script: ${script.slice(0, 60)}`);
	}
}

function fake(): FakeRedis {
	return new FakeRedis();
}
function asRedis(f: FakeRedis): Redis {
	return f as unknown as Redis;
}

const KEYS: RWLockKeys = rwLockKeys("default", "sbx-test");
const FAST: Partial<Parameters<typeof withDistributedRWLock>[4]> = {
	leaseMs: 5_000,
	renewMs: 4_000,
	acquireTimeoutMs: 3_000,
	acquireRetryMs: 10,
	readerLeaseMs: 5_000,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("withDistributedRWLock", () => {
	beforeEach(() => vi.useRealTimers());
	afterEach(() => vi.useRealTimers());

	// ── Basic smoke ───────────────────────────────────────────────────────────

	it("shared: acquires, runs fn, releases ZSET entry", async () => {
		const r = fake();
		const result = await withDistributedRWLock(asRedis(r), KEYS, "shared", async () => 42, FAST);
		expect(result).toBe(42);
		expect(r.zsets.get(KEYS.readers)?.size ?? 0).toBe(0);
	});

	it("exclusive: acquires, runs fn, releases writer flag", async () => {
		const r = fake();
		const result = await withDistributedRWLock(asRedis(r), KEYS, "exclusive", async () => 99, FAST);
		expect(result).toBe(99);
		expect(r.strings.has(KEYS.writer)).toBe(false);
	});

	// ── Parallel readers ──────────────────────────────────────────────────────

	it("two shared acquires on the same keys run concurrently (peak=2)", async () => {
		const r = fake();
		let active = 0;
		let peak = 0;

		const worker = (): Promise<void> =>
			withDistributedRWLock(
				asRedis(r),
				KEYS,
				"shared",
				async () => {
					active++;
					peak = Math.max(peak, active);
					await new Promise((res) => setTimeout(res, 40));
					active--;
				},
				FAST,
			);

		await Promise.all([worker(), worker()]);
		expect(peak).toBe(2);
	});

	// ── Mutual exclusion ──────────────────────────────────────────────────────

	it("exclusive blocks shared: reader waits while writer holds flag", async () => {
		const r = fake();
		const order: string[] = [];

		let releaseWriter!: () => void;
		const writer = withDistributedRWLock(
			asRedis(r),
			KEYS,
			"exclusive",
			async () => {
				order.push("w-start");
				await new Promise<void>((res) => {
					releaseWriter = res;
				});
				order.push("w-end");
			},
			FAST,
		);

		// Let writer acquire the flag
		await new Promise((res) => setTimeout(res, 30));

		const reader = withDistributedRWLock(
			asRedis(r),
			KEYS,
			"shared",
			async () => {
				order.push("r-start");
			},
			{ ...FAST, acquireTimeoutMs: 5_000 },
		);

		// Reader must be blocked
		await new Promise((res) => setTimeout(res, 50));
		expect(order).toEqual(["w-start"]);

		releaseWriter();
		await Promise.all([writer, reader]);
		expect(order).toEqual(["w-start", "w-end", "r-start"]);
	});

	it("shared blocks exclusive: writer waits for reader to drain", async () => {
		const r = fake();
		const order: string[] = [];

		let releaseReader!: () => void;
		const reader = withDistributedRWLock(
			asRedis(r),
			KEYS,
			"shared",
			async () => {
				order.push("r-start");
				await new Promise<void>((res) => {
					releaseReader = res;
				});
				order.push("r-end");
			},
			FAST,
		);

		await new Promise((res) => setTimeout(res, 30));

		const writer = withDistributedRWLock(
			asRedis(r),
			KEYS,
			"exclusive",
			async () => {
				order.push("w-start");
			},
			{ ...FAST, acquireTimeoutMs: 5_000 },
		);

		await new Promise((res) => setTimeout(res, 50));
		// Writer flag is set but reader still active — writer blocked in drain wait
		expect(order).not.toContain("w-start");

		releaseReader();
		await Promise.all([reader, writer]);
		expect(order).toEqual(["r-start", "r-end", "w-start"]);
	});

	// ── Writer-priority ───────────────────────────────────────────────────────

	it("writer-priority: new shared acquire waits while writer flag is held", async () => {
		const r = fake();

		// Plant writer flag directly (simulates another replica holding it)
		r.strings.set(KEYS.writer, { value: "foreign-token", expiresAt: Date.now() + 5_000 });

		const started = { reader: false };
		const readerPromise = withDistributedRWLock(
			asRedis(r),
			KEYS,
			"shared",
			async () => {
				started.reader = true;
			},
			{ ...FAST, acquireRetryMs: 10, acquireTimeoutMs: 500 },
		);

		await new Promise((res) => setTimeout(res, 50));
		expect(started.reader).toBe(false); // blocked

		r.strings.delete(KEYS.writer); // simulate writer releasing
		await readerPromise;
		expect(started.reader).toBe(true);
	});

	// ── Crashed-reader scenario (TTL reap) ────────────────────────────────────

	it("crashed reader: stale ZSET entry is reaped, exclusive acquires within 1 retry", async () => {
		const r = fake();

		// Plant an already-expired reader token directly (score = expired timestamp)
		await r.zadd(KEYS.readers, Date.now() - 1, "dead-token");

		const order: string[] = [];
		await withDistributedRWLock(
			asRedis(r),
			KEYS,
			"exclusive",
			async () => {
				order.push("w-acquired");
			},
			FAST,
		);
		expect(order).toEqual(["w-acquired"]);
	});

	// ── Heartbeat ────────────────────────────────────────────────────────────

	it("shared heartbeat renews ZSET score across at least 2 cycles", async () => {
		const r = fake();
		const renewals: number[] = [];
		const origEval = r.eval.bind(r);

		r.eval = async (script: string, numKeys: number, ...args: string[]) => {
			if (script.includes("ZSCORE")) renewals.push(Date.now());
			return origEval(script, numKeys, ...args);
		};

		await withDistributedRWLock(
			asRedis(r),
			KEYS,
			"shared",
			async () => {
				await new Promise((res) => setTimeout(res, 200));
			},
			{ ...FAST, renewMs: 60, leaseMs: 5_000 },
		);

		expect(renewals.length).toBeGreaterThanOrEqual(2);
	});

	it("exclusive heartbeat renews writer flag PTTL across at least 2 cycles", async () => {
		const r = fake();
		const renewals: number[] = [];
		const origEval = r.eval.bind(r);

		r.eval = async (script: string, numKeys: number, ...args: string[]) => {
			if (script.includes("pexpire")) renewals.push(Date.now());
			return origEval(script, numKeys, ...args);
		};

		await withDistributedRWLock(
			asRedis(r),
			KEYS,
			"exclusive",
			async () => {
				await new Promise((res) => setTimeout(res, 200));
			},
			{ ...FAST, renewMs: 60, leaseMs: 5_000 },
		);

		expect(renewals.length).toBeGreaterThanOrEqual(2);
	});

	// ── LockLostError ─────────────────────────────────────────────────────────

	it("shared: surfaces LockLostError when renew returns 0 mid-fn", async () => {
		const r = fake();
		r.forceSharedRenewLost = true;

		await expect(
			withDistributedRWLock(
				asRedis(r),
				KEYS,
				"shared",
				async () => {
					await new Promise((res) => setTimeout(res, 100));
					return "never";
				},
				{ ...FAST, renewMs: 20, leaseMs: 5_000 },
			),
		).rejects.toBeInstanceOf(LockLostError);
	});

	it("exclusive: surfaces LockLostError when writer flag is force-deleted mid-fn", async () => {
		const r = fake();
		// Force the heartbeat to detect loss
		r.forceExclusiveRenewLost = true;

		await expect(
			withDistributedRWLock(
				asRedis(r),
				KEYS,
				"exclusive",
				async () => {
					await new Promise((res) => setTimeout(res, 100));
					return "never";
				},
				{ ...FAST, renewMs: 20, leaseMs: 5_000 },
			),
		).rejects.toBeInstanceOf(LockLostError);
	});

	// ── LockAcquireTimeoutError ───────────────────────────────────────────────

	it("shared: throws LockAcquireTimeoutError when contended longer than acquireTimeoutMs", async () => {
		const r = fake();
		// Plant a permanent writer flag
		r.strings.set(KEYS.writer, { value: "other", expiresAt: Date.now() + 60_000 });

		await expect(
			withDistributedRWLock(asRedis(r), KEYS, "shared", async () => "nope", {
				...FAST,
				acquireTimeoutMs: 100,
				acquireRetryMs: 10,
			}),
		).rejects.toBeInstanceOf(LockAcquireTimeoutError);
	});

	it("exclusive: throws LockAcquireTimeoutError when another writer holds the flag", async () => {
		const r = fake();
		r.strings.set(KEYS.writer, { value: "other", expiresAt: Date.now() + 60_000 });

		await expect(
			withDistributedRWLock(asRedis(r), KEYS, "exclusive", async () => "nope", {
				...FAST,
				acquireTimeoutMs: 100,
				acquireRetryMs: 10,
			}),
		).rejects.toBeInstanceOf(LockAcquireTimeoutError);
	});

	it("exclusive: throws LockAcquireTimeoutError when readers never drain", async () => {
		const r = fake();
		// Plant a live reader that will never expire within acquireTimeoutMs
		await r.zadd(KEYS.readers, Date.now() + 60_000, "live-token");

		await expect(
			withDistributedRWLock(asRedis(r), KEYS, "exclusive", async () => "nope", {
				...FAST,
				acquireTimeoutMs: 150,
				acquireRetryMs: 10,
			}),
		).rejects.toBeInstanceOf(LockAcquireTimeoutError);

		// Writer flag must be cleaned up in finally even on timeout
		expect(r.strings.has(KEYS.writer)).toBe(false);
	});

	// ── Error handling ────────────────────────────────────────────────────────

	it("exception in fn still releases shared lock", async () => {
		const r = fake();
		await expect(
			withDistributedRWLock(
				asRedis(r),
				KEYS,
				"shared",
				async () => {
					throw new Error("boom");
				},
				FAST,
			),
		).rejects.toThrow("boom");
		expect(r.zsets.get(KEYS.readers)?.size ?? 0).toBe(0);
	});

	it("exception in fn still releases exclusive lock", async () => {
		const r = fake();
		await expect(
			withDistributedRWLock(
				asRedis(r),
				KEYS,
				"exclusive",
				async () => {
					throw new Error("boom");
				},
				FAST,
			),
		).rejects.toThrow("boom");
		expect(r.strings.has(KEYS.writer)).toBe(false);
	});

	it("release errors are logged but not rethrown", async () => {
		const r = fake();
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		// After fn completes, make the next eval (the release) throw
		let fnDone = false;
		const origEval = r.eval.bind(r);
		r.eval = async (script: string, numKeys: number, ...args: string[]) => {
			if (fnDone && script.includes("ZREM") && !script.includes("ZREMRANGEBYSCORE")) {
				throw new Error("release_fail");
			}
			return origEval(script, numKeys, ...args);
		};

		const result = await withDistributedRWLock(
			asRedis(r),
			KEYS,
			"shared",
			async () => {
				await new Promise((res) => setTimeout(res, 10));
				fnDone = true;
				return "ok";
			},
			FAST,
		);
		expect(result).toBe("ok");
		const logged = errSpy.mock.calls.some((c) => String(c[0]).includes("rw_lock_reader_release_error"));
		expect(logged).toBe(true);
		errSpy.mockRestore();
	});

	// ── Option validation ─────────────────────────────────────────────────────

	describe("option validation", () => {
		it("rejects renewMs >= leaseMs", async () => {
			await expect(
				withDistributedRWLock(asRedis(fake()), KEYS, "shared", async () => "ok", { leaseMs: 1000, renewMs: 1000 }),
			).rejects.toThrow(/renewMs.*must be strictly less than leaseMs/);
		});

		it("rejects renewMs >= readerLeaseMs (reader heartbeat must fire before ZSET entry expires)", async () => {
			await expect(
				withDistributedRWLock(asRedis(fake()), KEYS, "shared", async () => "ok", {
					leaseMs: 60_000,
					renewMs: 20_000,
					readerLeaseMs: 5_000,
				}),
			).rejects.toThrow(/renewMs.*must be strictly less than readerLeaseMs/);
		});

		it("rejects non-positive readerLeaseMs", async () => {
			await expect(
				withDistributedRWLock(asRedis(fake()), KEYS, "shared", async () => "ok", { ...FAST, readerLeaseMs: 0 }),
			).rejects.toThrow(/readerLeaseMs must be > 0/);
		});

		it("accepts defaults unchanged", async () => {
			// Defaults satisfy every invariant; should not throw.
			const result = await withDistributedRWLock(asRedis(fake()), KEYS, "shared", async () => "ok");
			expect(result).toBe("ok");
		});
	});

	// ── rwLockKeys ────────────────────────────────────────────────────────────

	it("rwLockKeys generates the expected key namespace", () => {
		const k = rwLockKeys("acme", "sandbox-1");
		expect(k.writer).toBe("vfs:acme:rwlock:{sandbox-1}:writer");
		expect(k.readers).toBe("vfs:acme:rwlock:{sandbox-1}:readers");
	});
});

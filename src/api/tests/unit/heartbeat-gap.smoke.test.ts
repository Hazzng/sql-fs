/**
 * F8 end-to-end smoke test: reproduce a >lease event-loop stall on each of the
 * three Redis leases and prove the new observability fires.
 *
 * Each test acquires a lock against an in-process FakeRedis that honours PX
 * expiry / ZSET TTL reaping, then blocks the event loop synchronously for longer
 * than the lease. This is the genuine failure mode (a GC pause / pathological
 * sync bash stretch): the renewal timer cannot fire, Redis expires the
 * key/reaps the reader entry, and the late renew returns 0 → a real
 * `LockLostError`. The assertions then REQUIRE the new `heartbeat_gap` critical
 * event (with the correct `lock` tag + gap ≥ lease). Delete the emit calls in
 * the heartbeats and these tests go red.
 *
 * A no-stall control proves there are no false positives on healthy ticks.
 */

import type { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetRedisCircuitBreakerForTest } from "../../../redis/circuit-breaker.js";
import { LockLostError, execLockKey, withDistributedLock } from "../../distributed-lock.js";
import { type RWLockKeys, rwLockKeys, withDistributedRWLock } from "../../distributed-rw-lock.js";

// Lease floor small enough to cross with a short busy-loop, large enough that a
// healthy tick (renewMs=80) lands well inside it.
const LEASE_MS = 200;
const RENEW_MS = 80;
const STALL_MS = 350; // > LEASE_MS, so the lease genuinely expires during the stall

function busyLoopMs(ms: number): void {
	const start = Date.now();
	while (Date.now() - start < ms) {
		/* block the event loop */
	}
}

interface HeartbeatGapLine {
	event: string;
	severity: "warn" | "critical";
	lock: string;
	key: string;
	gapMs: number;
	renewMs: number;
	leaseMs: number;
}

/** Spy console.warn/error and surface only the parsed `heartbeat_gap` lines. */
function captureHeartbeatGaps(): { gaps: () => HeartbeatGapLine[]; restore: () => void } {
	const lines: string[] = [];
	const push = (l: unknown): void => {
		lines.push(String(l));
	};
	const warnSpy = vi.spyOn(console, "warn").mockImplementation(push);
	const errorSpy = vi.spyOn(console, "error").mockImplementation(push);
	return {
		gaps: () =>
			lines
				.map((l) => {
					try {
						return JSON.parse(l) as { event?: string };
					} catch {
						return {};
					}
				})
				.filter((o): o is HeartbeatGapLine => (o as { event?: string }).event === "heartbeat_gap"),
		restore: () => {
			warnSpy.mockRestore();
			errorSpy.mockRestore();
		},
	};
}

// ── Exec-lock FakeRedis (SET NX PX + Lua renew/release) ─────────────────────────

class SimpleFakeRedis {
	store = new Map<string, { value: string; expiresAt: number }>();
	private gc(): void {
		const now = Date.now();
		for (const [k, e] of this.store) if (e.expiresAt <= now) this.store.delete(k);
	}
	async set(key: string, value: string, _px: "PX", ms: number, _nx: "NX"): Promise<"OK" | null> {
		this.gc();
		if (this.store.has(key)) return null;
		this.store.set(key, { value, expiresAt: Date.now() + ms });
		return "OK";
	}
	async eval(script: string, _n: number, key: string, token: string, ms?: string): Promise<number> {
		this.gc();
		if (script.includes("del")) {
			const e = this.store.get(key);
			if (e?.value === token) {
				this.store.delete(key);
				return 1;
			}
			return 0;
		}
		const e = this.store.get(key);
		if (e?.value === token && ms !== undefined) {
			e.expiresAt = Date.now() + Number(ms);
			return 1;
		}
		return 0;
	}
}

// ── RW-lock FakeRedis (writer flag string + reader ZSET with TTL scores) ─────────

class RwFakeRedis {
	strings = new Map<string, { value: string; expiresAt: number }>();
	zsets = new Map<string, Map<string, number>>();
	private gcStrings(): void {
		const now = Date.now();
		for (const [k, e] of this.strings) if (e.expiresAt <= now) this.strings.delete(k);
	}
	private getZset(key: string): Map<string, number> {
		let z = this.zsets.get(key);
		if (!z) {
			z = new Map();
			this.zsets.set(key, z);
		}
		return z;
	}
	private reapZset(key: string, nowMs: number): void {
		const z = this.zsets.get(key);
		if (!z) return;
		for (const [m, score] of z) if (score <= nowMs) z.delete(m);
	}
	async eval(script: string, numKeys: number, ...args: string[]): Promise<unknown> {
		this.gcStrings();
		const keys = args.slice(0, numKeys);
		const argv = args.slice(numKeys);
		// ACQUIRE_SHARED
		if (script.includes("ZREMRANGEBYSCORE") && script.includes("EXISTS")) {
			const [writerKey, readersKey] = keys as [string, string];
			const [token, nowStr, expireAtStr] = argv as [string, string, string];
			this.reapZset(readersKey, Number(nowStr));
			if (this.strings.has(writerKey)) return 0;
			this.getZset(readersKey).set(token, Number(expireAtStr));
			return 1;
		}
		// RELEASE_SHARED
		if (script.includes("ZREM") && !script.includes("ZREMRANGEBYSCORE")) {
			const [readersKey] = keys as [string];
			const [token] = argv as [string];
			return this.zsets.get(readersKey)?.delete(token) ? 1 : 0;
		}
		// RENEW_SHARED
		if (script.includes("ZSCORE")) {
			const [readersKey] = keys as [string];
			const [token, expireAtStr] = argv as [string, string];
			const z = this.zsets.get(readersKey);
			if (z?.has(token)) {
				z.set(token, Number(expireAtStr));
				return 1;
			}
			return 0;
		}
		// ACQUIRE_EXCLUSIVE_FLAG
		if (script.includes("SET") && script.includes("NX")) {
			const [writerKey] = keys as [string];
			const [token, leaseMsStr] = argv as [string, string];
			if (this.strings.has(writerKey)) return null;
			this.strings.set(writerKey, { value: token, expiresAt: Date.now() + Number(leaseMsStr) });
			return "OK";
		}
		// CHECK_READERS_DRAINED
		if (script.includes("ZCARD")) {
			const [writerKey, readersKey] = keys as [string, string];
			const [token, nowStr] = argv as [string, string];
			if (this.strings.get(writerKey)?.value !== token) return -1;
			this.reapZset(readersKey, Number(nowStr));
			return this.zsets.get(readersKey)?.size ?? 0;
		}
		// RENEW_EXCLUSIVE
		if (script.includes("PEXPIRE")) {
			const [writerKey] = keys as [string];
			const [token, leaseMsStr] = argv as [string, string];
			const e = this.strings.get(writerKey);
			if (e?.value === token) {
				e.expiresAt = Date.now() + Number(leaseMsStr);
				return 1;
			}
			return 0;
		}
		// RELEASE_EXCLUSIVE
		if (script.includes("DEL")) {
			const [writerKey] = keys as [string];
			const [token] = argv as [string];
			if (this.strings.get(writerKey)?.value !== token) return 0;
			this.strings.delete(writerKey);
			return 1;
		}
		throw new Error(`RwFakeRedis: unrecognised script: ${script.slice(0, 40)}`);
	}
}

const asRedis = (f: unknown): Redis => f as Redis;

describe("F8 heartbeat-gap smoke: a >lease stall is reproduced and observed", () => {
	beforeEach(() => {
		vi.useRealTimers();
		resetRedisCircuitBreakerForTest();
	});
	afterEach(() => {
		vi.useRealTimers();
		resetRedisCircuitBreakerForTest();
	});

	it("exec lock: sync stall loses the lease AND emits a critical heartbeat_gap", async () => {
		const r = new SimpleFakeRedis();
		const key = execLockKey("default", "sbx-exec-stall");
		const cap = captureHeartbeatGaps();
		try {
			await expect(
				withDistributedLock(
					asRedis(r),
					key,
					async () => {
						busyLoopMs(STALL_MS);
						// Yield so the overdue heartbeat fires inside the critical section.
						await new Promise((res) => setTimeout(res, 30));
					},
					{ leaseMs: LEASE_MS, renewMs: RENEW_MS, acquireTimeoutMs: 5_000, acquireRetryMs: 10 },
				),
			).rejects.toBeInstanceOf(LockLostError);
		} finally {
			cap.restore();
		}
		const critical = cap.gaps().filter((g) => g.severity === "critical");
		expect(critical.length).toBeGreaterThanOrEqual(1);
		expect(critical[0]?.lock).toBe("exec");
		expect(critical[0]?.key).toBe(key);
		expect(critical[0]?.gapMs).toBeGreaterThanOrEqual(LEASE_MS);
	});

	it("rw-lock writer: sync stall loses the flag AND emits a critical heartbeat_gap", async () => {
		const r = new RwFakeRedis();
		const keys: RWLockKeys = rwLockKeys("default", "sbx-writer-stall");
		const cap = captureHeartbeatGaps();
		try {
			await expect(
				withDistributedRWLock(
					asRedis(r),
					keys,
					"exclusive",
					async () => {
						busyLoopMs(STALL_MS);
						await new Promise((res) => setTimeout(res, 30));
					},
					{ leaseMs: LEASE_MS, renewMs: RENEW_MS, acquireTimeoutMs: 5_000, acquireRetryMs: 10, readerLeaseMs: 5_000 },
				),
			).rejects.toBeInstanceOf(LockLostError);
		} finally {
			cap.restore();
		}
		const critical = cap.gaps().filter((g) => g.severity === "critical");
		expect(critical.length).toBeGreaterThanOrEqual(1);
		expect(critical[0]?.lock).toBe("rw-writer");
		expect(critical[0]?.key).toBe(keys.writer);
		expect(critical[0]?.gapMs).toBeGreaterThanOrEqual(LEASE_MS);
	});

	it("rw-lock reader: sync stall past the reader lease emits a critical heartbeat_gap", async () => {
		// Reader semantics differ from the writer/exec leases: a ZSET entry does not
		// auto-expire by score — it is only reaped by a *competing writer's*
		// acquire/check (ZREMRANGEBYSCORE). So a lone reader whose heartbeat fires
		// late simply re-adds itself and does NOT self-detect a loss; the danger is
		// that during the gap a writer could have reaped its stale entry and entered.
		// The gap metric is exactly what surfaces that otherwise-silent window.
		const r = new RwFakeRedis();
		const keys: RWLockKeys = rwLockKeys("default", "sbx-reader-stall");
		const cap = captureHeartbeatGaps();
		try {
			await withDistributedRWLock(
				asRedis(r),
				keys,
				"shared",
				async () => {
					busyLoopMs(STALL_MS);
					await new Promise((res) => setTimeout(res, 30));
				},
				{ leaseMs: 5_000, renewMs: RENEW_MS, acquireTimeoutMs: 5_000, acquireRetryMs: 10, readerLeaseMs: LEASE_MS },
			);
		} finally {
			cap.restore();
		}
		const critical = cap.gaps().filter((g) => g.severity === "critical");
		expect(critical.length).toBeGreaterThanOrEqual(1);
		expect(critical[0]?.lock).toBe("rw-reader");
		expect(critical[0]?.key).toBe(keys.readers);
		// gap ≥ readerLeaseMs proves the window during which a writer could have
		// reaped this reader and entered while the read was still in flight.
		expect(critical[0]?.gapMs).toBeGreaterThanOrEqual(LEASE_MS);
	});

	it("control: a healthy run (no stall) emits no heartbeat_gap events", async () => {
		const r = new SimpleFakeRedis();
		const key = execLockKey("default", "sbx-healthy");
		const cap = captureHeartbeatGaps();
		try {
			const result = await withDistributedLock(
				asRedis(r),
				key,
				async () => {
					// Run long enough for one on-time heartbeat (renewMs=80) to fire.
					await new Promise((res) => setTimeout(res, 130));
					return "ok";
				},
				{ leaseMs: LEASE_MS, renewMs: RENEW_MS, acquireTimeoutMs: 5_000, acquireRetryMs: 10 },
			);
			expect(result).toBe("ok");
		} finally {
			cap.restore();
		}
		expect(cap.gaps()).toEqual([]);
		expect(r.store.has(key)).toBe(false); // released cleanly
	});
});

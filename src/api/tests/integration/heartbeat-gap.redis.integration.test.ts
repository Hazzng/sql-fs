/**
 * F8 Layer-2 smoke test against a REAL Redis (skipped unless REDIS_URL is set).
 *
 * The unit smoke test (`heartbeat-gap.smoke.test.ts`) uses a FakeRedis; this one
 * proves the same behaviour end-to-end against a live Redis server, exercising
 * real `SET NX PX` expiry and real Lua renew scripts:
 *
 *  1. A synchronous event-loop stall longer than the lease causes a genuine
 *     `LockLostError` (real Redis PX-expired the key) AND emits a `critical`
 *     `heartbeat_gap` — the previously-silent failure is now observable.
 *  2. A second connection (a "peer replica") can acquire the lease that the
 *     stalled holder still believes it owns — the real split-brain window.
 *  3. The RW-lock writer flag behaves identically.
 *
 * Run with:  REDIS_URL=redis://localhost:6380 pnpm test:integration
 */

import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { LockLostError, execLockKey, withDistributedLock } from "../../distributed-lock.js";
import { type RWLockKeys, rwLockKeys, withDistributedRWLock } from "../../distributed-rw-lock.js";

const SKIP = !process.env.REDIS_URL;
const TENANT = "default";

// Lease floor crossed by a ~1.5s busy-loop; renew well inside it.
const LEASE_MS = 800;
const RENEW_MS = 250;
const STALL_MS = 1_500;
const LOCK_OPTS = { leaseMs: LEASE_MS, renewMs: RENEW_MS, acquireTimeoutMs: 8_000, acquireRetryMs: 50 };

function busyLoopMs(ms: number): void {
	const start = Date.now();
	while (Date.now() - start < ms) {
		/* block the event loop — the real GC-pause / sync-bash-stretch model */
	}
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface HeartbeatGapLine {
	event: string;
	severity: "warn" | "critical";
	lock: string;
	key: string;
	gapMs: number;
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

describe.skipIf(SKIP)("F8 Layer-2 — heartbeat gap against real Redis", () => {
	let redis: Redis;
	const keysToClean: string[] = [];

	beforeAll(async () => {
		redis = new Redis(process.env.REDIS_URL!, { lazyConnect: true, maxRetriesPerRequest: 1 });
		await redis.connect();
	});

	afterEach(async () => {
		if (keysToClean.length > 0) await redis.del(...keysToClean);
		keysToClean.length = 0;
	});

	afterAll(async () => {
		await redis.quit();
	});

	function newExecKey(suffix: string): string {
		const key = execLockKey(TENANT, `f8-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
		keysToClean.push(key);
		return key;
	}

	it("exec lock: a >lease sync stall loses the lease and emits a critical heartbeat_gap", async () => {
		const key = newExecKey("exec-stall");
		const cap = captureHeartbeatGaps();
		try {
			await expect(
				withDistributedLock(
					redis,
					key,
					async () => {
						busyLoopMs(STALL_MS);
						await sleep(50); // yield so the overdue heartbeat fires in-section
					},
					LOCK_OPTS,
				),
			).rejects.toBeInstanceOf(LockLostError);
		} finally {
			cap.restore();
		}
		const critical = cap.gaps().filter((g) => g.severity === "critical" && g.lock === "exec");
		expect(critical.length).toBeGreaterThanOrEqual(1);
		expect(critical[0]?.key).toBe(key);
		expect(critical[0]?.gapMs).toBeGreaterThanOrEqual(LEASE_MS);
		// The lease genuinely lapsed in real Redis — the key no longer holds our token.
		expect(await redis.get(key)).toBeNull();
	});

	it("exec lock: a peer connection acquires the lease the stalled holder still believes it owns", async () => {
		const key = newExecKey("exec-steal");
		const peer = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: 1 });
		const cap = captureHeartbeatGaps();
		let peerAcquired = false;
		try {
			// Holder A stalls past its lease; peer B races to acquire the same key.
			// (Single process: B's poll is blocked during A's synchronous stall, then
			// finds the key PX-expired the moment the loop frees — the real handoff a
			// separate replica process would win mid-stall. Lock 3 is the DB backstop.)
			const holder = withDistributedLock(
				redis,
				key,
				async () => {
					busyLoopMs(STALL_MS);
					await sleep(50);
				},
				LOCK_OPTS,
			);
			const peerLock = withDistributedLock(
				peer,
				key,
				async () => {
					peerAcquired = true;
				},
				{ leaseMs: 2_000, renewMs: 500, acquireTimeoutMs: 8_000, acquireRetryMs: 50 },
			);

			await expect(holder).rejects.toBeInstanceOf(LockLostError);
			await peerLock;
		} finally {
			cap.restore();
			await peer.quit();
		}
		expect(peerAcquired).toBe(true);
		const critical = cap.gaps().filter((g) => g.severity === "critical" && g.lock === "exec");
		expect(critical.length).toBeGreaterThanOrEqual(1);
	});

	it("rw-lock writer: a >lease sync stall loses the flag and emits a critical heartbeat_gap", async () => {
		const keys: RWLockKeys = rwLockKeys(TENANT, `f8-rw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
		keysToClean.push(keys.writer, keys.readers);
		const cap = captureHeartbeatGaps();
		try {
			await expect(
				withDistributedRWLock(
					redis,
					keys,
					"exclusive",
					async () => {
						busyLoopMs(STALL_MS);
						await sleep(50);
					},
					{ ...LOCK_OPTS, readerLeaseMs: 5_000 },
				),
			).rejects.toBeInstanceOf(LockLostError);
		} finally {
			cap.restore();
		}
		const critical = cap.gaps().filter((g) => g.severity === "critical" && g.lock === "rw-writer");
		expect(critical.length).toBeGreaterThanOrEqual(1);
		expect(critical[0]?.key).toBe(keys.writer);
		expect(critical[0]?.gapMs).toBeGreaterThanOrEqual(LEASE_MS);
		expect(await redis.get(keys.writer)).toBeNull();
	});
});

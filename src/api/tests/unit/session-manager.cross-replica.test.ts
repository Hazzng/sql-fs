/**
 * Unit tests for cross-replica SessionManager RW lock wiring (Phase 2).
 *
 * Two SessionManager instances share one in-memory FakeRedis — simulating
 * two API replicas. Verifies:
 *   - Two parallel readers (one per manager) run concurrently (peak >= 2).
 *   - A writer on manager A blocks a reader on manager B until A's exec
 *     completes (exclusive lock gates new shared acquires).
 *   - A reader on manager A blocks a writer on manager B until the reader
 *     exits (shared lock holds off exclusive acquisition until readers drain).
 *   - withSessionRead falls back to local-only when redis is undefined.
 *
 * No real Redis — uses an in-process fake that honours the distributed RW
 * lock's ZSET + string-key surface.
 */

import type { Redis } from "ioredis";
import { InMemoryFs } from "just-bash";
import type { IFileSystem } from "just-bash";
import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../session-manager.js";

// ── FakeRedis (ZSET-aware) ────────────────────────────────────────────────────

interface StringEntry {
	value: string;
	expiresAt: number;
}

class FakeRedis {
	strings = new Map<string, StringEntry>();
	zsets = new Map<string, Map<string, number>>();

	private gcStrings(): void {
		const now = Date.now();
		for (const [k, e] of this.strings) if (e.expiresAt <= now) this.strings.delete(k);
	}

	private reapZset(key: string, nowMs: number): void {
		const z = this.zsets.get(key);
		if (!z) return;
		for (const [m, score] of z) if (score <= nowMs) z.delete(m);
	}

	private getZset(key: string): Map<string, number> {
		let z = this.zsets.get(key);
		if (!z) {
			z = new Map();
			this.zsets.set(key, z);
		}
		return z;
	}

	async set(key: string, value: string, _px: "PX", ms: number, _nx: "NX"): Promise<"OK" | null> {
		this.gcStrings();
		if (this.strings.has(key)) return null;
		this.strings.set(key, { value, expiresAt: Date.now() + ms });
		return "OK";
	}

	async eval(script: string, numKeys: number, ...args: string[]): Promise<unknown> {
		this.gcStrings();
		const keys = args.slice(0, numKeys);
		const argv = args.slice(numKeys);

		if (script.includes("ZREMRANGEBYSCORE") && script.includes("EXISTS")) {
			const [writerKey, readersKey] = keys as [string, string];
			const [token, nowStr, expireAtStr] = argv as [string, string, string];
			this.reapZset(readersKey, Number(nowStr));
			if (this.strings.has(writerKey)) return 0;
			this.getZset(readersKey).set(token, Number(expireAtStr));
			return 1;
		}
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
		if (script.includes("SET") && script.includes("NX")) {
			const [writerKey] = keys as [string];
			const [token, leaseMsStr] = argv as [string, string];
			if (this.strings.has(writerKey)) return null;
			this.strings.set(writerKey, { value: token, expiresAt: Date.now() + Number(leaseMsStr) });
			return "OK";
		}
		if (script.includes("ZCARD")) {
			const [writerKey, readersKey] = keys as [string, string];
			const [token, nowStr] = argv as [string, string];
			const entry = this.strings.get(writerKey);
			if (entry?.value !== token) return -1;
			this.reapZset(readersKey, Number(nowStr));
			return this.zsets.get(readersKey)?.size ?? 0;
		}
		if (script.includes("PEXPIRE")) {
			const [writerKey] = keys as [string];
			const [token, leaseMsStr] = argv as [string, string];
			const entry = this.strings.get(writerKey);
			if (entry?.value === token) {
				entry.expiresAt = Date.now() + Number(leaseMsStr);
				return 1;
			}
			return 0;
		}
		if (script.includes("DEL")) {
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

function asRedis(f: FakeRedis): Redis {
	return f as unknown as Redis;
}

const T = "default";
const FAST_OPTS = { leaseMs: 5_000, renewMs: 4_000, acquireTimeoutMs: 3_000, acquireRetryMs: 10, readerLeaseMs: 5_000 };

function makeCreateFs() {
	return vi.fn((_tenantId: string, _sandboxId: string): Promise<IFileSystem> => Promise.resolve(new InMemoryFs()));
}

function makePair(): { smA: SessionManager; smB: SessionManager; redis: FakeRedis } {
	const redis = new FakeRedis();
	const opts = { redis: asRedis(redis), execLockOptions: FAST_OPTS };
	const smA = new SessionManager({ createFs: makeCreateFs(), ...opts });
	const smB = new SessionManager({ createFs: makeCreateFs(), ...opts });
	return { smA, smB, redis };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("SessionManager cross-replica RW lock", () => {
	it("two parallel readers across managers run concurrently (peak in-flight >= 2)", async () => {
		const { smA, smB } = makePair();
		await Promise.all([smA.getOrCreate(T, "sbx-cr"), smB.getOrCreate(T, "sbx-cr")]);

		let active = 0;
		let peak = 0;
		const reader = (sm: SessionManager): Promise<void> =>
			sm.withSessionRead(T, "sbx-cr", async () => {
				active++;
				peak = Math.max(peak, active);
				await new Promise((r) => setTimeout(r, 40));
				active--;
			});

		await Promise.all([reader(smA), reader(smB)]);
		expect(peak).toBeGreaterThanOrEqual(2);
	});

	it("exclusive on A blocks shared on B until A's exec completes", async () => {
		const { smA, smB } = makePair();
		await Promise.all([smA.getOrCreate(T, "sbx-wb"), smB.getOrCreate(T, "sbx-wb")]);

		const order: string[] = [];
		let releaseWriter!: () => void;
		const writerGate = new Promise<void>((r) => {
			releaseWriter = r;
		});

		const writer = smA.withSession(T, "sbx-wb", async () => {
			order.push("w-start");
			await writerGate;
			order.push("w-end");
		});

		// Give writer a moment to acquire
		await new Promise((r) => setTimeout(r, 10));

		const reader = smB.withSessionRead(T, "sbx-wb", async () => {
			order.push("r-start");
		});

		// Let reader attempt acquisition — it should be blocked
		await new Promise((r) => setTimeout(r, 30));
		expect(order).toEqual(["w-start"]);

		releaseWriter();
		await Promise.all([writer, reader]);
		expect(order).toEqual(["w-start", "w-end", "r-start"]);
	});

	it("shared on A blocks exclusive on B until reader exits", async () => {
		const { smA, smB } = makePair();
		await Promise.all([smA.getOrCreate(T, "sbx-rb"), smB.getOrCreate(T, "sbx-rb")]);

		const order: string[] = [];
		let releaseReader!: () => void;
		const readerGate = new Promise<void>((r) => {
			releaseReader = r;
		});

		const reader = smA.withSessionRead(T, "sbx-rb", async () => {
			order.push("r-start");
			await readerGate;
			order.push("r-end");
		});

		// Give reader a moment to acquire
		await new Promise((r) => setTimeout(r, 10));

		const writer = smB.withSession(T, "sbx-rb", async () => {
			order.push("w-start");
		});

		// Let writer attempt acquisition — it should be blocked waiting for readers to drain
		await new Promise((r) => setTimeout(r, 30));
		expect(order).toEqual(["r-start"]);

		releaseReader();
		await Promise.all([reader, writer]);
		expect(order).toEqual(["r-start", "r-end", "w-start"]);
	});

	it("withSessionRead falls back to local-only when redis is undefined", async () => {
		const sm = new SessionManager({ createFs: makeCreateFs() });
		await sm.getOrCreate(T, "sbx-local");
		const result = await sm.withSessionRead(T, "sbx-local", async () => "local-ok");
		expect(result).toBe("local-ok");
	});

	it("two readers across managers do not block each other (both acquire within 200ms)", async () => {
		const { smA, smB } = makePair();
		await Promise.all([smA.getOrCreate(T, "sbx-noblock"), smB.getOrCreate(T, "sbx-noblock")]);

		const starts: number[] = [];
		const reader = (sm: SessionManager): Promise<void> =>
			sm.withSessionRead(T, "sbx-noblock", async () => {
				starts.push(Date.now());
				await new Promise((r) => setTimeout(r, 60));
			});

		const t0 = Date.now();
		await Promise.all([reader(smA), reader(smB)]);

		// Both readers should have started within 200ms of the first (not serialized)
		const spread = Math.max(...starts) - Math.min(...starts);
		expect(spread).toBeLessThan(200);
		// Total elapsed should be closer to 60ms than 120ms (they overlapped)
		expect(Date.now() - t0).toBeLessThan(150);
	});
});

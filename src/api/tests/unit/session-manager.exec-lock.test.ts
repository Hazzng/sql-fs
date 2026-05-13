/**
 * Unit tests for SessionManager + distributed exec lock integration.
 *
 * Exercises:
 *   - withSession/withExistingSession/destroy acquire the Redis lock (by key).
 *   - Concurrent operations across two SessionManagers sharing the same mock
 *     Redis serialize on the distributed lock.
 *   - Destroy-vs-exec: destroy waits for in-flight exec.
 *   - ELOCKTIMEOUT propagates when the acquire window elapses.
 *
 * No real Redis — uses an in-process fake that honours the RW lock's ZSET +
 * string-key surface (same implementation as distributed-rw-lock.test.ts).
 */

import type { Redis } from "ioredis";
import { InMemoryFs } from "just-bash";
import type { IFileSystem } from "just-bash";
import { describe, expect, it, vi } from "vitest";
import { rwLockKeys } from "../../distributed-rw-lock.js";
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

	getZset(key: string): Map<string, number> {
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

function makeCreateFs() {
	return vi.fn((_tenantId: string, _sandboxId: string): Promise<IFileSystem> => Promise.resolve(new InMemoryFs()));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("SessionManager + distributed exec lock", () => {
	it("withSession takes and releases the Redis writer lock around fn", async () => {
		const redis = new FakeRedis();
		const sm = new SessionManager({ createFs: makeCreateFs(), redis: asRedis(redis) });

		let observedLock: StringEntry | undefined;
		await sm.withSession(T, "sbx-A", async () => {
			observedLock = redis.strings.get(rwLockKeys(T, "sbx-A").writer);
		});

		expect(observedLock).toBeDefined();
		expect(redis.strings.has(rwLockKeys(T, "sbx-A").writer)).toBe(false);
	});

	it("two SessionManagers sharing the same Redis serialize concurrent withSession", async () => {
		const redis = new FakeRedis();
		const smA = new SessionManager({ createFs: makeCreateFs(), redis: asRedis(redis) });
		const smB = new SessionManager({ createFs: makeCreateFs(), redis: asRedis(redis) });

		const order: string[] = [];

		const callA = smA.withSession(T, "sbx-shared", async () => {
			order.push("A-start");
			await new Promise((r) => setTimeout(r, 80));
			order.push("A-end");
		});

		// Give A a chance to acquire before launching B
		await new Promise((r) => setTimeout(r, 5));

		const callB = smB.withSession(T, "sbx-shared", async () => {
			order.push("B-start");
			order.push("B-end");
		});

		await Promise.all([callA, callB]);
		expect(order).toEqual(["A-start", "A-end", "B-start", "B-end"]);
	});

	it("destroy acquires the Redis lock; concurrent withSession waits", async () => {
		const redis = new FakeRedis();
		const destroyFn = vi.fn().mockResolvedValue(undefined);
		const smA = new SessionManager({
			createFs: makeCreateFs(),
			destroySandboxFn: destroyFn,
			redis: asRedis(redis),
		});
		const smB = new SessionManager({
			createFs: makeCreateFs(),
			destroySandboxFn: destroyFn,
			redis: asRedis(redis),
		});

		const events: string[] = [];

		// Pre-warm a session in smA so destroy actually tears down local state
		await smA.withSession(T, "sbx-D", async () => {
			events.push("prewarm");
		});

		let releaseExec!: () => void;
		const execGate = new Promise<void>((resolve) => {
			releaseExec = resolve;
		});

		// smB kicks off a withSession holding the lock
		const execCall = smB.withSession(T, "sbx-D", async () => {
			events.push("exec-start");
			await execGate;
			events.push("exec-end");
		});

		await new Promise((r) => setTimeout(r, 5));

		const destroyCall = smA.destroy(T, "sbx-D");

		// Let destroy attempt to acquire — it should be blocked behind exec
		await new Promise((r) => setTimeout(r, 30));
		events.push("before-release");
		releaseExec();

		await Promise.all([execCall, destroyCall]);

		expect(events).toEqual(["prewarm", "exec-start", "before-release", "exec-end"]);
	});

	it("ELOCKTIMEOUT propagates when acquire times out", async () => {
		const redis = new FakeRedis();
		// Plant a foreign writer lock that will never release within the acquire window.
		redis.strings.set(rwLockKeys(T, "sbx-T").writer, {
			value: "owned-by-someone-else",
			expiresAt: Date.now() + 60_000,
		});

		const sm = new SessionManager({
			createFs: makeCreateFs(),
			redis: asRedis(redis),
			execLockOptions: { acquireTimeoutMs: 100, acquireRetryMs: 20, leaseMs: 5_000, renewMs: 1_000 },
		});

		await expect(sm.withSession(T, "sbx-T", async () => "nope")).rejects.toMatchObject({ code: "ELOCKTIMEOUT" });
	});

	it("single-replica (no Redis) mode skips the distributed lock", async () => {
		const sm = new SessionManager({ createFs: makeCreateFs() });
		const result = await sm.withSession(T, "sbx-solo", async () => "solo-ok");
		expect(result).toBe("solo-ok");
	});

	it("rwlockEnabled=false falls back to exclusive-only path (no reader ZSET)", async () => {
		const redis = new FakeRedis();
		const sm = new SessionManager({ createFs: makeCreateFs(), redis: asRedis(redis), rwlockEnabled: false });

		await sm.withSession(T, "sbx-legacy", async () => {});

		// Writer ZSET key must NOT exist (legacy path uses simple SET NX, not RW lock)
		expect(redis.zsets.has(rwLockKeys(T, "sbx-legacy").readers)).toBe(false);
	});
});

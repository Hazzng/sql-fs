/**
 * F3 unit tests: durable background publish drainer.
 *
 * When a committed write's Redis INCR fails, the version bump is stranded and
 * other replicas keep serving the pre-write tree. These tests cover the in-process
 * healing path:
 *  - INCR failure enqueues the session into the drainer's pending set.
 *  - The background drainer republishes once Redis recovers (INCR succeeds).
 *  - No double-INCR (V+2) when a reload races the drainer under the lock.
 *  - A reaped publishPending session gets one best-effort publish before disconnect.
 */

import type { Redis } from "ioredis";
import type { IFileSystem } from "just-bash";
import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../session-manager.js";

interface Entry {
	value: string;
	expiresAt: number;
}

/**
 * Fake Redis: version-counter store + the distributed RW-lock eval scripts the
 * exec path needs to acquire a writer lock. Mirrors the helper in
 * session-manager.version-counter.test.ts.
 */
class FakeRedis {
	store = new Map<string, Entry>(); // version keys
	strings = new Map<string, Entry>(); // lock writer keys
	zsets = new Map<string, Map<string, number>>();

	private gc(): void {
		const now = Date.now();
		for (const [k, e] of this.store) if (e.expiresAt <= now) this.store.delete(k);
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

	async getex(key: string, _ex: "EX", seconds: number): Promise<string | null> {
		this.gc();
		const e = this.store.get(key);
		if (e === undefined) return null;
		e.expiresAt = Date.now() + seconds * 1000;
		return e.value;
	}

	async incr(key: string): Promise<number> {
		this.gc();
		const current = Number(this.store.get(key)?.value ?? "0") || 0;
		const next = current + 1;
		this.store.set(key, { value: String(next), expiresAt: Date.now() + 60_000 });
		return next;
	}

	async expire(key: string, seconds: number): Promise<number> {
		const e = this.store.get(key);
		if (e === undefined) return 0;
		e.expiresAt = Date.now() + seconds * 1000;
		return 1;
	}

	async del(key: string): Promise<number> {
		return this.store.delete(key) ? 1 : 0;
	}

	async eval(script: string, numKeys: number, ...args: string[]): Promise<unknown> {
		this.gc();
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

class StubCoherentFs {
	dirty = false;
	reloadCount = 0;
	clearDirtyCount = 0;
	isPoisoned = false;

	getAllPaths(): string[] {
		return [];
	}
	async reload(): Promise<void> {
		this.reloadCount++;
		this.dirty = false;
	}
	wasDirty(): boolean {
		return this.dirty;
	}
	clearDirty(): void {
		this.clearDirtyCount++;
		this.dirty = false;
	}
	poisoned(): boolean {
		return this.isPoisoned;
	}
}

function makeFsFactory(instance: StubCoherentFs): (_t: string, _s: string) => Promise<IFileSystem> {
	return vi.fn(async () => instance as unknown as IFileSystem);
}

const VKEY = "vfs:default:ver:sbx";

describe("SessionManager F3 publish drainer", () => {
	it("enqueues a stranded publish on INCR failure and drains it once Redis recovers", async () => {
		const redis = new FakeRedis();
		const stub = new StubCoherentFs();
		const sm = new SessionManager({ createFs: makeFsFactory(stub), redis: asRedis(redis) });

		await sm.withSession("default", "sbx", async () => {});

		// Mutation turn whose INCR fails — stranded.
		const incrSpy = vi.spyOn(redis, "incr").mockRejectedValueOnce(new Error("ECONNRESET"));
		await expect(
			sm.withSession("default", "sbx", async () => {
				stub.dirty = true;
			}),
		).rejects.toMatchObject({ code: "ECOHERENCE" });

		// Nothing published yet; session flagged pending.
		expect(redis.store.has(VKEY)).toBe(false);
		expect(sm.getSession("default", "sbx")?.publishPending).toBe(true);

		// Redis recovers; the drainer flushes the stranded bump without any new exec.
		incrSpy.mockRestore();
		await sm.drainPendingPublishes();

		expect(redis.store.get(VKEY)?.value).toBe("1");
		expect(sm.getSession("default", "sbx")?.publishPending).toBe(false);
		expect(sm.getSession("default", "sbx")?.lastSeenVersion).toBe(1);
		expect(stub.dirty).toBe(false);

		// Idempotent: a second drain tick is a no-op (no double INCR).
		await sm.drainPendingPublishes();
		expect(redis.store.get(VKEY)?.value).toBe("1");
	});

	it("does not double-INCR when a reload clears dirty before the drainer runs", async () => {
		const redis = new FakeRedis();
		const stub = new StubCoherentFs();
		const sm = new SessionManager({ createFs: makeFsFactory(stub), redis: asRedis(redis) });

		await sm.withSession("default", "sbx", async () => {});

		// Strand a bump.
		const incrSpy = vi.spyOn(redis, "incr").mockRejectedValueOnce(new Error("ECONNRESET"));
		await expect(
			sm.withSession("default", "sbx", async () => {
				stub.dirty = true;
			}),
		).rejects.toMatchObject({ code: "ECOHERENCE" });
		incrSpy.mockRestore();

		// Another replica publishes v5; this replica's next turn reloads (ensureFreshCache),
		// which clears dirty AND clears publishPending via a successful republish.
		redis.store.set(VKEY, { value: "5", expiresAt: Date.now() + 60_000 });
		await sm.withSession("default", "sbx", async () => {});

		// The exec turn already healed it: counter advanced to 6 (the pending bump
		// flushed on top of the reloaded 5), dirty/pending cleared.
		expect(sm.getSession("default", "sbx")?.publishPending).toBe(false);
		const afterExec = redis.store.get(VKEY)?.value;
		expect(afterExec).toBe("6");

		// Drainer runs afterward — must NOT bump again (no V+2).
		await sm.drainPendingPublishes();
		expect(redis.store.get(VKEY)?.value).toBe(afterExec);
	});

	it("makes a best-effort publish when a publishPending session is reaped", async () => {
		const redis = new FakeRedis();
		const stub = new StubCoherentFs();
		const sm = new SessionManager({
			createFs: makeFsFactory(stub),
			destroySandboxFn: vi.fn().mockResolvedValue(undefined),
			redis: asRedis(redis),
			idleMs: 0, // every idle session is immediately reapable
		});

		await sm.withSession("default", "sbx", async () => {});

		// Strand a bump.
		const incrSpy = vi.spyOn(redis, "incr").mockRejectedValueOnce(new Error("ECONNRESET"));
		await expect(
			sm.withSession("default", "sbx", async () => {
				stub.dirty = true;
			}),
		).rejects.toMatchObject({ code: "ECOHERENCE" });
		incrSpy.mockRestore();
		expect(redis.store.has(VKEY)).toBe(false);

		// Reaper evicts the idle session — but first flushes the stranded bump while
		// the FS is still connected. Start it on a tight interval and wait a tick.
		sm.startReaper(5, 5);
		await vi.waitFor(() => {
			expect(redis.store.get(VKEY)?.value).toBe("1");
		});
		expect(sm.getSession("default", "sbx")).toBeUndefined();
		sm.stopReaper();
	});

	it("drops the pending entry for a session that vanished before the drainer ran", async () => {
		const redis = new FakeRedis();
		const stub = new StubCoherentFs();
		const sm = new SessionManager({
			createFs: makeFsFactory(stub),
			destroySandboxFn: vi.fn().mockResolvedValue(undefined),
			redis: asRedis(redis),
		});

		await sm.withSession("default", "sbx", async () => {});
		const incrSpy = vi.spyOn(redis, "incr").mockRejectedValueOnce(new Error("ECONNRESET"));
		await expect(
			sm.withSession("default", "sbx", async () => {
				stub.dirty = true;
			}),
		).rejects.toMatchObject({ code: "ECOHERENCE" });
		incrSpy.mockRestore();

		// Destroy removes the session and its pending entry.
		await sm.destroy("default", "sbx");

		// Drainer is now a no-op — no resurrection of the destroyed sandbox's key.
		await sm.drainPendingPublishes();
		expect(redis.store.has(VKEY)).toBe(false);
	});

	it("leaves the entry enqueued when the retry INCR also fails", async () => {
		const redis = new FakeRedis();
		const stub = new StubCoherentFs();
		const sm = new SessionManager({ createFs: makeFsFactory(stub), redis: asRedis(redis) });

		await sm.withSession("default", "sbx", async () => {});
		const incrSpy = vi.spyOn(redis, "incr").mockRejectedValue(new Error("ECONNRESET"));
		await expect(
			sm.withSession("default", "sbx", async () => {
				stub.dirty = true;
			}),
		).rejects.toMatchObject({ code: "ECOHERENCE" });

		// First drain tick: INCR still failing — entry stays for the next tick.
		await sm.drainPendingPublishes();
		expect(redis.store.has(VKEY)).toBe(false);
		expect(sm.getSession("default", "sbx")?.publishPending).toBe(true);

		// Redis recovers; next tick heals it.
		incrSpy.mockRestore();
		await sm.drainPendingPublishes();
		expect(redis.store.get(VKEY)?.value).toBe("1");
		expect(sm.getSession("default", "sbx")?.publishPending).toBe(false);
	});
});

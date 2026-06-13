/**
 * Phase D unit tests: SessionManager version counter + reload-on-handoff.
 *
 * Exercises the Redis coherence protocol with a minimal fake Redis and a
 * stub `ICoherentFs`:
 *  - Initial version is stamped from Redis at session creation.
 *  - Version-match → no reload.
 *  - Version-mismatch → reload() + lastSeenVersion updated.
 *  - Dirty fs at end-of-turn → INCR + lastSeenVersion updated.
 *  - Not dirty → no INCR.
 *  - destroy deletes the version key.
 */

import type { Redis } from "ioredis";
import type { IFileSystem } from "just-bash";
import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../session-manager.js";

interface Entry {
	value: string;
	expiresAt: number;
}

class FakeRedis {
	store = new Map<string, Entry>(); // version keys (get/incr/expire/del)
	strings = new Map<string, Entry>(); // lock writer keys (eval-managed)
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

	async set(key: string, value: string, _px: "PX", ms: number, _nx: "NX"): Promise<"OK" | null> {
		this.gc();
		if (this.store.has(key)) return null;
		this.store.set(key, { value, expiresAt: Date.now() + ms });
		return "OK";
	}

	async get(key: string): Promise<string | null> {
		this.gc();
		return this.store.get(key)?.value ?? null;
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

		// ACQUIRE_SHARED_SCRIPT
		if (script.includes("ZREMRANGEBYSCORE") && script.includes("EXISTS")) {
			const [writerKey, readersKey] = keys as [string, string];
			const [token, nowStr, expireAtStr] = argv as [string, string, string];
			this.reapZset(readersKey, Number(nowStr));
			if (this.strings.has(writerKey)) return 0;
			this.getZset(readersKey).set(token, Number(expireAtStr));
			return 1;
		}
		// RELEASE_SHARED_SCRIPT
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
		// RENEW_SHARED_SCRIPT
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
		// ACQUIRE_EXCLUSIVE_FLAG_SCRIPT
		if (script.includes("SET") && script.includes("NX")) {
			const [writerKey] = keys as [string];
			const [token, leaseMsStr] = argv as [string, string];
			if (this.strings.has(writerKey)) return null;
			this.strings.set(writerKey, { value: token, expiresAt: Date.now() + Number(leaseMsStr) });
			return "OK";
		}
		// CHECK_READERS_DRAINED_SCRIPT
		if (script.includes("ZCARD")) {
			const [writerKey, readersKey] = keys as [string, string];
			const [token, nowStr] = argv as [string, string];
			const entry = this.strings.get(writerKey);
			if (entry?.value !== token) return -1;
			this.reapZset(readersKey, Number(nowStr));
			return this.zsets.get(readersKey)?.size ?? 0;
		}
		// RENEW_EXCLUSIVE_SCRIPT
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
		// RELEASE_EXCLUSIVE_SCRIPT
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

/**
 * Minimal ICoherentFs stub: tracks a dirty flag and records every reload call.
 * getAllPaths is required by SessionManager.estimatePathCacheBytes.
 */
class StubCoherentFs {
	dirty = false;
	reloadCount = 0;
	clearDirtyCount = 0;

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
		return false;
	}
}

function makeFsFactory(instance: StubCoherentFs): (_tenantId: string, _sandboxId: string) => Promise<IFileSystem> {
	return vi.fn(async () => instance as unknown as IFileSystem);
}

describe("SessionManager version counter (Phase D)", () => {
	it("stamps initial lastSeenVersion from Redis at session creation", async () => {
		const redis = new FakeRedis();
		// Seed a pre-existing version (e.g., another replica previously published v7)
		redis.store.set("vfs:default:ver:sbx", { value: "7", expiresAt: Date.now() + 60_000 });

		const stub = new StubCoherentFs();
		const sm = new SessionManager({
			createFs: makeFsFactory(stub),
			redis: asRedis(redis),
		});

		await sm.withSession("default", "sbx", async () => {
			// Fresh session: lastSeenVersion matches Redis, so no reload needed.
			expect(stub.reloadCount).toBe(0);
		});

		const session = sm.getSession("default", "sbx");
		expect(session?.lastSeenVersion).toBe(7);
	});

	it("no reload when versions match on subsequent exec", async () => {
		const redis = new FakeRedis();
		const stub = new StubCoherentFs();
		const sm = new SessionManager({
			createFs: makeFsFactory(stub),
			redis: asRedis(redis),
		});

		await sm.withSession("default", "sbx", async () => {
			/* first exec, no writes */
		});
		await sm.withSession("default", "sbx", async () => {
			/* second exec, no writes */
		});

		expect(stub.reloadCount).toBe(0);
		expect(redis.store.has("vfs:default:ver:sbx")).toBe(false); // no INCR because never dirty
	});

	it("reloads and updates lastSeenVersion when Redis version is ahead", async () => {
		const redis = new FakeRedis();
		const stub = new StubCoherentFs();
		const sm = new SessionManager({
			createFs: makeFsFactory(stub),
			redis: asRedis(redis),
		});

		// First exec creates the session at version 0
		await sm.withSession("default", "sbx", async () => {});
		expect(sm.getSession("default", "sbx")?.lastSeenVersion).toBe(0);

		// Simulate another replica bumping the version externally
		redis.store.set("vfs:default:ver:sbx", { value: "5", expiresAt: Date.now() + 60_000 });

		await sm.withSession("default", "sbx", async () => {
			// During this turn, ensureFreshCache should have reloaded.
			expect(stub.reloadCount).toBe(1);
		});

		expect(sm.getSession("default", "sbx")?.lastSeenVersion).toBe(5);
	});

	it("bumps Redis version on dirty exit and updates lastSeenVersion", async () => {
		const redis = new FakeRedis();
		const stub = new StubCoherentFs();
		const sm = new SessionManager({
			createFs: makeFsFactory(stub),
			redis: asRedis(redis),
		});

		await sm.withSession("default", "sbx", async () => {
			stub.dirty = true; // simulate a mutation
		});

		expect(redis.store.get("vfs:default:ver:sbx")?.value).toBe("1");
		expect(sm.getSession("default", "sbx")?.lastSeenVersion).toBe(1);
	});

	it("does not INCR when no mutation occurred", async () => {
		const redis = new FakeRedis();
		const stub = new StubCoherentFs();
		const sm = new SessionManager({
			createFs: makeFsFactory(stub),
			redis: asRedis(redis),
		});

		await sm.withSession("default", "sbx", async () => {
			// Pure read turn
		});

		expect(redis.store.has("vfs:default:ver:sbx")).toBe(false);
	});

	it("sequential dirty turns bump the counter each time", async () => {
		const redis = new FakeRedis();
		const stub = new StubCoherentFs();
		const sm = new SessionManager({
			createFs: makeFsFactory(stub),
			redis: asRedis(redis),
		});

		await sm.withSession("default", "sbx", async () => {
			stub.dirty = true;
		});
		await sm.withSession("default", "sbx", async () => {
			stub.dirty = true;
		});
		await sm.withSession("default", "sbx", async () => {
			stub.dirty = true;
		});

		expect(redis.store.get("vfs:default:ver:sbx")?.value).toBe("3");
		expect(sm.getSession("default", "sbx")?.lastSeenVersion).toBe(3);
		// No spurious reloads since the same replica did all three.
		expect(stub.reloadCount).toBe(0);
	});

	it("destroy deletes the version key", async () => {
		const redis = new FakeRedis();
		const stub = new StubCoherentFs();
		const sm = new SessionManager({
			createFs: makeFsFactory(stub),
			destroySandboxFn: vi.fn().mockResolvedValue(undefined),
			redis: asRedis(redis),
		});

		await sm.withSession("default", "sbx", async () => {
			stub.dirty = true;
		});
		expect(redis.store.has("vfs:default:ver:sbx")).toBe(true);

		await sm.destroy("default", "sbx");
		expect(redis.store.has("vfs:default:ver:sbx")).toBe(false);
	});

	it("destroy on an unknown sandbox still deletes stale version key", async () => {
		const redis = new FakeRedis();
		// Stale key left behind by a previous incarnation
		redis.store.set("vfs:default:ver:sbx", { value: "42", expiresAt: Date.now() + 60_000 });

		const sm = new SessionManager({
			createFs: makeFsFactory(new StubCoherentFs()),
			destroySandboxFn: vi.fn().mockResolvedValue(undefined),
			redis: asRedis(redis),
		});

		await sm.destroy("default", "sbx");
		expect(redis.store.has("vfs:default:ver:sbx")).toBe(false);
	});

	it("withExistingSession applies the same version check", async () => {
		const redis = new FakeRedis();
		const stub = new StubCoherentFs();
		const sm = new SessionManager({
			createFs: makeFsFactory(stub),
			redis: asRedis(redis),
		});

		// Warm the session first
		await sm.withSession("default", "sbx", async () => {});
		expect(sm.getSession("default", "sbx")?.lastSeenVersion).toBe(0);

		// External bump
		redis.store.set("vfs:default:ver:sbx", { value: "9", expiresAt: Date.now() + 60_000 });

		await sm.withExistingSession("default", "sbx", async () => {
			expect(stub.reloadCount).toBe(1);
		});
		expect(sm.getSession("default", "sbx")?.lastSeenVersion).toBe(9);
	});

	it("skips version logic entirely when no Redis is configured", async () => {
		const stub = new StubCoherentFs();
		const sm = new SessionManager({
			createFs: makeFsFactory(stub),
		});

		await sm.withSession("default", "sbx", async () => {
			stub.dirty = true;
		});

		// No Redis → no reload, no INCR — just a plain exec turn.
		expect(stub.reloadCount).toBe(0);
	});

	it("surfaces ECOHERENCE on transient INCR error, preserves dirty flag, forces stale lastSeenVersion", async () => {
		const redis = new FakeRedis();
		const stub = new StubCoherentFs();
		const sm = new SessionManager({
			createFs: makeFsFactory(stub),
			redis: asRedis(redis),
		});

		// Warm the session (no INCR because not dirty).
		await sm.withSession("default", "sbx", async () => {});

		// Next turn: mutation happens, but INCR throws once.
		const incrSpy = vi.spyOn(redis, "incr").mockRejectedValueOnce(new Error("ECONNRESET"));

		// The write committed but cross-replica coherence did not — caller must
		// see ECOHERENCE so they can retry instead of falsely thinking the write
		// fully succeeded.
		await expect(
			sm.withSession("default", "sbx", async () => {
				stub.dirty = true;
			}),
		).rejects.toMatchObject({ code: "ECOHERENCE" });

		// Dirty flag must survive — the publish failed and the next turn needs
		// to retry the bump.
		expect(stub.dirty).toBe(true);
		// lastSeenVersion is forced to -1 so the next ensureFreshCache reloads
		// from Postgres before serving any read.
		expect(sm.getSession("default", "sbx")?.lastSeenVersion).toBe(-1);
		expect(redis.store.has("vfs:default:ver:sbx")).toBe(false);

		// Next turn: INCR works, the pending bump flushes.
		incrSpy.mockRestore();
		await sm.withSession("default", "sbx", async () => {
			// dirty still set from the prior failed turn — no new mutation needed.
		});

		expect(redis.store.get("vfs:default:ver:sbx")?.value).toBe("1");
		expect(sm.getSession("default", "sbx")?.lastSeenVersion).toBe(1);
		expect(stub.dirty).toBe(false);
	});

	it("ensureFreshCache reloads from PG on transient GET error without failing the turn", async () => {
		const redis = new FakeRedis();
		const stub = new StubCoherentFs();
		const sm = new SessionManager({
			createFs: makeFsFactory(stub),
			redis: asRedis(redis),
		});

		// Warm the session.
		await sm.withSession("default", "sbx", async () => {});

		// First version read fails — ensureFreshCache falls back to reload from PG
		// so we don't serve stale data. The subsequent INCR for the mutation
		// should still succeed and advance the counter. (The read uses GETEX so the
		// counter's TTL is refreshed on every access — audit H6.)
		const getSpy = vi.spyOn(redis, "getex").mockRejectedValueOnce(new Error("ECONNRESET"));

		await expect(
			sm.withSession("default", "sbx", async () => {
				stub.dirty = true;
			}),
		).resolves.toBeUndefined();

		getSpy.mockRestore();

		// Reload happened because version couldn't be checked.
		expect(stub.reloadCount).toBe(1);
		// INCR still ran at end-of-turn.
		expect(redis.store.get("vfs:default:ver:sbx")?.value).toBe("1");
	});

	it("ensureFreshCache no longer strands the dirty flag on version match", async () => {
		// Regression guard for the bug where ensureFreshCache unconditionally
		// cleared dirty in the match branch, masking a failed prior publish.
		const redis = new FakeRedis();
		const stub = new StubCoherentFs();
		const sm = new SessionManager({
			createFs: makeFsFactory(stub),
			redis: asRedis(redis),
		});

		// Pre-seed a dirty flag as if a prior publish failed.
		await sm.withSession("default", "sbx", async () => {});
		stub.dirty = true;
		const session = sm.getSession("default", "sbx");
		if (session === undefined) throw new Error("expected session");
		session.lastSeenVersion = 0; // matches current redis value

		await sm.withSession("default", "sbx", async () => {
			/* no new mutation */
		});

		// The pending dirty bit must have triggered a real INCR, not been
		// silently swallowed by ensureFreshCache.
		expect(redis.store.get("vfs:default:ver:sbx")?.value).toBe("1");
		expect(sm.getSession("default", "sbx")?.lastSeenVersion).toBe(1);
	});

	it("publishes version even when fn throws after a committed mutation", async () => {
		// Regression guard: mutations in SqlFs commit to Postgres BEFORE the dirty
		// bit flips. If a multi-step exec writes successfully and then fails on a
		// later command, peers must still observe the INCR so they invalidate
		// their caches.
		const redis = new FakeRedis();
		const stub = new StubCoherentFs();
		const sm = new SessionManager({
			createFs: makeFsFactory(stub),
			redis: asRedis(redis),
		});

		await expect(
			sm.withSession("default", "sbx", async () => {
				stub.dirty = true; // simulate a successful mutation
				throw Object.assign(new Error("ENOENT: later step failed"), { code: "ENOENT" });
			}),
		).rejects.toThrow("ENOENT");

		// The counter must have bumped despite the throw; other replicas will
		// see v=1 and reload on their next turn.
		expect(redis.store.get("vfs:default:ver:sbx")?.value).toBe("1");
		expect(sm.getSession("default", "sbx")?.lastSeenVersion).toBe(1);
		expect(stub.dirty).toBe(false);
	});

	it("withExistingSession also publishes on fn throw", async () => {
		const redis = new FakeRedis();
		const stub = new StubCoherentFs();
		const sm = new SessionManager({
			createFs: makeFsFactory(stub),
			redis: asRedis(redis),
		});

		// Warm the session so withExistingSession finds it.
		await sm.withSession("default", "sbx", async () => {});

		await expect(
			sm.withExistingSession("default", "sbx", async () => {
				stub.dirty = true;
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");

		expect(redis.store.get("vfs:default:ver:sbx")?.value).toBe("1");
		expect(sm.getSession("default", "sbx")?.lastSeenVersion).toBe(1);
	});

	it("non-coherent fs (memory backend) skips reload/publish but exec still works", async () => {
		const redis = new FakeRedis();
		// A plain IFileSystem without reload/wasDirty
		const plainFs: Partial<IFileSystem> = {
			getAllPaths: () => [],
		};
		const sm = new SessionManager({
			createFs: vi.fn(async () => plainFs as IFileSystem),
			redis: asRedis(redis),
		});

		await sm.withSession("default", "sbx", async () => {
			/* ok */
		});

		// No version key created because the fs is not coherence-aware.
		expect(redis.store.has("vfs:default:ver:sbx")).toBe(false);
	});

	it("partial fs missing clearDirty is rejected by the guard (no runtime crash)", async () => {
		// Regression guard: if the runtime check only tested for reload/wasDirty,
		// publishVersionIfDirty would later call coherent.clearDirty() and throw.
		const redis = new FakeRedis();
		const partial: Partial<IFileSystem> & Record<string, unknown> = {
			getAllPaths: () => [],
			reload: async () => {},
			wasDirty: () => true,
			// clearDirty intentionally omitted
		};
		const sm = new SessionManager({
			createFs: vi.fn(async () => partial as IFileSystem),
			redis: asRedis(redis),
		});

		await expect(
			sm.withSession("default", "sbx", async () => {
				/* nothing */
			}),
		).resolves.toBeUndefined();

		// Treated as non-coherent: no INCR, no reload attempt.
		expect(redis.store.has("vfs:default:ver:sbx")).toBe(false);
	});
});

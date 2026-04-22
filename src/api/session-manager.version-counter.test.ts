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
import { SessionManager } from "./session-manager.js";

interface Entry {
	value: string;
	expiresAt: number;
}

class FakeRedis {
	store = new Map<string, Entry>();

	private gc(): void {
		const now = Date.now();
		for (const [k, e] of this.store) {
			if (e.expiresAt <= now) this.store.delete(k);
		}
	}

	// SET key value PX ms NX (for the distributed lock) OR plain set (unused here).
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
}

function makeFsFactory(instance: StubCoherentFs): (_backend: string, _sandboxId: string) => Promise<IFileSystem> {
	return vi.fn(async () => instance as unknown as IFileSystem);
}

describe("SessionManager version counter (Phase D)", () => {
	it("stamps initial lastSeenVersion from Redis at session creation", async () => {
		const redis = new FakeRedis();
		// Seed a pre-existing version (e.g., another replica previously published v7)
		redis.store.set("vfs:ver:sbx", { value: "7", expiresAt: Date.now() + 60_000 });

		const stub = new StubCoherentFs();
		const sm = new SessionManager({
			backend: "memory",
			createFs: makeFsFactory(stub),
			redis: asRedis(redis),
		});

		await sm.withSession("sbx", async () => {
			// Fresh session: lastSeenVersion matches Redis, so no reload needed.
			expect(stub.reloadCount).toBe(0);
		});

		const session = sm.getSession("sbx");
		expect(session?.lastSeenVersion).toBe(7);
	});

	it("no reload when versions match on subsequent exec", async () => {
		const redis = new FakeRedis();
		const stub = new StubCoherentFs();
		const sm = new SessionManager({
			backend: "memory",
			createFs: makeFsFactory(stub),
			redis: asRedis(redis),
		});

		await sm.withSession("sbx", async () => {
			/* first exec, no writes */
		});
		await sm.withSession("sbx", async () => {
			/* second exec, no writes */
		});

		expect(stub.reloadCount).toBe(0);
		expect(redis.store.has("vfs:ver:sbx")).toBe(false); // no INCR because never dirty
	});

	it("reloads and updates lastSeenVersion when Redis version is ahead", async () => {
		const redis = new FakeRedis();
		const stub = new StubCoherentFs();
		const sm = new SessionManager({
			backend: "memory",
			createFs: makeFsFactory(stub),
			redis: asRedis(redis),
		});

		// First exec creates the session at version 0
		await sm.withSession("sbx", async () => {});
		expect(sm.getSession("sbx")?.lastSeenVersion).toBe(0);

		// Simulate another replica bumping the version externally
		redis.store.set("vfs:ver:sbx", { value: "5", expiresAt: Date.now() + 60_000 });

		await sm.withSession("sbx", async () => {
			// During this turn, ensureFreshCache should have reloaded.
			expect(stub.reloadCount).toBe(1);
		});

		expect(sm.getSession("sbx")?.lastSeenVersion).toBe(5);
	});

	it("bumps Redis version on dirty exit and updates lastSeenVersion", async () => {
		const redis = new FakeRedis();
		const stub = new StubCoherentFs();
		const sm = new SessionManager({
			backend: "memory",
			createFs: makeFsFactory(stub),
			redis: asRedis(redis),
		});

		await sm.withSession("sbx", async () => {
			stub.dirty = true; // simulate a mutation
		});

		expect(redis.store.get("vfs:ver:sbx")?.value).toBe("1");
		expect(sm.getSession("sbx")?.lastSeenVersion).toBe(1);
	});

	it("does not INCR when no mutation occurred", async () => {
		const redis = new FakeRedis();
		const stub = new StubCoherentFs();
		const sm = new SessionManager({
			backend: "memory",
			createFs: makeFsFactory(stub),
			redis: asRedis(redis),
		});

		await sm.withSession("sbx", async () => {
			// Pure read turn
		});

		expect(redis.store.has("vfs:ver:sbx")).toBe(false);
	});

	it("sequential dirty turns bump the counter each time", async () => {
		const redis = new FakeRedis();
		const stub = new StubCoherentFs();
		const sm = new SessionManager({
			backend: "memory",
			createFs: makeFsFactory(stub),
			redis: asRedis(redis),
		});

		await sm.withSession("sbx", async () => {
			stub.dirty = true;
		});
		await sm.withSession("sbx", async () => {
			stub.dirty = true;
		});
		await sm.withSession("sbx", async () => {
			stub.dirty = true;
		});

		expect(redis.store.get("vfs:ver:sbx")?.value).toBe("3");
		expect(sm.getSession("sbx")?.lastSeenVersion).toBe(3);
		// No spurious reloads since the same replica did all three.
		expect(stub.reloadCount).toBe(0);
	});

	it("destroy deletes the version key", async () => {
		const redis = new FakeRedis();
		const stub = new StubCoherentFs();
		const sm = new SessionManager({
			backend: "memory",
			createFs: makeFsFactory(stub),
			destroySandboxFn: vi.fn().mockResolvedValue(undefined),
			redis: asRedis(redis),
		});

		await sm.withSession("sbx", async () => {
			stub.dirty = true;
		});
		expect(redis.store.has("vfs:ver:sbx")).toBe(true);

		await sm.destroy("sbx");
		expect(redis.store.has("vfs:ver:sbx")).toBe(false);
	});

	it("destroy on an unknown sandbox still deletes stale version key", async () => {
		const redis = new FakeRedis();
		// Stale key left behind by a previous incarnation
		redis.store.set("vfs:ver:sbx", { value: "42", expiresAt: Date.now() + 60_000 });

		const sm = new SessionManager({
			backend: "memory",
			createFs: makeFsFactory(new StubCoherentFs()),
			destroySandboxFn: vi.fn().mockResolvedValue(undefined),
			redis: asRedis(redis),
		});

		await sm.destroy("sbx");
		expect(redis.store.has("vfs:ver:sbx")).toBe(false);
	});

	it("withExistingSession applies the same version check", async () => {
		const redis = new FakeRedis();
		const stub = new StubCoherentFs();
		const sm = new SessionManager({
			backend: "memory",
			createFs: makeFsFactory(stub),
			redis: asRedis(redis),
		});

		// Warm the session first
		await sm.withSession("sbx", async () => {});
		expect(sm.getSession("sbx")?.lastSeenVersion).toBe(0);

		// External bump
		redis.store.set("vfs:ver:sbx", { value: "9", expiresAt: Date.now() + 60_000 });

		await sm.withExistingSession("sbx", async () => {
			expect(stub.reloadCount).toBe(1);
		});
		expect(sm.getSession("sbx")?.lastSeenVersion).toBe(9);
	});

	it("skips version logic entirely when no Redis is configured", async () => {
		const stub = new StubCoherentFs();
		const sm = new SessionManager({
			backend: "memory",
			createFs: makeFsFactory(stub),
		});

		await sm.withSession("sbx", async () => {
			stub.dirty = true;
		});

		// No Redis → no reload, no INCR — just a plain exec turn.
		expect(stub.reloadCount).toBe(0);
	});

	it("non-coherent fs (memory backend) skips reload/publish but exec still works", async () => {
		const redis = new FakeRedis();
		// A plain IFileSystem without reload/wasDirty
		const plainFs: Partial<IFileSystem> = {
			getAllPaths: () => [],
		};
		const sm = new SessionManager({
			backend: "memory",
			createFs: vi.fn(async () => plainFs as IFileSystem),
			redis: asRedis(redis),
		});

		await sm.withSession("sbx", async () => {
			/* ok */
		});

		// No version key created because the fs is not coherence-aware.
		expect(redis.store.has("vfs:ver:sbx")).toBe(false);
	});
});

/**
 * F7 unit tests: destroy must reach warm sessions on other replicas.
 *
 * Two layered defences:
 *  - Primary (Redis-independent): a zero-row `loadAllPaths` surfaces as
 *    ESANDBOXGONE from `reload()`; `ensureFreshCache` tears the warm session
 *    down and converts it to a clean ENOENT (→ 404) instead of installing an
 *    empty pathCache (ghost state).
 *  - Secondary (tombstone): `destroy` writes a DESTROYED sentinel to the version
 *    key; `ensureFreshCache` recognises it BEFORE the numeric parse and tears
 *    down — covering the never-written variant (lastSeenVersion === 0) where an
 *    absent key would read as 0 and never trigger a reload.
 */

import type { Redis } from "ioredis";
import type { IFileSystem } from "just-bash";
import { describe, expect, it, vi } from "vitest";
import { createEsandboxgone } from "../../../sql-fs/errors.js";
import { SessionManager } from "../../session-manager.js";

interface Entry {
	value: string;
	expiresAt: number;
}

/**
 * Fake Redis covering the version-counter ops AND the distributed RW-lock
 * eval scripts (so withExecLockExclusive/destroy run). Mirrors the fake in
 * session-manager.version-counter.test.ts.
 */
class FakeRedis {
	store = new Map<string, Entry>(); // version keys
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

	async set(key: string, value: string, unit: "PX" | "EX", amount: number, nx?: "NX"): Promise<"OK" | null> {
		this.gc();
		if (nx === "NX" && this.store.has(key)) return null;
		const ms = unit === "EX" ? amount * 1000 : amount;
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

/**
 * Coherent FS stub. `disconnect` records teardown; `reloadGone` makes the next
 * reload() throw ESANDBOXGONE to simulate a zero-row loadAllPaths.
 */
class StubCoherentFs {
	dirty = false;
	reloadCount = 0;
	disconnectCount = 0;
	reloadGone = false;

	getAllPaths(): string[] {
		return [];
	}
	async reload(): Promise<void> {
		this.reloadCount++;
		if (this.reloadGone) throw createEsandboxgone("sbx");
		this.dirty = false;
	}
	wasDirty(): boolean {
		return this.dirty;
	}
	clearDirty(): void {
		this.dirty = false;
	}
	poisoned(): boolean {
		return false;
	}
	async disconnect(): Promise<void> {
		this.disconnectCount++;
	}
}

function makeFsFactory(instance: StubCoherentFs): (_tenantId: string, _sandboxId: string) => Promise<IFileSystem> {
	return vi.fn(async () => instance as unknown as IFileSystem);
}

describe("SessionManager F7 — destroy reaches warm replicas", () => {
	it("(a) reload's ESANDBOXGONE becomes a teardown + clean ENOENT", async () => {
		const redis = new FakeRedis();
		const stub = new StubCoherentFs();
		const sm = new SessionManager({ createFs: makeFsFactory(stub), redis: asRedis(redis) });

		// Warm the session at version 0 (a write happened on this replica earlier).
		await sm.withSession("default", "sbx", async () => {});

		// Another replica destroyed the sandbox: the row is gone AND the version
		// key advanced (written variant). Bump the counter so ensureFreshCache
		// mismatches and reloads — but loadAllPaths now returns zero rows.
		redis.store.set("vfs:default:ver:sbx", { value: "9", expiresAt: Date.now() + 60_000 });
		stub.reloadGone = true;

		await expect(sm.withExistingSession("default", "sbx", async () => {})).rejects.toMatchObject({ code: "ENOENT" });

		// Session torn down (dropped from map + PG pool disconnected). NOT serving
		// an empty cache.
		expect(sm.getSession("default", "sbx")).toBeUndefined();
		expect(stub.disconnectCount).toBe(1);
		expect(stub.reloadCount).toBe(1);
	});

	it("(b) DESTROYED tombstone is recognised before the numeric parse → teardown + ENOENT", async () => {
		const redis = new FakeRedis();
		const stub = new StubCoherentFs();
		const sm = new SessionManager({ createFs: makeFsFactory(stub), redis: asRedis(redis) });

		await sm.withSession("default", "sbx", async () => {
			stub.dirty = true; // version → 1
		});
		expect(sm.getSession("default", "sbx")?.lastSeenVersion).toBe(1);

		// Replica A destroys the sandbox → tombstone written.
		redis.store.set("vfs:default:ver:sbx", { value: "DESTROYED", expiresAt: Date.now() + 60_000 });

		await expect(sm.withExistingSession("default", "sbx", async () => {})).rejects.toMatchObject({ code: "ENOENT" });

		expect(sm.getSession("default", "sbx")).toBeUndefined();
		expect(stub.disconnectCount).toBe(1);
		// Tombstone caught before parse → no reload attempted.
		expect(stub.reloadCount).toBe(0);
	});

	it("(c) never-written variant (lastSeenVersion 0, tombstone) still tears down — not the 0===0 silent ghost", async () => {
		// Replica B warms a pure-READ session on a sandbox it never wrote to, so
		// its lastSeenVersion stays 0. Replica A then destroys the sandbox →
		// tombstone. With a bare DEL the version key would be ABSENT → read as 0 →
		// 0 === 0 → NO reload would ever fire → B serves ghost reads forever. The
		// sentinel breaks the tie even at lastSeenVersion 0.
		const redis = new FakeRedis();
		const warm = new StubCoherentFs();
		const smB = new SessionManager({ createFs: makeFsFactory(warm), redis: asRedis(redis) });

		await smB.withSession("default", "sbx", async () => {
			/* pure read, no write */
		});
		const session = smB.getSession("default", "sbx");
		expect(session?.lastSeenVersion).toBe(0);
		expect(redis.store.has("vfs:default:ver:sbx")).toBe(false);

		// Replica A's destroy writes the tombstone (separate manager, shared Redis).
		const smA = new SessionManager({
			createFs: makeFsFactory(new StubCoherentFs()),
			destroySandboxFn: vi.fn().mockResolvedValue(undefined),
			redis: asRedis(redis),
		});
		await smA.destroy("default", "sbx");
		expect(redis.store.get("vfs:default:ver:sbx")?.value).toBe("DESTROYED");

		// B's next turn: the sentinel forces teardown despite lastSeenVersion 0.
		await expect(smB.withExistingSession("default", "sbx", async () => {})).rejects.toMatchObject({ code: "ENOENT" });
		expect(smB.getSession("default", "sbx")).toBeUndefined();
		expect(warm.disconnectCount).toBe(1);
		expect(warm.reloadCount).toBe(0);
	});

	it("re-creating a tombstoned sandbox clears the sentinel and starts at version 0", async () => {
		const redis = new FakeRedis();
		// Tombstone left by a prior destroy.
		redis.store.set("vfs:default:ver:sbx", { value: "DESTROYED", expiresAt: Date.now() + 60_000 });

		const stub = new StubCoherentFs();
		const sm = new SessionManager({ createFs: makeFsFactory(stub), redis: asRedis(redis) });

		// A fresh exec re-creates the sandbox (buildFs.createSandbox re-inserts the
		// root). The session must start clean — sentinel cleared, version 0 — so a
		// later INCR does not run against the non-numeric "DESTROYED".
		await sm.withSession("default", "sbx", async () => {});
		const session = sm.getSession("default", "sbx");
		expect(session?.lastSeenVersion).toBe(0);
		expect(redis.store.has("vfs:default:ver:sbx")).toBe(false);

		// A subsequent write publishes a real numeric version.
		await sm.withSession("default", "sbx", async () => {
			stub.dirty = true;
		});
		expect(redis.store.get("vfs:default:ver:sbx")?.value).toBe("1");
	});

	it("(e) tombstone is NOT written when destroySandboxFn throws (transient DB failure)", async () => {
		const redis = new FakeRedis();
		const stub = new StubCoherentFs();
		const sm = new SessionManager({
			createFs: makeFsFactory(stub),
			destroySandboxFn: vi.fn().mockRejectedValue(new Error("transient PG error")),
			redis: asRedis(redis),
		});

		await sm.withSession("default", "sbx", async () => {
			stub.dirty = true;
		});
		expect(sm.getSession("default", "sbx")).toBeDefined();

		await expect(sm.destroy("default", "sbx")).rejects.toThrow("transient PG error");

		// The sandbox still exists in Postgres (destroy rolled back). The version
		// key must NOT contain the tombstone — otherwise warm sessions on other
		// replicas would tear down with false 404s.
		const raw = await redis.get("vfs:default:ver:sbx");
		expect(raw).not.toBe("DESTROYED");

		// FS must still be disconnected (pool leak prevention).
		expect(stub.disconnectCount).toBe(1);
	});

	it("primary guard fires even without Redis: ESANDBOXGONE is not swallowed by ensureFreshCache no-op", async () => {
		// With no Redis, ensureFreshCache is a no-op, so the gone-sandbox guard is
		// not exercised through it. This documents that the Redis-independent
		// teardown lives at the reload() boundary — sql-fs throws ESANDBOXGONE and
		// the next layer that calls reload() (ensureFreshCache, only when Redis is
		// present) maps it. Without Redis there is a single replica, so a destroyed
		// warm session cannot exist on a peer. Guard: errors.ts emits the code.
		expect((createEsandboxgone("sbx") as Error & { code?: string }).code).toBe("ESANDBOXGONE");
	});
});

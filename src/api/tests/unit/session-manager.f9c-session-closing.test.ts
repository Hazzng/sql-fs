/**
 * F9c regression: reaper-vs-straggler probe must surface ESESSIONCLOSING (503),
 * not an unmapped error (500).
 *
 * The reaper sets `session.state = "closing"` synchronously before disconnecting
 * the FS. A request that already passed the top-of-entry `closing` guard can
 * still run the pre-lock `ensureFreshCache` probe against a pool being torn down
 * — the reload then throws `PostgresDialect: not connected` (no `code` → default
 * 500). The fix wraps both pre-lock probes (`withSessionEntry`,
 * `withSessionReadEntry`) in a try/catch that, when `state === "closing"`,
 * converts the failure into a retryable ESESSIONCLOSING (503).
 *
 * These tests faithfully simulate the race by having `reload()` flip the session
 * into `"closing"` and then throw (as if the reaper fired mid-probe).
 */

import type { Redis } from "ioredis";
import { InMemoryFs } from "just-bash";
import type { IFileSystem } from "just-bash";
import { describe, expect, it } from "vitest";
import { mapFsErrorToStatus } from "../../errors.js";
import { SessionManager } from "../../session-manager.js";

const T = "default";

/** A reload error that carries NO `code`, exactly like `PostgresDialect: not connected`. */
const POOL_GONE = new Error("PostgresDialect: not connected");

/**
 * Coherent InMemoryFs whose `reload()` runs a test-supplied hook. The hook lets
 * a test flip the owning session's `state` and throw, simulating the reaper
 * disconnecting the pool while the straggler's probe is on the wire.
 */
class CoherentInMemoryFs {
	readonly inner: InMemoryFs;
	#dirty = false;
	onReload: () => void = () => {};
	constructor() {
		this.inner = new InMemoryFs();
	}
	wasDirty(): boolean {
		return this.#dirty;
	}
	clearDirty(): void {
		this.#dirty = false;
	}
	poisoned(): boolean {
		return false;
	}
	async reload(): Promise<void> {
		this.onReload();
	}
}

function adaptCoherentFs(host: CoherentInMemoryFs): IFileSystem {
	const fs = host.inner as unknown as Record<string, unknown>;
	return new Proxy(host as unknown as Record<string, unknown>, {
		get(target, prop, receiver) {
			if (prop in target) return Reflect.get(target, prop, receiver);
			const v = fs[prop as string];
			return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(host.inner) : v;
		},
	}) as unknown as IFileSystem;
}

/**
 * ZSET-aware FakeRedis — same lock-script implementation used by
 * session-manager.exec-lock.test.ts, so both the shared (read) and exclusive
 * (write) distributed RW locks acquire/renew/release correctly. Extended with
 * the version-counter surface (`getex`) that `ensureFreshCache` probes; it
 * returns `99` so a session whose `lastSeenVersion` is reset to `0` always sees
 * a mismatch and calls `reload()`.
 */
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

	async getex(_key: string, ..._rest: unknown[]): Promise<string> {
		return "99";
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

function makeFakeRedis(): Redis {
	return new FakeRedis() as unknown as Redis;
}

describe("F9c: reaper-vs-straggler probe surfaces ESESSIONCLOSING (503)", () => {
	it("withSessionRead: a probe that fails while state==='closing' throws ESESSIONCLOSING (→503), not 500", async () => {
		const host = new CoherentInMemoryFs();
		const sm = new SessionManager({ createFs: async () => adaptCoherentFs(host), redis: makeFakeRedis() });
		await sm.getOrCreate(T, "sb-race-read");
		const session = sm.getSession(T, "sb-race-read");
		if (session === undefined) throw new Error("setup: session missing");
		// Force a version mismatch (Redis reports 99) so ensureFreshCache calls reload().
		session.lastSeenVersion = 0;

		// Simulate the reaper firing during the pre-lock probe: reload() marks the
		// session closing and then throws the (uncoded) pool-gone error.
		host.onReload = () => {
			session.state = "closing";
			throw POOL_GONE;
		};

		const err = await sm
			.withSessionRead(T, "sb-race-read", async () => "unreachable")
			.then(
				() => undefined,
				(e: unknown) => e as Error & { code?: string },
			);

		expect(err).toBeDefined();
		expect(err?.code).toBe("ESESSIONCLOSING");
		expect(err?.message).toBe("ESESSIONCLOSING: session is shutting down, retry");
		expect(mapFsErrorToStatus(err as Error)).toBe(503);
		// The raw, uncoded pool error must NOT leak through (it would map to 500).
		expect(err).not.toBe(POOL_GONE);

		await sm.shutdown();
	});

	it("withSession: a probe that fails while state==='closing' throws ESESSIONCLOSING (→503), not 500", async () => {
		const host = new CoherentInMemoryFs();
		const sm = new SessionManager({ createFs: async () => adaptCoherentFs(host), redis: makeFakeRedis() });
		await sm.getOrCreate(T, "sb-race-write");
		const session = sm.getSession(T, "sb-race-write");
		if (session === undefined) throw new Error("setup: session missing");
		session.lastSeenVersion = 0;

		host.onReload = () => {
			session.state = "closing";
			throw POOL_GONE;
		};

		const err = await sm
			.withSession(T, "sb-race-write", async () => "unreachable")
			.then(
				() => undefined,
				(e: unknown) => e as Error & { code?: string },
			);

		expect(err).toBeDefined();
		expect(err?.code).toBe("ESESSIONCLOSING");
		expect(err?.message).toBe("ESESSIONCLOSING: session is shutting down, retry");
		expect(mapFsErrorToStatus(err as Error)).toBe(503);
		expect(err).not.toBe(POOL_GONE);

		await sm.shutdown();
	});

	it("negative control: a probe failure while state is normal propagates the ORIGINAL error (→500)", async () => {
		const host = new CoherentInMemoryFs();
		const sm = new SessionManager({ createFs: async () => adaptCoherentFs(host), redis: makeFakeRedis() });
		await sm.getOrCreate(T, "sb-no-race");
		const session = sm.getSession(T, "sb-no-race");
		if (session === undefined) throw new Error("setup: session missing");
		session.lastSeenVersion = 0;

		// reload throws but the session is NOT closing — the original (uncoded)
		// error must surface unchanged, mapping to a 500 as before the fix.
		host.onReload = () => {
			throw POOL_GONE;
		};

		const err = await sm
			.withSessionRead(T, "sb-no-race", async () => "unreachable")
			.then(
				() => undefined,
				(e: unknown) => e as Error & { code?: string },
			);

		expect(err).toBe(POOL_GONE);
		expect(err?.code).toBeUndefined();
		expect(mapFsErrorToStatus(err as Error)).toBe(500);

		await sm.shutdown();
	});
});

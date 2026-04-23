/**
 * Unit tests for SessionManager + distributed exec lock integration (Phase C).
 *
 * Exercises:
 *   - withSession/withExistingSession/destroy acquire the Redis lock (by key).
 *   - Concurrent operations across two SessionManagers sharing the same mock
 *     Redis serialize on the distributed lock.
 *   - Destroy-vs-exec: destroy waits for in-flight exec.
 *   - ELOCKTIMEOUT propagates when the acquire window elapses.
 *
 * No real Redis — uses an in-process fake with SET NX PX + token-aware EVAL.
 */

import type { Redis } from "ioredis";
import { InMemoryFs } from "just-bash";
import type { IFileSystem } from "just-bash";
import { describe, expect, it, vi } from "vitest";
import { execLockKey } from "../distributed-lock.js";
import { SessionManager } from "../session-manager.js";

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

function asRedis(f: FakeRedis): Redis {
	return f as unknown as Redis;
}

function makeCreateFs() {
	return vi.fn((_backend: string, _sandboxId: string): Promise<IFileSystem> => Promise.resolve(new InMemoryFs()));
}

describe("SessionManager + distributed exec lock", () => {
	it("withSession takes and releases the Redis lock around fn", async () => {
		const redis = new FakeRedis();
		const sm = new SessionManager({ backend: "memory", createFs: makeCreateFs(), redis: asRedis(redis) });

		let observedLock: Entry | undefined;
		await sm.withSession("sbx-A", async () => {
			observedLock = redis.store.get(execLockKey("sbx-A"));
		});

		expect(observedLock).toBeDefined();
		expect(redis.store.has(execLockKey("sbx-A"))).toBe(false);
	});

	it("two SessionManagers sharing the same Redis serialize concurrent withSession", async () => {
		const redis = new FakeRedis();
		const smA = new SessionManager({ backend: "memory", createFs: makeCreateFs(), redis: asRedis(redis) });
		const smB = new SessionManager({ backend: "memory", createFs: makeCreateFs(), redis: asRedis(redis) });

		const order: string[] = [];

		const callA = smA.withSession("sbx-shared", async () => {
			order.push("A-start");
			await new Promise((r) => setTimeout(r, 80));
			order.push("A-end");
		});

		// Give A a chance to acquire before launching B
		await new Promise((r) => setTimeout(r, 5));

		const callB = smB.withSession("sbx-shared", async () => {
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
			backend: "memory",
			createFs: makeCreateFs(),
			destroySandboxFn: destroyFn,
			redis: asRedis(redis),
		});
		const smB = new SessionManager({
			backend: "memory",
			createFs: makeCreateFs(),
			destroySandboxFn: destroyFn,
			redis: asRedis(redis),
		});

		const events: string[] = [];

		// Pre-warm a session in smA so destroy actually tears down local state
		await smA.withSession("sbx-D", async () => {
			events.push("prewarm");
		});

		let releaseExec!: () => void;
		const execGate = new Promise<void>((resolve) => {
			releaseExec = resolve;
		});

		// smB kicks off a withSession holding the lock
		const execCall = smB.withSession("sbx-D", async () => {
			events.push("exec-start");
			await execGate;
			events.push("exec-end");
		});

		await new Promise((r) => setTimeout(r, 5));

		const destroyCall = smA.destroy("sbx-D");

		// Let destroy attempt to acquire — it should be blocked behind exec
		await new Promise((r) => setTimeout(r, 30));
		events.push("before-release");
		releaseExec();

		await Promise.all([execCall, destroyCall]);

		expect(events).toEqual(["prewarm", "exec-start", "before-release", "exec-end"]);
	});

	it("ELOCKTIMEOUT propagates when acquire times out", async () => {
		const redis = new FakeRedis();
		// Plant a foreign lock that will never release within the acquire window.
		redis.store.set(execLockKey("sbx-T"), { value: "owned-by-someone-else", expiresAt: Date.now() + 60_000 });

		const sm = new SessionManager({
			backend: "memory",
			createFs: makeCreateFs(),
			redis: asRedis(redis),
			execLockOptions: { acquireTimeoutMs: 100, acquireRetryMs: 20, leaseMs: 5_000, renewMs: 1_000 },
		});

		await expect(sm.withSession("sbx-T", async () => "nope")).rejects.toMatchObject({ code: "ELOCKTIMEOUT" });
	});

	it("single-replica (no Redis) mode skips the distributed lock", async () => {
		const sm = new SessionManager({ backend: "memory", createFs: makeCreateFs() });
		const result = await sm.withSession("sbx-solo", async () => "solo-ok");
		expect(result).toBe("solo-ok");
	});
});

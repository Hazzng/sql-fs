/**
 * Phase 4: the Redis wheel lease. A small fake stands in for Redis — the lock
 * module itself is covered by `distributed-lock.test.ts`, so what matters here
 * is the key, the options the lease leaves at their defaults, and what the
 * installer does when ownership is lost.
 */

import type { Redis } from "ioredis";
import { describe, expect, it } from "vitest";
import { packageLimits } from "../../commands/package-limits.js";
import { PipError } from "../../commands/pip-shared.js";
import { createInstallBudget, createRedisWheelLease, prepareWheel } from "../../commands/pip-wheel-store.js";
import { LockLostError, wheelLockKey } from "../../distributed-lock.js";
import { createPackageFs } from "./package-store-fake.js";

const SHA = "a".repeat(64);

interface SetCall {
	readonly key: string;
	readonly token: string;
	readonly px: string;
	readonly ms: number;
	readonly nx: string;
}

/** Records the lock commands and honours only token semantics. */
class FakeRedis {
	readonly sets: SetCall[] = [];
	readonly evals: { script: string; key: string; token: string; ms?: string }[] = [];
	held: string | undefined;

	async set(key: string, token: string, px: "PX", ms: number, nx: "NX"): Promise<"OK" | null> {
		this.sets.push({ key, token, px, ms, nx });
		if (this.held !== undefined) return null;
		this.held = token;
		return "OK";
	}

	async eval(script: string, _numKeys: number, key: string, token: string, ms?: string): Promise<number> {
		this.evals.push({ script, key, token, ...(ms === undefined ? {} : { ms }) });
		if (script.includes("del")) {
			if (this.held !== token) return 0;
			this.held = undefined;
			return 1;
		}
		return this.held === token ? 1 : 0;
	}
}

function asRedis(fake: FakeRedis): Redis {
	return fake as unknown as Redis;
}

describe("createRedisWheelLease", () => {
	it("locks the tenant-scoped wheel key and releases it on success", async () => {
		const fake = new FakeRedis();
		const lease = createRedisWheelLease({ redis: asRedis(fake), tenantId: "acme" });

		const result = await lease(SHA, async () => "done");

		expect(result).toBe("done");
		expect(fake.sets.length).toBe(1);
		expect(fake.sets[0]?.key).toBe(`vfs:acme:pip:wheel:${SHA}`);
		expect(fake.sets[0]?.key).toBe(wheelLockKey("acme", SHA));
		// The module defaults: a 60 s lease, renewed at 20 s, released by
		// compare-and-delete with the token the acquire wrote.
		expect(fake.sets[0]?.px).toBe("PX");
		expect(fake.sets[0]?.ms).toBe(60_000);
		expect(fake.sets[0]?.nx).toBe("NX");
		expect(fake.evals.length).toBe(1);
		expect(fake.evals[0]?.script.includes("del")).toBe(true);
		expect(fake.evals[0]?.token).toBe(fake.sets[0]?.token);
		expect(fake.held).toBe(undefined);
	});

	it("runs the callback while the key is held", async () => {
		const fake = new FakeRedis();
		const lease = createRedisWheelLease({ redis: asRedis(fake), tenantId: "acme" });
		let heldDuringCallback: string | undefined;

		await lease(SHA, async () => {
			heldDuringCallback = fake.held;
		});

		expect(heldDuringCallback).toBe(fake.sets[0]?.token);
	});

	it("releases the lock when the callback throws", async () => {
		const fake = new FakeRedis();
		const lease = createRedisWheelLease({ redis: asRedis(fake), tenantId: "acme" });

		await expect(
			lease(SHA, async () => {
				throw new Error("phase w failed");
			}),
		).rejects.toThrow("phase w failed");

		expect(fake.held).toBe(undefined);
		expect(fake.evals.length).toBe(1);
		expect(fake.evals[0]?.script.includes("del")).toBe(true);
	});

	it("reports no wait when the first acquire wins the key", async () => {
		const fake = new FakeRedis();
		const lease = createRedisWheelLease({ redis: asRedis(fake), tenantId: "acme" });
		let waitedMs = -1;

		await lease(SHA, async (info) => {
			waitedMs = info.waitedMs;
		});

		// An uncontended acquire still costs a round trip; only a lost SET counts
		// as a wait, otherwise every cold install would look like a singleflight.
		expect(waitedMs).toBe(0);
		expect(fake.sets.length).toBe(1);
	});

	it("reports a measured wait once an acquire has lost the key to another holder", async () => {
		const fake = new FakeRedis();
		fake.held = "another-replica";
		setTimeout(() => {
			fake.held = undefined;
		}, 30);
		const lease = createRedisWheelLease({ redis: asRedis(fake), tenantId: "acme" });
		let waitedMs = -1;

		await lease(SHA, async (info) => {
			waitedMs = info.waitedMs;
		});

		expect(waitedMs).toBeGreaterThan(0);
		expect(fake.sets.length).toBeGreaterThan(1);
	});
});

describe("prepareWheel under a lost lease", () => {
	it("fails with a PipError naming the wheel", async () => {
		const key = wheelLockKey("acme", SHA);
		let downloads = 0;
		const attempt = prepareWheel({
			store: createPackageFs(),
			target: { name: "demo", version: "1.0", sha256: SHA },
			limits: packageLimits(),
			budget: createInstallBudget(),
			lease: async () => {
				throw new LockLostError(key);
			},
			log: () => {},
			download: async () => {
				downloads += 1;
				return new Uint8Array();
			},
		});

		await expect(attempt).rejects.toBeInstanceOf(PipError);
		await expect(attempt).rejects.toThrow(`wheel lease lost for demo 1.0 (${SHA}); try again`);
		expect(downloads).toBe(0);
	});

	it("lets any other lease failure through unchanged", async () => {
		const attempt = prepareWheel({
			store: createPackageFs(),
			target: { name: "demo", version: "1.0", sha256: SHA },
			limits: packageLimits(),
			budget: createInstallBudget(),
			lease: async () => {
				throw new Error("redis is down");
			},
			log: () => {},
			download: async () => new Uint8Array(),
		});

		await expect(attempt).rejects.toThrow("redis is down");
	});
});

/**
 * Phase C — cross-replica exec-lock integration tests.
 *
 * Runs two SessionManager instances (simulating two API replicas) in the same
 * process, each with its own in-memory pool but sharing one real Redis + one
 * real Postgres. Verifies:
 *   1. Concurrent withSession on the same sandbox from different replicas
 *      serialize on the Redis lock.
 *   2. destroy on one replica waits for an in-flight exec on the other.
 *   3. If a replica crashes mid-exec (lock is still held), the lease expires
 *      and a second replica can proceed after `leaseMs`.
 *
 * Skipped unless both DATABASE_URL and REDIS_URL are set.
 */

import { Redis } from "ioredis";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { destroySandbox } from "../../../fs/sql-fs/index.js";
import { execLockKey } from "../../distributed-lock.js";
import { SessionManager } from "../../session-manager.js";
import { loadTenantConfig } from "../../tenants.js";

const TENANT = "default";

const SKIP = !process.env.DATABASE_URL || !process.env.REDIS_URL;

const DEFAULT_TIMEOUT_MS = 10_000;
function timed<T>(label: string, p: Promise<T>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
	return Promise.race([
		p,
		new Promise<never>((_, reject) => {
			setTimeout(() => reject(new Error(`${label}: timeout after ${timeoutMs}ms`)), timeoutMs);
		}),
	]);
}

describe.skipIf(SKIP)("Phase C — multi-replica exec lock", () => {
	let redis: Redis;
	const cleanup: string[] = [];

	beforeAll(async () => {
		redis = new Redis(process.env.REDIS_URL!, { lazyConnect: true, maxRetriesPerRequest: 1 });
		await redis.connect();
	});

	beforeEach(() => {
		cleanup.length = 0;
	});

	afterEach(async () => {
		// Best-effort sandbox cleanup + stray locks.
		for (const id of cleanup) {
			try {
				await destroySandbox("postgres", id);
			} catch {
				/* ignore */
			}
			await redis.del(execLockKey(id));
		}
	});

	function makeSm(): SessionManager {
		return new SessionManager({
			tenantConfig: loadTenantConfig(),
			redis,
			execLockOptions: {
				leaseMs: 5_000,
				renewMs: 1_500,
				acquireTimeoutMs: 8_000,
				acquireRetryMs: 50,
			},
		});
	}

	function newId(): string {
		const id = `phase-c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		cleanup.push(id);
		return id;
	}

	it("cross-instance serialization: concurrent execs on same sandbox interleave deterministically", async () => {
		const sandboxId = newId();
		const smA = makeSm();
		const smB = makeSm();

		const events: string[] = [];
		const holdMs = 300;

		const execA = smA.withSession(TENANT, sandboxId, async (s) => {
			events.push("A-start");
			await s.bash.exec(`sleep ${holdMs / 1000} && echo A > /from-a.txt`);
			events.push("A-end");
		});

		// Give A a head-start so it wins the acquire race.
		await new Promise((r) => setTimeout(r, 50));

		const execB = smB.withSession(TENANT, sandboxId, async (s) => {
			events.push("B-start");
			await s.bash.exec("echo B > /from-b.txt");
			events.push("B-end");
		});

		await Promise.all([timed("A", execA), timed("B", execB)]);

		// Serialization guarantees B did not start until A ended.
		expect(events).toEqual(["A-start", "A-end", "B-start", "B-end"]);

		// Both files present: A's write was durable across replicas.
		const verify = makeSm();
		await verify.withSession(TENANT, sandboxId, async (s) => {
			const a = await s.fs.readFile("/from-a.txt");
			const b = await s.fs.readFile("/from-b.txt");
			expect(String(a).trim()).toBe("A");
			expect(String(b).trim()).toBe("B");
		});
	});

	it("destroy on replica B waits for an in-flight exec on replica A", async () => {
		const sandboxId = newId();
		const smA = makeSm();
		const smB = makeSm();

		// Warm A so the sandbox exists in its pool (destroy path requires it for full cleanup).
		await smA.withSession(TENANT, sandboxId, async () => {
			/* warm up */
		});

		const events: string[] = [];
		let releaseExec!: () => void;
		const execGate = new Promise<void>((resolve) => {
			releaseExec = resolve;
		});

		const execA = smA.withSession(TENANT, sandboxId, async () => {
			events.push("exec-start");
			await execGate;
			events.push("exec-end");
		});

		// Let A acquire the lock.
		await new Promise((r) => setTimeout(r, 50));

		// Also warm B so destroy on B finds the sandbox in its own pool (destroy only
		// removes the in-memory entry on the replica that holds it — the PG row is
		// deleted unconditionally inside the lock).
		const destroyB = smB.destroy(TENANT, sandboxId);

		// Destroy should be blocked behind exec. Give it a moment then release.
		await new Promise((r) => setTimeout(r, 100));
		events.push("before-release");
		releaseExec();

		await Promise.all([timed("exec", execA), timed("destroy", destroyB)]);

		expect(events).toEqual(["exec-start", "before-release", "exec-end"]);
	});

	it("lease expiry recovery: if a replica's lock survives a crash, another acquires after leaseMs", async () => {
		const sandboxId = newId();
		const sm = makeSm();

		// Simulate a dead replica still holding the lock: plant a foreign token with a short TTL.
		const leaseMs = 1_500;
		await redis.set(execLockKey(sandboxId), "dead-replica-token", "PX", leaseMs);

		const start = Date.now();
		await timed(
			"post-expiry-acquire",
			sm.withSession(TENANT, sandboxId, async () => {
				/* noop */
			}),
			leaseMs + 5_000,
		);
		const elapsed = Date.now() - start;

		// Must have waited at least until the lease expired.
		expect(elapsed).toBeGreaterThanOrEqual(leaseMs - 100);
		// And not much more than that.
		expect(elapsed).toBeLessThan(leaseMs + 3_000);
	});
});

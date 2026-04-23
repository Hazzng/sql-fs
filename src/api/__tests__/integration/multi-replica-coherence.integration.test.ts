/**
 * Phase D — cross-replica cache-coherence integration tests.
 *
 * Two SessionManager instances against one real Postgres + one real Redis
 * simulate two API replicas. Verifies:
 *   1. Write on A → version bumps → next exec on B reloads and sees the write.
 *   2. Back-to-back execs on B with no intervening A write → no spurious reload.
 *   3. destroy() clears the version key so a re-created sandbox starts fresh.
 *   4. Two alternating writes converge both replicas on the latest version.
 *
 * Skipped unless both DATABASE_URL and REDIS_URL are set.
 */

import { Redis } from "ioredis";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { destroySandbox } from "../../../fs/sql-fs/index.js";
import { execLockKey } from "../../distributed-lock.js";
import { SessionManager } from "../../session-manager.js";

const SKIP = !process.env.DATABASE_URL || !process.env.REDIS_URL;

const DEFAULT_TIMEOUT_MS = 15_000;
function timed<T>(label: string, p: Promise<T>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
	return Promise.race([
		p,
		new Promise<never>((_, reject) => {
			setTimeout(() => reject(new Error(`${label}: timeout after ${timeoutMs}ms`)), timeoutMs);
		}),
	]);
}

function versionKey(sandboxId: string): string {
	return `vfs:ver:${sandboxId}`;
}

describe.skipIf(SKIP)("Phase D — cross-replica cache coherence", () => {
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
		for (const id of cleanup) {
			try {
				await destroySandbox("postgres", id);
			} catch {
				/* ignore */
			}
			await redis.del(execLockKey(id));
			await redis.del(versionKey(id));
		}
	});

	function makeSm(): SessionManager {
		return new SessionManager({
			backend: "postgres",
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
		const id = `phase-d-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		cleanup.push(id);
		return id;
	}

	it("write on A → read on B reloads and sees the new file", async () => {
		const sandboxId = newId();
		const smA = makeSm();
		const smB = makeSm();

		// Both replicas warm the session first so they each have a pool entry.
		await smA.withSession(sandboxId, async () => {
			/* create */
		});
		await smB.withSession(sandboxId, async () => {
			/* warm on B */
		});

		// Before A writes, B's session should not have the file in its pathCache.
		const bSessionBefore = smB.getSession(sandboxId)!;
		expect(bSessionBefore.fs.getAllPaths()).not.toContain("/from-a.txt");

		// A writes via bash — mutation goes through SqlFs.writeFile → marks dirty → INCRs version.
		await timed(
			"A-write",
			smA.withSession(sandboxId, async (s) => {
				await s.bash.exec("echo hello > /from-a.txt");
			}),
		);

		const versionAfterA = await redis.get(versionKey(sandboxId));
		expect(Number(versionAfterA)).toBeGreaterThanOrEqual(1);

		// B's next exec must reload and see /from-a.txt.
		await timed(
			"B-read",
			smB.withSession(sandboxId, async (s) => {
				const content = await s.fs.readFile("/from-a.txt");
				expect(String(content).trim()).toBe("hello");
				// And the pathCache now reflects the reload.
				expect(s.fs.getAllPaths()).toContain("/from-a.txt");
			}),
		);

		// After B's reload, B's lastSeenVersion should match Redis.
		const bSessionAfter = smB.getSession(sandboxId)!;
		expect(String(bSessionAfter.lastSeenVersion)).toBe(versionAfterA);
	});

	it("no reload when no other replica wrote in between", async () => {
		const sandboxId = newId();
		const sm = makeSm();

		await sm.withSession(sandboxId, async () => {
			/* warm */
		});

		// Spy on fs.reload — we can't easily spy since fs is owned internally,
		// but we can observe via the Redis version key NOT changing and the
		// session's lastSeenVersion staying put.
		const before = await redis.get(versionKey(sandboxId));
		const sessionBefore = sm.getSession(sandboxId)!;
		const lsvBefore = sessionBefore.lastSeenVersion;

		// Pure-read turn (no mutation)
		await sm.withSession(sandboxId, async (s) => {
			await s.bash.exec("ls /");
		});

		const after = await redis.get(versionKey(sandboxId));
		expect(after).toBe(before); // version key untouched
		expect(sm.getSession(sandboxId)?.lastSeenVersion).toBe(lsvBefore);
	});

	it("destroy clears the Redis version key", async () => {
		const sandboxId = newId();
		const sm = makeSm();

		await sm.withSession(sandboxId, async (s) => {
			await s.bash.exec("echo bye > /x.txt");
		});

		expect(await redis.get(versionKey(sandboxId))).not.toBeNull();

		await sm.destroy(sandboxId);

		expect(await redis.get(versionKey(sandboxId))).toBeNull();
	});

	it("alternating writes across replicas converge on the latest version", async () => {
		const sandboxId = newId();
		const smA = makeSm();
		const smB = makeSm();

		await smA.withSession(sandboxId, async (s) => {
			await s.bash.exec("echo a1 > /ping.txt");
		});
		await smB.withSession(sandboxId, async (s) => {
			const current = String(await s.fs.readFile("/ping.txt")).trim();
			expect(current).toBe("a1");
			await s.bash.exec("echo b1 > /pong.txt");
		});
		await smA.withSession(sandboxId, async (s) => {
			const pong = String(await s.fs.readFile("/pong.txt")).trim();
			expect(pong).toBe("b1");
		});

		// The counter should have ticked at least twice (A-write, B-write).
		expect(Number(await redis.get(versionKey(sandboxId)))).toBeGreaterThanOrEqual(2);
		// Both replicas now see the same lastSeenVersion.
		expect(smA.getSession(sandboxId)?.lastSeenVersion).toBe(smB.getSession(sandboxId)?.lastSeenVersion);
	});
});

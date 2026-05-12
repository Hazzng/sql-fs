/**
 * Phase 3 — cross-replica distributed RW lock integration tests.
 *
 * Two SessionManager instances against one real Postgres + one real Redis
 * exercise the invariants from issue Hazzng/virtualFS#61:
 *   1. Readers from different replicas overlap (peak >= 2).
 *   2. An exclusive writer on A blocks new shared readers on B.
 *   3. A live reader on A blocks an exclusive writer on B (writer waits for drain).
 *   4. Writer-priority: a continuous reader stream on B doesn't starve a writer on A.
 *   5. A crashed reader (stale ZSET entry) cannot deadlock a writer — TTL reaper recovers.
 *   6. After a write on A commits + publishes, B's next withSessionRead sees the data.
 *
 * Skipped unless DATABASE_URL and REDIS_URL are both set.
 */

import { Redis } from "ioredis";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { destroySandbox } from "../../../fs/sql-fs/index.js";
import { rwLockKeys } from "../../distributed-rw-lock.js";
import { SessionManager } from "../../session-manager.js";
import { loadTenantConfig } from "../../tenants.js";

const TENANT = "default";

const SKIP = !process.env.DATABASE_URL || !process.env.REDIS_URL;

const DEFAULT_TIMEOUT_MS = 20_000;
function timed<T>(label: string, p: Promise<T>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
	return Promise.race([
		p,
		new Promise<never>((_, reject) => {
			setTimeout(() => reject(new Error(`${label}: timeout after ${timeoutMs}ms`)), timeoutMs);
		}),
	]);
}

function versionKey(sandboxId: string): string {
	return `vfs:${TENANT}:ver:${sandboxId}`;
}

const ACQUIRE_TIMEOUT_MS = 10_000;

describe.skipIf(SKIP)("Phase 3 — cross-replica RW lock integration", () => {
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
			const { writer, readers } = rwLockKeys(TENANT, id);
			await redis.del(writer, readers, versionKey(id));
		}
	});

	function makeSm(): SessionManager {
		return new SessionManager({
			tenantConfig: loadTenantConfig(),
			redis,
			execLockOptions: {
				leaseMs: 5_000,
				renewMs: 1_500,
				acquireTimeoutMs: ACQUIRE_TIMEOUT_MS,
				acquireRetryMs: 50,
				readerLeaseMs: 5_000,
			},
		});
	}

	function newId(): string {
		const id = `phase3-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		cleanup.push(id);
		return id;
	}

	/** Pre-warm both replicas so withSessionRead can find an in-process session. */
	async function warm(smA: SessionManager, smB: SessionManager, sandboxId: string): Promise<void> {
		await smA.withSession(TENANT, sandboxId, async () => {
			/* create + warm A */
		});
		await smB.withSession(TENANT, sandboxId, async () => {
			/* warm B */
		});
	}

	it("parallel readers across replicas overlap (peak in-flight >= 2 with start spread <= 200ms)", async () => {
		const sandboxId = newId();
		const smA = makeSm();
		const smB = makeSm();
		await warm(smA, smB, sandboxId);

		const starts: number[] = [];
		let active = 0;
		let peak = 0;
		const reader = (sm: SessionManager): Promise<void> =>
			sm.withSessionRead(TENANT, sandboxId, async () => {
				starts.push(Date.now());
				active++;
				peak = Math.max(peak, active);
				// Hold long enough to overlap (well beyond Redis RTT).
				await new Promise((r) => setTimeout(r, 200));
				active--;
			});

		await timed("parallel-readers", Promise.all([reader(smA), reader(smB), reader(smA), reader(smB)]));

		expect(peak).toBeGreaterThanOrEqual(2);
		// All four readers should have started within a tight window — proves they
		// did not serialize on the distributed lock.
		const spread = Math.max(...starts) - Math.min(...starts);
		expect(spread).toBeLessThan(200);
	});

	it("exclusive on A blocks shared on B until A commits + publishes", async () => {
		const sandboxId = newId();
		const smA = makeSm();
		const smB = makeSm();
		await warm(smA, smB, sandboxId);

		const order: string[] = [];
		const writerHoldMs = 200;
		const writer = smA.withSession(TENANT, sandboxId, async (s) => {
			order.push("w-start");
			await s.bash.exec(`sleep ${writerHoldMs / 1000} && echo gate > /gate.txt`);
			order.push("w-end");
		});

		// Give A a head-start to acquire the writer flag.
		await new Promise((r) => setTimeout(r, 50));

		const reader = smB.withSessionRead(TENANT, sandboxId, async (s) => {
			order.push("r-start");
			const content = await s.fs.readFile("/gate.txt");
			expect(String(content).trim()).toBe("gate");
		});

		await timed("writer", writer);
		// Capture the version A published — used to assert B saw the latest.
		const versionAfterWrite = Number(await redis.get(versionKey(sandboxId)));
		await timed("reader", reader);

		expect(order).toEqual(["w-start", "w-end", "r-start"]);
		expect(versionAfterWrite).toBeGreaterThanOrEqual(1);

		// B's session must now reflect the version A published — proves the
		// publishVersionIfDirty-before-release ordering.
		const sessionB = smB.getSession(TENANT, sandboxId);
		expect(sessionB?.lastSeenVersion).toBe(versionAfterWrite);
	});

	it("shared on A blocks exclusive on B until reader drains", async () => {
		const sandboxId = newId();
		const smA = makeSm();
		const smB = makeSm();
		await warm(smA, smB, sandboxId);

		const order: string[] = [];
		let releaseReader!: () => void;
		const readerGate = new Promise<void>((r) => {
			releaseReader = r;
		});

		const reader = smA.withSessionRead(TENANT, sandboxId, async () => {
			order.push("r-start");
			await readerGate;
			order.push("r-end");
		});

		// Let the reader acquire.
		await new Promise((r) => setTimeout(r, 50));

		const writer = smB.withSession(TENANT, sandboxId, async (s) => {
			order.push("w-start");
			await s.bash.exec("echo done > /after-reader.txt");
		});

		// Writer must be blocked behind the live reader.
		await new Promise((r) => setTimeout(r, 100));
		expect(order).toEqual(["r-start"]);

		releaseReader();
		await timed("reader", reader);
		await timed("writer", writer);

		expect(order).toEqual(["r-start", "r-end", "w-start"]);
	});

	it("writer is not starved by a continuous reader stream (writer-priority)", async () => {
		const sandboxId = newId();
		const smA = makeSm();
		const smB = makeSm();
		await warm(smA, smB, sandboxId);

		// Continuous reader stream on B. Each reader holds briefly so the writer
		// has to wait for in-flight readers to drain — but writer-priority means
		// new readers won't be admitted once A's flag is set.
		let stop = false;
		let readersCompleted = 0;
		const readerLoop = (async (): Promise<void> => {
			while (!stop) {
				await smB
					.withSessionRead(TENANT, sandboxId, async () => {
						await new Promise((r) => setTimeout(r, 30));
					})
					.then(() => {
						readersCompleted++;
					})
					.catch(() => {
						/* writer may be blocking; that's fine */
					});
			}
		})();

		// Let a few readers fire before queueing the writer.
		await new Promise((r) => setTimeout(r, 150));

		const writerStart = Date.now();
		await timed(
			"writer-under-reader-pressure",
			smA.withSession(TENANT, sandboxId, async (s) => {
				await s.bash.exec("echo w > /writer-priority.txt");
			}),
			ACQUIRE_TIMEOUT_MS / 2,
		);
		const writerElapsed = Date.now() - writerStart;

		stop = true;
		await readerLoop;

		// Plan requirement: writer completes in well under acquireTimeoutMs / 2.
		expect(writerElapsed).toBeLessThan(ACQUIRE_TIMEOUT_MS / 2);
		// And at least one reader had fired before the writer (otherwise the
		// "starvation" wasn't actually being exercised).
		expect(readersCompleted).toBeGreaterThan(0);
	});

	it("crashed reader (stale ZSET entry) does not deadlock a writer — reaped within one poll cycle", async () => {
		const sandboxId = newId();
		const sm = makeSm();
		await sm.withSession(TENANT, sandboxId, async () => {
			/* warm */
		});

		// Plant an expired reader token directly in the ZSET. expireAt < now,
		// so CHECK_READERS_DRAINED_SCRIPT will ZREMRANGEBYSCORE it on the first
		// poll and report 0 live readers.
		const { readers } = rwLockKeys(TENANT, sandboxId);
		await redis.zadd(readers, String(Date.now() - 1), "dead-reader-token");

		const start = Date.now();
		await timed(
			"writer-after-crashed-reader",
			sm.withSession(TENANT, sandboxId, async (s) => {
				await s.bash.exec("echo ok > /after-crash.txt");
			}),
			2_000,
		);
		const elapsed = Date.now() - start;

		// One acquireRetryMs (50ms) reap cycle should be enough; allow generous headroom.
		expect(elapsed).toBeLessThan(500);

		// And the stale entry is gone.
		const remaining = await redis.zcard(readers);
		expect(remaining).toBe(0);
	});

	it("version visible to B after A's write — lock release waits for publishVersionIfDirty", async () => {
		const sandboxId = newId();
		const smA = makeSm();
		const smB = makeSm();
		await warm(smA, smB, sandboxId);

		// A writes a file. publishVersionIfDirty bumps the Redis version key
		// before the exclusive lock is released.
		await timed(
			"A-write",
			smA.withSession(TENANT, sandboxId, async (s) => {
				await s.bash.exec("echo from-a > /visible.txt");
			}),
		);

		const versionAfterA = Number(await redis.get(versionKey(sandboxId)));
		expect(versionAfterA).toBeGreaterThanOrEqual(1);

		// B's next readOnly turn must see /visible.txt (proves ordering:
		// publishVersionIfDirty → ensureFreshCache reload → fn runs).
		await timed(
			"B-read",
			smB.withSessionRead(TENANT, sandboxId, async (s) => {
				const content = await s.fs.readFile("/visible.txt");
				expect(String(content).trim()).toBe("from-a");
				expect(s.fs.getAllPaths()).toContain("/visible.txt");
			}),
		);

		// B's session lastSeenVersion now matches A's published version.
		expect(smB.getSession(TENANT, sandboxId)?.lastSeenVersion).toBe(versionAfterA);
	});
});

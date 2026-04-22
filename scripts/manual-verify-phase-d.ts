/**
 * Phase D manual verification harness.
 *
 * Spins up two `SessionManager` instances in one process sharing one real
 * Redis and one real Postgres. Narrates each step with timestamps and a
 * live view of `vfs:ver:<id>` in Redis so an operator can see:
 *   1. Version key is absent before first write.
 *   2. Writing on replica A bumps the counter.
 *   3. Replica B's next exec reloads its pathCache and reads the new file.
 *   4. A second exec on replica B with no intervening A-write does NOT reload.
 *   5. `destroy()` removes the version key.
 *
 * Requires DATABASE_URL and REDIS_URL to be set.
 */

import { Redis } from "ioredis";
import { destroySandbox } from "../src/fs/sql-fs/index.js";
import { execLockKey } from "../src/api/distributed-lock.js";
import { SessionManager } from "../src/api/session-manager.js";

function log(msg: string): void {
	const ts = new Date().toISOString().slice(11, 23);
	console.log(`[${ts}] ${msg}`);
}

async function main(): Promise<void> {
	if (!process.env.DATABASE_URL || !process.env.REDIS_URL) {
		console.error("DATABASE_URL and REDIS_URL must be set.");
		process.exit(1);
	}

	const redis = new Redis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
	await redis.connect();
	log(`Redis connected to ${process.env.REDIS_URL}`);

	const makeSm = (): SessionManager =>
		new SessionManager({
			backend: "postgres",
			redis,
			execLockOptions: { leaseMs: 10_000, renewMs: 3_000, acquireTimeoutMs: 10_000, acquireRetryMs: 50 },
		});

	const smA = makeSm();
	const smB = makeSm();

	const id = `manual-${Date.now()}`;
	const versionKey = `vfs:ver:${id}`;
	log(`Using sandbox id = ${id}`);

	try {
		// 1. Pre-state
		log(`[check 1] Redis ${versionKey} before any activity: ${await redis.get(versionKey) ?? "<absent>"}`);

		// 2. Warm A and B — both get a pool entry so HTTP exec routes would work on each
		log(`[step 1] Warming replica A...`);
		await smA.withSession(id, async () => {});
		log(`  A.lastSeenVersion = ${smA.getSession(id)?.lastSeenVersion}`);
		log(`  Redis ${versionKey} = ${(await redis.get(versionKey)) ?? "<absent>"}`);

		log(`[step 2] Warming replica B...`);
		await smB.withSession(id, async () => {});
		log(`  B.lastSeenVersion = ${smB.getSession(id)?.lastSeenVersion}`);

		// 3. Write on A → version should INCR
		log(`[step 3] Replica A: exec 'echo hello > /greeting.txt'`);
		await smA.withSession(id, async (s) => {
			await s.bash.exec("echo hello > /greeting.txt");
		});
		log(`  A.lastSeenVersion = ${smA.getSession(id)?.lastSeenVersion}`);
		log(`  Redis ${versionKey} = ${await redis.get(versionKey)}   ← should have bumped to 1`);
		log(`  B.lastSeenVersion (still stale) = ${smB.getSession(id)?.lastSeenVersion}`);

		// 4. Read on B → should reload and see /greeting.txt
		log(`[step 4] Replica B: exec 'cat /greeting.txt' — expecting reload + fresh read`);
		const beforeBPaths = smB.getSession(id)?.fs.getAllPaths() ?? [];
		log(`  B pathCache BEFORE this turn has /greeting.txt? ${beforeBPaths.includes("/greeting.txt")}`);
		await smB.withSession(id, async (s) => {
			const content = await s.fs.readFile("/greeting.txt");
			log(`  B read /greeting.txt = ${JSON.stringify(String(content).trim())}`);
		});
		log(`  B.lastSeenVersion AFTER reload = ${smB.getSession(id)?.lastSeenVersion}   ← should match Redis`);

		// 5. Second B exec with no intervening A write → NO reload, no version bump
		const versionBeforeNoop = await redis.get(versionKey);
		const bLsvBeforeNoop = smB.getSession(id)?.lastSeenVersion;
		log(`[step 5] Replica B: idempotent 'ls /' — expecting NO reload, NO version bump`);
		await smB.withSession(id, async (s) => {
			await s.bash.exec("ls /");
		});
		const versionAfterNoop = await redis.get(versionKey);
		log(`  Redis ${versionKey} stayed at ${versionAfterNoop} (was ${versionBeforeNoop}) — ${versionBeforeNoop === versionAfterNoop ? "OK" : "FAIL"}`);
		log(`  B.lastSeenVersion stayed at ${smB.getSession(id)?.lastSeenVersion} (was ${bLsvBeforeNoop}) — ${bLsvBeforeNoop === smB.getSession(id)?.lastSeenVersion ? "OK" : "FAIL"}`);

		// 6. Alternating writes converge
		log(`[step 6] Interleaved writes: A writes /a, B writes /b, A reads /b`);
		await smA.withSession(id, async (s) => {
			await s.bash.exec("echo A-wrote > /a.txt");
		});
		await smB.withSession(id, async (s) => {
			const a = String(await s.fs.readFile("/a.txt")).trim();
			log(`  B saw /a.txt = ${JSON.stringify(a)}`);
			await s.bash.exec("echo B-wrote > /b.txt");
		});
		await smA.withSession(id, async (s) => {
			const b = String(await s.fs.readFile("/b.txt")).trim();
			log(`  A saw /b.txt = ${JSON.stringify(b)}`);
		});
		log(`  Final Redis ${versionKey} = ${await redis.get(versionKey)} (should be ≥ 3)`);
		log(`  A.lastSeenVersion = ${smA.getSession(id)?.lastSeenVersion}`);
		log(`  B.lastSeenVersion = ${smB.getSession(id)?.lastSeenVersion}`);

		// 7. Destroy → version key gone
		log(`[step 7] smA.destroy(id) — expecting ${versionKey} to vanish`);
		await smA.destroy(id);
		log(`  Redis ${versionKey} after destroy = ${(await redis.get(versionKey)) ?? "<absent>"}`);

		log("");
		log("✅ All manual checks completed.");
	} finally {
		try {
			await destroySandbox("postgres", id);
		} catch {
			/* noop */
		}
		await redis.del(execLockKey(id));
		await redis.del(`vfs:ver:${id}`);
		await redis.quit();
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});

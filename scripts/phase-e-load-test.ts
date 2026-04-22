/**
 * Phase E load test: multi-replica cold-start hits the Redis path snapshot
 * instead of issuing the `loadAllPaths` recursive CTE against Postgres.
 *
 * Setup:
 *   - 3 SessionManager instances in one process (replicas A, B, C)
 *   - All share one real Redis + one real Postgres
 *   - REDIS_PATH_SNAPSHOT_ENABLED=true is the default
 *   - Pass SNAPSHOT=off to observe the contrast (all replicas hit PG CTE)
 *
 * Scenario:
 *   1. Replica A creates the sandbox and bulk-ingests NUM_FILES files.
 *      That triggers publishVersionIfDirty → writes vfs:snap:{id} to Redis.
 *   2. Replicas B and C each cold-start the *same* sandbox. Both are fresh
 *      SessionManagers with empty pools, so each invokes createSandboxFs →
 *      SqlFs.ready() → #loadFreshPathCache(). With the snapshot enabled,
 *      that path returns from Redis and skips loadAllPaths entirely.
 *   3. We count path_snapshot_hit / _miss events per replica, and also wrap
 *      dialect.loadAllPaths with a counter so "did PG run the recursive CTE?"
 *      is measured directly, not inferred from logs.
 *
 * Requires DATABASE_URL and REDIS_URL.
 */

import { Redis } from "ioredis";
import type { IFileSystem } from "just-bash";
import { execLockKey } from "../src/api/distributed-lock.js";
import { SessionManager } from "../src/api/session-manager.js";
import { PostgresDialect } from "../src/fs/sql-fs/dialects/postgres.js";
import { destroySandbox } from "../src/fs/sql-fs/index.js";
import { RedisPathSnapshot } from "../src/fs/sql-fs/redis-path-snapshot.js";
import { SqlFs } from "../src/fs/sql-fs/sql-fs.js";
import type { PathCacheEntry, StorageBackend } from "../src/fs/sql-fs/types.js";

const SNAPSHOT_ENABLED = (process.env.SNAPSHOT ?? "on").toLowerCase() !== "off";
const NUM_FILES = Number(process.env.NUM_FILES ?? 1000);

function log(msg: string): void {
	const ts = new Date().toISOString().slice(11, 23);
	console.log(`[${ts}] ${msg}`);
}

function makeReplica(
	label: string,
	redis: Redis,
	snapshot: RedisPathSnapshot | undefined,
): { sm: SessionManager; stats: ReplicaStats } {
	const stats: ReplicaStats = { loadAllPathsCalls: 0, readyCalls: 0, label };

	// Custom createFs: identical to the real factory but wraps `loadAllPaths`
	// so we can count recursive-CTE invocations per replica.
	const createFs = async (_backend: StorageBackend, sandboxId: string): Promise<IFileSystem> => {
		const dialect = new PostgresDialect(process.env.DATABASE_URL!);
		await dialect.connect();
		try {
			await dialect.transaction(async (tx) => dialect.createSandbox(tx, sandboxId));
		} catch (e) {
			if ((e as { code?: string }).code !== "23505") throw e;
		}
		const originalLoad = dialect.loadAllPaths.bind(dialect);
		dialect.loadAllPaths = async (tx) => {
			stats.loadAllPathsCalls++;
			log(`  [${label}] dialect.loadAllPaths() invoked (recursive CTE)`);
			return originalLoad(tx);
		};
		const fs = new SqlFs({
			dialect,
			sandboxId,
			redis,
			pathSnapshot: snapshot,
		});
		stats.readyCalls++;
		const t0 = Date.now();
		await fs.ready();
		log(`  [${label}] SqlFs.ready() took ${Date.now() - t0}ms`);
		return fs;
	};

	const sm = new SessionManager({
		backend: "postgres",
		createFs,
		redis,
		pathSnapshot: snapshot,
		execLockOptions: { leaseMs: 10_000, renewMs: 3_000, acquireTimeoutMs: 10_000, acquireRetryMs: 50 },
	});
	return { sm, stats };
}

interface ReplicaStats {
	readonly label: string;
	loadAllPathsCalls: number;
	readyCalls: number;
}

async function main(): Promise<void> {
	if (!process.env.DATABASE_URL || !process.env.REDIS_URL) {
		console.error("DATABASE_URL and REDIS_URL must be set.");
		process.exit(1);
	}

	const redis = new Redis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
	await redis.connect();
	log(`Redis connected to ${process.env.REDIS_URL}`);

	const snapshot = SNAPSHOT_ENABLED ? new RedisPathSnapshot(redis, { ttlMs: 60 * 60 * 1000 }) : undefined;
	log(`Snapshot ${SNAPSHOT_ENABLED ? "ENABLED" : "DISABLED"} (snapshot=${SNAPSHOT_ENABLED ? "on" : "off"})`);

	const A = makeReplica("A", redis, snapshot);
	const B = makeReplica("B", redis, snapshot);
	const C = makeReplica("C", redis, snapshot);

	const id = `phase-e-load-${Date.now()}`;
	const versionKey = `vfs:ver:${id}`;
	const snapKey = RedisPathSnapshot.key(id);
	log(`sandbox id = ${id}`);

	try {
		// ── Step 1: replica A seeds the sandbox ──────────────────────────────
		log("");
		log(`[step 1] replica-A: create sandbox + bulk-write ${NUM_FILES} files`);
		const seedStart = Date.now();
		await A.sm.withSession(id, async (session) => {
			const files: Record<string, string> = Object.create(null);
			for (let i = 0; i < NUM_FILES; i++) {
				files[`/tmp/seed/f${i}.txt`] = `body ${i}`;
			}
			// writeFile creates /tmp/seed/fN.txt — but we need /tmp/seed to exist first.
			await session.fs.mkdir("/tmp/seed", { recursive: true });
			for (const [p, c] of Object.entries(files)) {
				await session.fs.writeFile(p, c);
			}
		});
		log(`  seed took ${Date.now() - seedStart}ms — A.loadAllPathsCalls=${A.stats.loadAllPathsCalls}`);

		const verAfterSeed = await redis.get(versionKey);
		const snapBytes = await redis.strlen(snapKey);
		log(`  ${versionKey} = ${verAfterSeed}`);
		log(`  ${snapKey} = ${snapBytes} bytes (${SNAPSHOT_ENABLED ? "expected > 0" : "expected 0 — snapshot off"})`);

		// ── Step 2: cold-start on replica B ──────────────────────────────────
		log("");
		log("[step 2] replica-B: first touch on same sandbox (cold-start)");
		const t_b = Date.now();
		await B.sm.withSession(id, async (session) => {
			const allPaths = session.fs.getAllPaths();
			log(`  B sees ${allPaths.length} paths (expected ${NUM_FILES + /* / + /tmp + /tmp/seed + seeded default dirs */ 0}+)`);
		});
		log(`  B cold-start end-to-end = ${Date.now() - t_b}ms  — B.loadAllPathsCalls=${B.stats.loadAllPathsCalls}`);

		// ── Step 3: cold-start on replica C ──────────────────────────────────
		log("");
		log("[step 3] replica-C: first touch on same sandbox (cold-start)");
		const t_c = Date.now();
		await C.sm.withSession(id, async (session) => {
			const allPaths = session.fs.getAllPaths();
			log(`  C sees ${allPaths.length} paths`);
		});
		log(`  C cold-start end-to-end = ${Date.now() - t_c}ms  — C.loadAllPathsCalls=${C.stats.loadAllPathsCalls}`);

		// ── Step 4: warm follow-up traffic on all replicas — no more reloads ─
		log("");
		log("[step 4] 20 warm reads/writes per replica — no reloads expected");
		const follow = async (replica: { sm: SessionManager; stats: ReplicaStats }): Promise<void> => {
			for (let i = 0; i < 20; i++) {
				await replica.sm.withSession(id, async (s) => {
					await s.fs.readFile(`/tmp/seed/f${i}.txt`);
				});
			}
		};
		await Promise.all([follow(A), follow(B), follow(C)]);
		log(`  A.loadAllPathsCalls=${A.stats.loadAllPathsCalls}, B=${B.stats.loadAllPathsCalls}, C=${C.stats.loadAllPathsCalls}`);

		// ── Step 5: cross-replica mutation — B writes, C should reload and hit snapshot ─
		log("");
		log("[step 5] B writes a new file → version bumps → C's next exec reloads");
		await B.sm.withSession(id, async (s) => {
			await s.fs.writeFile("/tmp/after-b.txt", "after");
		});
		log(`  ${versionKey} = ${await redis.get(versionKey)}`);
		log(`  ${snapKey} size = ${await redis.strlen(snapKey)} bytes`);
		const bLoadsBefore = B.stats.loadAllPathsCalls;
		const cLoadsBefore = C.stats.loadAllPathsCalls;
		await C.sm.withSession(id, async (s) => {
			const after = await s.fs.readFile("/tmp/after-b.txt");
			log(`  C read /tmp/after-b.txt = ${JSON.stringify(String(after).trim())}`);
		});
		log(
			`  Δ loadAllPaths on C = ${C.stats.loadAllPathsCalls - cLoadsBefore}  ${
				SNAPSHOT_ENABLED
					? "(expected 0: reload used the fresh snapshot)"
					: "(expected 1: no snapshot → CTE reload)"
			}`,
		);
		log(`  Δ loadAllPaths on B = ${B.stats.loadAllPathsCalls - bLoadsBefore}  (expected 0: B is the writer)`);

		// ── Final tally ──────────────────────────────────────────────────────
		log("");
		log("════════════════ SUMMARY ════════════════");
		log(`snapshot mode: ${SNAPSHOT_ENABLED ? "ON" : "OFF"}    files seeded: ${NUM_FILES}`);
		for (const r of [A, B, C]) {
			log(
				`  replica-${r.stats.label}: SqlFs.ready() called ${r.stats.readyCalls}x, ` +
					`loadAllPaths (recursive CTE) invoked ${r.stats.loadAllPathsCalls}x`,
			);
		}
		const totalCTE = A.stats.loadAllPathsCalls + B.stats.loadAllPathsCalls + C.stats.loadAllPathsCalls;
		log(`  TOTAL recursive-CTE hits across all replicas: ${totalCTE}`);
		if (SNAPSHOT_ENABLED) {
			log(`  expected: 1 (replica-A's initial empty load only; B+C cold-start from snapshot)`);
		} else {
			log(`  expected: 3+ (every replica cold-starts via CTE)`);
		}
		log("═════════════════════════════════════════");
	} finally {
		await A.sm.destroy(id).catch(() => {});
		try {
			await destroySandbox("postgres", id);
		} catch {
			/* noop */
		}
		await redis.del(execLockKey(id));
		await redis.del(versionKey);
		await redis.del(snapKey);
		await redis.quit();
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});

// The custom PathCacheEntry import is not actually needed here — but having it
// typed keeps tsx happy if we later pass it through for assertions.
export type { PathCacheEntry };

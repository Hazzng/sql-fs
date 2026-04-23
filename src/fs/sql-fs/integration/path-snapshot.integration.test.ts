/**
 * Integration tests for Phase E: Redis path-snapshot wired into SqlFs.
 *
 * Skipped when DATABASE_URL or REDIS_URL is not set so CI without both
 * still passes.
 */

import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PostgresDialect } from "../dialects/postgres.js";
import { RedisPathSnapshot } from "../redis-path-snapshot.js";
import { SqlFs } from "../sql-fs.js";

const SKIP = !process.env.DATABASE_URL || !process.env.REDIS_URL;

describe.skipIf(SKIP)("SqlFs + RedisPathSnapshot (Phase E)", () => {
	const redis = new Redis(process.env.REDIS_URL!, { lazyConnect: true, maxRetriesPerRequest: 1 });
	const dialect = new PostgresDialect(process.env.DATABASE_URL!);
	const createdSandboxes: string[] = [];

	beforeAll(async () => {
		await redis.connect();
		await dialect.connect();
	});

	afterEach(async () => {
		for (const id of createdSandboxes) {
			await dialect.transaction(async (tx) => dialect.deleteSandbox(tx, id));
			await redis.del(`vfs:ver:${id}`);
			await redis.del(RedisPathSnapshot.key(id));
		}
		createdSandboxes.length = 0;
	});

	afterAll(async () => {
		await dialect.disconnect();
		await redis.quit();
	});

	async function mkSandbox(): Promise<string> {
		const id = `phase-e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		await dialect.transaction(async (tx) => dialect.createSandbox(tx, id));
		createdSandboxes.push(id);
		return id;
	}

	it("ready() uses the snapshot when version matches and skips loadAllPaths", async () => {
		const sandboxId = await mkSandbox();

		// First, populate the snapshot + counter via a warm SqlFs.
		const snapshot = new RedisPathSnapshot(redis);
		const warm = new SqlFs({ dialect, sandboxId, redis, pathSnapshot: snapshot });
		await warm.ready();
		await warm.writeFile("/seeded.txt", "hello");
		// Simulate SessionManager.publishVersionIfDirty: INCR then snapshot write.
		const newVersion = Number(await redis.incr(`vfs:ver:${sandboxId}`));
		await snapshot.write(sandboxId, newVersion, warm._getPathCache());

		// Now simulate a cold replica — a fresh SqlFs on the same sandbox should
		// hit the snapshot instead of querying loadAllPaths.
		const cold = new SqlFs({ dialect, sandboxId, redis, pathSnapshot: snapshot });
		const loadAllSpy = vi.spyOn(dialect, "loadAllPaths");
		await cold.ready();

		expect(loadAllSpy).not.toHaveBeenCalled();
		expect(cold.getAllPaths()).toContain("/seeded.txt");
		const stat = await cold.stat("/seeded.txt");
		expect(stat.isFile).toBe(true);
		loadAllSpy.mockRestore();
	});

	it("falls back to loadAllPaths when the snapshot version is stale", async () => {
		const sandboxId = await mkSandbox();
		const snapshot = new RedisPathSnapshot(redis);

		// Seed a snapshot tagged with version=1 but leave the counter ahead at 5.
		const warm = new SqlFs({ dialect, sandboxId, redis, pathSnapshot: snapshot });
		await warm.ready();
		await warm.writeFile("/old.txt", "stale");
		await snapshot.write(sandboxId, 1, warm._getPathCache());
		await redis.set(`vfs:ver:${sandboxId}`, 5);
		// Also add a newer file that only exists in the DB, not the snapshot.
		await warm.writeFile("/fresh.txt", "fresh");

		// A cold replica must reject the stale snapshot and loadAllPaths instead.
		const cold = new SqlFs({ dialect, sandboxId, redis, pathSnapshot: snapshot });
		const loadAllSpy = vi.spyOn(dialect, "loadAllPaths");
		await cold.ready();

		expect(loadAllSpy).toHaveBeenCalledTimes(1);
		expect(cold.getAllPaths()).toContain("/fresh.txt");
		expect(cold.getAllPaths()).toContain("/old.txt");
		loadAllSpy.mockRestore();
	});

	it("falls back to loadAllPaths when the snapshot key is missing", async () => {
		const sandboxId = await mkSandbox();
		const snapshot = new RedisPathSnapshot(redis);

		// No snapshot written. Counter left at 0 (default).
		const cold = new SqlFs({ dialect, sandboxId, redis, pathSnapshot: snapshot });
		const loadAllSpy = vi.spyOn(dialect, "loadAllPaths");
		await cold.ready();

		expect(loadAllSpy).toHaveBeenCalledTimes(1);
		loadAllSpy.mockRestore();
	});
});

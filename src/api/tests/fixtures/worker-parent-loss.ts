import { Redis } from "ioredis";
import { SessionManager } from "../../session-manager.js";
import { loadTenantConfig } from "../../tenants.js";
import { loadWorkerPoolOptions } from "../../worker-owner/pool.js";

const [sandboxId, mode] = process.argv.slice(2);
if (!sandboxId || !["buffered", "committed"].includes(mode ?? ""))
	throw new Error("Invalid parent-loss fixture arguments");
const redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: 1 });
const manager = new SessionManager({
	tenantConfig: loadTenantConfig(),
	redis,
	workerEnabled: true,
	workerOptions: { ...loadWorkerPoolOptions(), count: 2, heapMb: 512, maxRssBytes: 4 * 1024 * 1024 * 1024 },
	execLockOptions: { leaseMs: 1000, renewMs: 200, acquireTimeoutMs: 5000, acquireRetryMs: 10 },
});

try {
	await manager.withSession("default", sandboxId, async (session) => {
		if (mode === "buffered") {
			await session.scriptTx!.beginScope();
			await session.fs.writeFile("/orphaned.txt", "must not persist\n");
		} else {
			await session.fs.appendFile("/counter.txt", "once\n");
		}
		process.send?.({ checkpoint: mode });
		await new Promise<void>(() => {});
	});
} catch (error) {
	process.send?.({ error: (error as { code?: string }).code ?? "FIXTURE_FAILED" });
	await manager.shutdown({ drainTimeoutMs: 100 });
	await redis.quit();
	process.exitCode = 1;
}

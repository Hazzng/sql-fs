import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PostgresDialect } from "../../../sql-fs/dialects/postgres.js";
import { destroyPostgresSandbox } from "../../../sql-fs/index.js";
import type { SandboxMeta } from "../../../sql-fs/types.js";
import { rwLockKeys } from "../../distributed-rw-lock.js";
import { type RuntimeOptions, SessionManager } from "../../session-manager.js";
import { loadTenantConfig } from "../../tenants.js";
import { loadWorkerPoolOptions } from "../../worker-owner/pool.js";

const owner = "runtime-update-integration";
const tenant = "default";

describe.skipIf(!process.env.DATABASE_URL || !process.env.REDIS_URL).each([false, true])(
	"runtime flag update across replicas (workers: %s)",
	(workerEnabled) => {
		let id: string;
		let redis: Redis;
		let meta: PostgresDialect;
		let a: SessionManager;
		let b: SessionManager;

		beforeEach(async () => {
			id = `runtime-${randomUUID()}`;
			redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: 1 });
			meta = new PostgresDialect(process.env.DATABASE_URL!);
			await meta.connect();
			const options = {
				tenantConfig: loadTenantConfig(),
				redis,
				execLockOptions: { leaseMs: 5000, renewMs: 1000, acquireTimeoutMs: 8000, acquireRetryMs: 10 },
				getSandboxMetaFn: (_t: string, sandboxId: string) =>
					meta.transaction((tx) => meta.getSandboxMeta(tx, sandboxId)),
				persistSandboxMetaFn: (_t: string, sandboxId: string, m: SandboxMeta) =>
					meta.transaction((tx) => meta.updateSandboxMeta(tx, sandboxId, m)),
				updateSandboxRuntimeFn: (_t: string, sandboxId: string, runtime: Partial<RuntimeOptions>) =>
					meta.transaction((tx) => meta.updateSandboxRuntime(tx, sandboxId, runtime)),
				workerEnabled,
				workerOptions: workerEnabled
					? loadWorkerPoolOptions({ ...process.env, SQL_FS_WORKER_COUNT: "2", SQL_FS_WORKER_HEAP_MB: "256" })
					: undefined,
			};
			a = new SessionManager(options);
			b = new SessionManager(options);
			await a.withSession(tenant, id, async () => {
				await a.persistSandboxMeta(tenant, id, { owner, name: null, python: true, javascript: false, network: false });
			});
		});

		afterEach(async () => {
			await Promise.all([a?.shutdown(), b?.shutdown()]);
			await destroyPostgresSandbox(process.env.DATABASE_URL!, id);
			await meta.transaction(async (tx) => {
				await tx`DELETE FROM sandbox_epochs WHERE sandbox_id = ${id}`;
			});
			await meta.disconnect();
			const { writer, readers } = rwLockKeys(tenant, id);
			await redis.del(writer, readers);
			await redis.quit();
		});

		async function curlPath(sm: SessionManager): Promise<string> {
			const result = await sm.withSessionOrRehydrate(tenant, id, (session) =>
				sm.execWithRuntimeThrottle(session, "command -v curl"),
			);
			return result.stdout;
		}

		function update(sm: SessionManager, runtime: Partial<RuntimeOptions>) {
			return sm.withSessionOrRehydrate(tenant, id, (session) => sm.updateSandboxRuntime(session, runtime));
		}

		it("stores the new flag and keeps the omitted ones", async () => {
			const updated = await update(a, { network: true });

			expect({ python: updated.python, javascript: updated.javascript, network: updated.network }).toEqual({
				python: true,
				javascript: false,
				network: true,
			});
		});

		it("reaches a warm session on the other replica in both directions", async () => {
			expect(await curlPath(b)).toBe("");

			await update(a, { network: true });
			expect(await curlPath(b)).toBe("/usr/bin/curl\n");

			await update(a, { network: false });
			expect(await curlPath(b)).toBe("");
		});

		it("keeps the sandbox's files and lets the updating replica write right after", async () => {
			await a.withSession(tenant, id, (session) => a.execWithRuntimeThrottle(session, "echo kept > /f"));

			await update(a, { network: true });
			const result = await a.withSession(tenant, id, (session) =>
				a.execWithRuntimeThrottle(session, "cat /f; echo more >> /f; cat /f"),
			);

			expect(result.stdout).toBe("kept\nkept\nmore\n");
		});
	},
);

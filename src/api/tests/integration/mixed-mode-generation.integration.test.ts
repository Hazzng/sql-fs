import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PostgresDialect } from "../../../sql-fs/dialects/postgres.js";
import { createPostgresSandboxFs, destroyPostgresSandbox } from "../../../sql-fs/index.js";
import { SqlFs } from "../../../sql-fs/sql-fs.js";
import { requireMigratedSchema } from "../../../sql-fs/tests/integration/helpers/schema-preconditions.js";
import { SessionManager } from "../../session-manager.js";
import { loadTenantConfig } from "../../tenants.js";
import { loadWorkerPoolOptions } from "../../worker-owner/pool.js";
import { FakeRedis } from "../unit/helpers/session-manager-fakes.js";

const databaseUrl = process.env.DATABASE_URL ?? "";
const tenant = "default";

describe.skipIf(!databaseUrl)("mixed-mode generation admission against PostgreSQL", () => {
	const admin = new PostgresDialect(databaseUrl);
	const managers: SessionManager[] = [];
	const filesystems: SqlFs[] = [];
	const ids: string[] = [];

	beforeAll(async () => {
		await requireMigratedSchema(databaseUrl);
		await admin.connect();
	});

	afterEach(async () => {
		await Promise.allSettled(managers.splice(0).map((manager) => manager.shutdown()));
		await Promise.allSettled(filesystems.splice(0).map((fs) => fs.disconnect()));
		for (const id of ids.splice(0)) {
			await destroyPostgresSandbox(databaseUrl, id);
			await admin.transaction((tx) => tx`DELETE FROM sandbox_epochs WHERE sandbox_id = ${id}`);
			const remaining = await admin.transaction(
				(tx) => tx<{ count: number }[]>`
				SELECT count(*)::int AS count FROM sandbox_epochs WHERE sandbox_id = ${id}
			`,
			);
			expect(remaining[0]?.count).toBe(0);
		}
	});

	afterAll(async () => {
		await admin.disconnect();
	});

	async function epoch(id: string): Promise<bigint> {
		return admin.transaction((tx) => admin.getSandboxEpoch(tx, id));
	}

	async function durableLateCount(id: string): Promise<number> {
		const dialect = new PostgresDialect(databaseUrl, undefined, 1);
		await dialect.connect();
		try {
			const fresh = new SqlFs({ dialect, sandboxId: id });
			await fresh.ready();
			return Number(await fresh.exists("/late"));
		} finally {
			await dialect.disconnect();
		}
	}

	it.each([false, true])("retains no older buffered write after a %s worker read entry", async (workerEnabled) => {
		const id = `mixed-generation-${randomUUID()}`;
		ids.push(id);
		const { fs } = await createPostgresSandboxFs(
			{ connectionString: databaseUrl, scriptTxBuffer: { enabled: true, maxOps: 100, maxBytes: 1024 * 1024 } },
			id,
		);
		const older = fs as SqlFs;
		filesystems.push(older);
		await older.claimGeneration();
		older.beginScriptScope();
		await older.writeFile("/late", "late\n");
		const stagedCount = await durableLateCount(id);
		const claimedEpoch = await epoch(id);

		const reader = new SessionManager({
			tenantConfig: loadTenantConfig(),
			redis: new FakeRedis() as unknown as Redis,
			workerEnabled,
			workerOptions: {
				...loadWorkerPoolOptions(),
				count: 1,
				heapMb: 512,
				maxRssBytes: 4 * 1024 * 1024 * 1024,
			},
			execLockOptions: { leaseMs: 5000, renewMs: 1000, acquireTimeoutMs: 8000, acquireRetryMs: 10 },
		});
		managers.push(reader);
		await reader.getOrCreate(tenant, id);
		const visibleAtEntry = await reader.withSessionRead(tenant, id, (session) => session.fs.exists("/late"));
		const entryEpoch = await epoch(id);
		const olderResult = await older.endScriptScope().then(
			() => "committed",
			(error: { code?: string }) => error.code ?? "ERROR",
		);
		const finalCount = await durableLateCount(id);
		const finalEpoch = await epoch(id);
		console.log(
			JSON.stringify({
				event: "mixed_mode_generation_admission",
				workerEnabled,
				stagedCount,
				claimedEpoch: String(claimedEpoch),
				entryEpoch: String(entryEpoch),
				visibleAtEntry,
				olderResult,
				finalCount,
				finalEpoch: String(finalEpoch),
			}),
		);
		expect(stagedCount).toBe(0);
		expect(visibleAtEntry).toBe(false);
		expect(entryEpoch).toBe(claimedEpoch + 1n);
		expect(olderResult).toBe("ESTALE");
		expect(finalCount).toBe(0);
	});

	it("keeps ordinary inline writes and reads functional", async () => {
		const id = `mixed-generation-${randomUUID()}`;
		ids.push(id);
		const manager = new SessionManager({
			tenantConfig: loadTenantConfig(),
			redis: new FakeRedis() as unknown as Redis,
			workerEnabled: false,
			execLockOptions: { leaseMs: 5000, renewMs: 1000, acquireTimeoutMs: 8000, acquireRetryMs: 10 },
		});
		managers.push(manager);
		await manager.withSession(tenant, id, async (session) => session.fs.writeFile("/accepted", "yes"));
		const value = await manager.withSessionRead(tenant, id, (session) => session.fs.readFile("/accepted"));
		expect(value).toBe("yes");
	});
});

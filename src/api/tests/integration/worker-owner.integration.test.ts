import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ownerCancellation } from "../../../execution/owner-cancellation.js";
import { PostgresDialect } from "../../../sql-fs/dialects/postgres.js";
import type { ICoherentFs } from "../../../sql-fs/sql-fs.js";
import { requireMigratedSchema } from "../../../sql-fs/tests/integration/helpers/schema-preconditions.js";
import { type DistributedRWLockOptions, rwLockKeys } from "../../distributed-rw-lock.js";
import { sessionLeaseSignal } from "../../session-lease-context.js";
import { SessionManager } from "../../session-manager.js";
import { loadTenantConfig } from "../../tenants.js";
import { loadWorkerPoolOptions } from "../../worker-owner/pool.js";

describe.skipIf(!process.env.DATABASE_URL)("worker filesystem ownership", () => {
	const managers: SessionManager[] = [];
	const sandboxes: { manager: SessionManager; id: string }[] = [];
	const redisClients: Redis[] = [];

	beforeAll(async () => {
		await requireMigratedSchema(process.env.DATABASE_URL ?? "");
	});

	afterEach(async () => {
		for (const { manager, id } of sandboxes.splice(0)) await manager.destroy("default", id);
		await Promise.all(managers.splice(0).map((manager) => manager.shutdown()));
		await Promise.all(redisClients.splice(0).map((redis) => redis.quit()));
	});

	function makeManager(
		count = 2,
		redis?: Redis,
		execLockOptions?: Partial<DistributedRWLockOptions>,
		largeFiles = false,
	): SessionManager {
		const manager = new SessionManager({
			tenantConfig: loadTenantConfig(),
			workerEnabled: true,
			workerOptions: loadWorkerPoolOptions(
				{
					...process.env,
					SQL_FS_WORKER_COUNT: String(count),
					SQL_FS_WORKER_ACTIVE_TENANT_MAX: count === 3 ? "2" : "1",
					SQL_FS_WORKER_HEAP_MB: "256",
					SQL_FS_WORKER_MAX_PG_CONNECTIONS: String(count * 2),
					...(largeFiles && {
						SQL_FS_WORKER_LARGE_FILES: "true",
						SQL_FS_WORKER_MAX_RSS_BYTES: "2415919104",
						SQL_FS_WORKER_MAX_EXTERNAL_BYTES: "1073741824",
					}),
				},
				largeFiles ? { cpus: 2, memoryBytes: 3 * 1024 ** 3 } : undefined,
			),
			redis,
			execLockOptions,
			defenseInDepth: true,
			defenseAuditMode: false,
		});
		managers.push(manager);
		return manager;
	}

	async function create(manager: SessionManager): Promise<string> {
		const id = `worker-owner-${randomUUID()}`;
		sandboxes.push({ manager, id });
		await manager.withSession("default", id, async () => undefined, undefined, "worker-test-owner");
		return id;
	}

	it("keeps binary file APIs, shell writes, modes and the path tree on the same owner", async () => {
		const manager = makeManager();
		const id = await create(manager);
		await manager.withSessionOrRehydrate("default", id, async (session) => {
			await session.fs.writeFile("/home/user/binary", Uint8Array.from([0, 255, 128, 10]));
			const result = await manager.execWithRuntimeThrottle(
				session,
				"cat /home/user/binary | wc -c; echo contents > /home/user/result; chmod 755 /home/user/result",
			);
			expect(result).toMatchObject({ exitCode: 0, stdout: "4\n" });
		});
		await manager.withSessionRead("default", id, async (session) => {
			expect([...(await session.fs.readFileBuffer("/home/user/binary"))]).toEqual([0, 255, 128, 10]);
			expect(await session.fs.readFile("/home/user/result")).toBe("contents\n");
			expect((await session.fs.stat("/home/user/result")).mode & 0o777).toBe(0o755);
			expect(await manager.getSessionPaths(session)).toContain("/home/user/result");
		});
	});

	it("rehydrates an evicted resident without losing the session cwd or persisted bytes", async () => {
		const manager = makeManager(1);
		const first = await create(manager);
		await manager.withSessionOrRehydrate("default", first, async (session) => {
			expect(
				(
					await manager.execWithRuntimeThrottle(
						session,
						"mkdir /home/user/project; cd /home/user/project; echo persisted > data",
					)
				).exitCode,
			).toBe(0);
		});
		await create(manager);
		expect(manager.getWorkerMetrics()?.residentSessions).toBe(1);
		await manager.withSessionRead("default", first, async (session) => {
			const result = await manager.execWithRuntimeThrottle(session, "pwd; cat data");
			expect(result).toMatchObject({ exitCode: 0, stdout: "/home/user/project\npersisted\n" });
		});
	});

	it("does not recreate a sandbox deleted by another manager after worker eviction", async () => {
		const firstManager = makeManager(1);
		const secondManager = makeManager(1);
		const first = await create(firstManager);
		await create(firstManager);
		expect(firstManager.getSession("default", first)).toBeDefined();
		await secondManager.destroy("default", first);

		const dialect = new PostgresDialect(process.env.DATABASE_URL!);
		await dialect.connect();
		try {
			expect(await dialect.transaction((tx) => dialect.getSandboxMeta(tx, first))).toBeNull();
			let accessError: unknown;
			try {
				await firstManager.withSessionRead("default", first, async (session) => session.fs.stat("/"));
			} catch (error) {
				accessError = error;
			}
			const meta = await dialect.transaction((tx) => dialect.getSandboxMeta(tx, first));
			expect({ code: (accessError as { code?: string } | undefined)?.code, meta }).toEqual({
				code: "ENOENT",
				meta: null,
			});
		} finally {
			await dialect.disconnect();
		}
	});

	it("runs shared async readers concurrently on one resident", async () => {
		const manager = makeManager(3);
		const id = await create(manager);
		const started = performance.now();
		const results = await Promise.all(
			["first", "second"].map((label) =>
				manager.withSessionRead("default", id, (session) =>
					manager.execWithRuntimeThrottle(session, `sleep 0.2; echo ${label}`),
				),
			),
		);
		expect(results.map((result) => result.stdout)).toEqual(["first\n", "second\n"]);
		expect(performance.now() - started).toBeLessThan(350);
	});

	it("attributes a read-only violation only to the offending concurrent reader", async () => {
		const manager = makeManager(3);
		const id = await create(manager);
		const results = await Promise.allSettled([
			manager.withSessionRead("default", id, (session) =>
				manager.execWithRuntimeThrottle(session, "echo rejected > /home/user/forbidden"),
			),
			manager.withSessionRead("default", id, (session) =>
				manager.execWithRuntimeThrottle(session, "sleep 0.02; echo innocent"),
			),
		]);
		expect(results[0]).toMatchObject({ status: "rejected", reason: { code: "EREADONLY_VIOLATION" } });
		expect(results[1]).toMatchObject({ status: "fulfilled", value: { stdout: "innocent\n", exitCode: 0 } });
		await manager.withSessionRead("default", id, async (session) =>
			expect(await session.fs.exists("/home/user/forbidden")).toBe(false),
		);
	});

	it("aborts direct file batches as one transaction", async () => {
		const manager = makeManager();
		const id = await create(manager);
		await expect(
			manager.withSessionOrRehydrate("default", id, async (session) => {
				await session.scriptTx?.run(async () => {
					await session.fs.writeFile("/home/user/rollback", "not committed");
					throw Object.assign(new Error("batch rejected"), { code: "EINVAL" });
				});
			}),
		).rejects.toMatchObject({ code: "EINVAL" });
		await manager.withSessionRead("default", id, async (session) =>
			expect(await session.fs.exists("/home/user/rollback")).toBe(false),
		);
	});

	it("leaves the outer scope responsible for rollback after an inner batch returns", async () => {
		const manager = makeManager();
		const id = await create(manager);
		await expect(
			manager.withSessionOrRehydrate("default", id, async (session) => {
				await session.scriptTx?.run(async () => {
					await session.fs.writeFile("/home/user/outer", "rollback");
					await session.scriptTx?.run(() => session.fs.writeFile("/home/user/inner", "rollback"));
					throw Object.assign(new Error("outer rejected"), { code: "EINVAL" });
				});
			}),
		).rejects.toMatchObject({ code: "EINVAL" });
		await manager.withSessionRead("default", id, async (session) => {
			expect(await session.fs.exists("/home/user/outer")).toBe(false);
			expect(await session.fs.exists("/home/user/inner")).toBe(false);
		});
	});

	it("reports a dispatched read-only script crash as unknown and safely reopens", async () => {
		const manager = makeManager(1);
		const id = await create(manager);
		let dispatched: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			dispatched = resolve;
		});
		const operation = manager.withSessionRead("default", id, (session) => {
			const execution = manager.execWithRuntimeThrottle(session, "sleep 30; echo done");
			dispatched();
			return execution;
		});
		const assertion = expect(operation).rejects.toMatchObject({ code: "EEXEC_OUTCOME_UNKNOWN" });
		await started;
		await manager.crashWorkerForTest("default", id);
		await assertion;
		expect(manager.getWorkerMetrics()?.unknownOutcomes).toBe(1);
		await manager.withSessionRead("default", id, async (session) => {
			expect((await manager.execWithRuntimeThrottle(session, "echo recovered")).stdout).toBe("recovered\n");
		});
	});

	it("preserves request-level ambiguity when an acknowledged write precedes an undispatched RPC", async () => {
		const manager = makeManager(1);
		const id = await create(manager);
		await expect(
			manager.withSessionOrRehydrate("default", id, async (session) => {
				await session.fs.writeFile("/home/user/committed", "persisted");
				await manager.crashWorkerForTest("default", id);
				await session.fs.writeFile("/home/user/not-dispatched", "absent");
			}),
		).rejects.toMatchObject({ code: "EEXEC_OUTCOME_UNKNOWN" });
		await manager.withSessionRead("default", id, async (session) => {
			expect(await session.fs.readFile("/home/user/committed")).toBe("persisted");
			expect(await session.fs.exists("/home/user/not-dispatched")).toBe(false);
		});
	});

	it("keeps an undispatched pure read retry-safe and fences replacement", async () => {
		const manager = makeManager(1);
		const id = await create(manager);
		await expect(
			manager.withSessionRead("default", id, async (session) => {
				await manager.crashWorkerForTest("default", id);
				await session.fs.readFile("/etc/profile");
			}),
		).rejects.toMatchObject({ code: "EWORKER_UNAVAILABLE" });
		expect(manager.getWorkerMetrics()?.unknownOutcomes).toBe(0);
		await manager.withSessionRead("default", id, async (session) => {
			expect(await session.fs.exists("/home/user")).toBe(true);
		});
	});

	it.skipIf(!process.env.REDIS_URL)(
		"clears owner dirty state after durable writes and keeps clean turns clean",
		async () => {
			const redis = new Redis(process.env.REDIS_URL ?? "");
			redisClients.push(redis);
			const manager = makeManager(1, redis);
			const id = await create(manager);
			await manager.withSessionOrRehydrate("default", id, (session) =>
				session.fs.writeFile("/home/user/dirty", "written"),
			);
			const dialect = new PostgresDialect(process.env.DATABASE_URL ?? "", undefined, 1);
			await dialect.connect();
			try {
				await manager.withSessionOrRehydrate("default", id, async (session) => {
					const readEpoch = () => dialect.transaction((tx) => dialect.getSandboxEpoch(tx, id));
					const admittedEpoch = await readEpoch();
					expect(await session.fs.readFile("/home/user/dirty")).toBe("written");
					expect((session.fs as ICoherentFs).wasDirty()).toBe(false);
					expect(await readEpoch()).toBe(admittedEpoch);
				});
			} finally {
				await dialect.disconnect();
			}
		},
	);

	it.skipIf(!process.env.REDIS_URL)(
		"fences a dispatched read-only execution after a definitive lease loss",
		async () => {
			const redis = new Redis(process.env.REDIS_URL ?? "");
			redisClients.push(redis);
			const manager = makeManager(1, redis, {
				leaseMs: 5000,
				readerLeaseMs: 5000,
				renewMs: 20,
				acquireTimeoutMs: 2000,
			});
			const id = await create(manager);
			let dispatched: () => void = () => {};
			const started = new Promise<void>((resolve) => {
				dispatched = resolve;
			});
			const operation = manager.withSessionRead("default", id, (session) => {
				const pending = manager.execWithRuntimeThrottle(session, "sleep 30; echo done");
				dispatched();
				return pending;
			});
			const assertion = expect(operation).rejects.toMatchObject({ code: "EEXEC_OUTCOME_UNKNOWN" });
			await started;
			await redis.del(rwLockKeys("default", id).readers);
			await assertion;
			expect(manager.getWorkerMetrics()?.unknownOutcomes).toBe(1);
			await manager.withSessionRead("default", id, async (session) => {
				expect((await manager.execWithRuntimeThrottle(session, "echo recovered")).stdout).toBe("recovered\n");
			});
		},
	);

	it.skipIf(!process.env.REDIS_URL)("keeps a proved filesystem rollback retry-safe on lease loss", async () => {
		const redis = new Redis(process.env.REDIS_URL ?? "");
		redisClients.push(redis);
		const manager = makeManager(1, redis, { leaseMs: 5000, readerLeaseMs: 5000, renewMs: 20, acquireTimeoutMs: 2000 });
		const id = await create(manager);
		await expect(
			manager.withSessionOrRehydrate("default", id, async (session) => {
				await session.scriptTx?.beginScope();
				await session.fs.writeFile("/home/user/rollback", "absent");
				await redis.del(rwLockKeys("default", id).writer);
				await new Promise<void>((resolve) =>
					sessionLeaseSignal()?.addEventListener("abort", () => resolve(), { once: true }),
				);
				await session.scriptTx?.endScope();
			}),
		).rejects.toMatchObject({ code: "ELOCKLOST" });
		expect(manager.getWorkerMetrics()?.unknownOutcomes).toBe(0);
		await manager.withSessionRead("default", id, async (session) => {
			expect(await session.fs.exists("/home/user/rollback")).toBe(false);
		});
	});

	it("enforces an explicit worker file cap and rolls back the buffered prefix", async () => {
		const manager = new SessionManager({
			tenantConfig: loadTenantConfig(),
			workerEnabled: true,
			workerOptions: loadWorkerPoolOptions({ MAX_EXEC_FILE_BYTES: "8388608" }),
		});
		managers.push(manager);
		const id = await create(manager);
		await manager.withSessionOrRehydrate("default", id, async (session) => {
			await session.fs.writeFile("/home/user/large", new Uint8Array(8 * 1024 * 1024 + 1));
		});
		await expect(
			manager.withSessionOrRehydrate("default", id, (session) =>
				manager.execWithRuntimeThrottle(session, "echo prefix > /home/user/prefix; cat /home/user/large"),
			),
		).rejects.toMatchObject({ code: "EFBIG" });
		await manager.withSessionRead("default", id, async (session) =>
			expect(await session.fs.exists("/home/user/prefix")).toBe(false),
		);
	});

	it("reads above the former file cap on an opted-in worker while the inline cap remains enforced", async () => {
		const manager = makeManager(1, undefined, undefined, true);
		const id = await create(manager);
		const size = 8 * 1024 * 1024 + 1;
		await manager.withSessionOrRehydrate("default", id, (session) =>
			session.fs.writeFile("/home/user/large", new Uint8Array(size)),
		);
		await manager.withSessionRead("default", id, async (session) => {
			expect((await manager.execWithRuntimeThrottle(session, "wc -c /home/user/large")).stdout).toBe(
				`${size} /home/user/large\n`,
			);
		});
		const inline = new SessionManager({ tenantConfig: loadTenantConfig(), workerEnabled: false });
		managers.push(inline);
		await inline.getOrCreate("default", id, undefined, "worker-test-owner");
		await expect(
			inline.withSessionRead("default", id, (session) =>
				inline.execWithRuntimeThrottle(session, "wc -c /home/user/large"),
			),
		).rejects.toMatchObject({ code: "EFBIG" });
	});

	it.each([
		{ leaseLost: true, persisted: false },
		{ leaseLost: false, persisted: true },
	])(
		"checks the lease word before flush while preserving ordinary cancellation ($leaseLost)",
		async ({ leaseLost, persisted }) => {
			const manager = new SessionManager({ tenantConfig: loadTenantConfig(), workerEnabled: false });
			managers.push(manager);
			const id = await create(manager);
			const operation = manager.withSessionOrRehydrate("default", id, async (session) => {
				await session.scriptTx?.beginScope();
				await session.fs.writeFile("/home/user/cancellation", "prefix");
				const words = new Int32Array(new SharedArrayBuffer(8));
				Atomics.store(words, leaseLost ? 1 : 0, 1);
				await ownerCancellation.run(words, () => session.scriptTx?.endScope());
			});
			if (leaseLost) await expect(operation).rejects.toMatchObject({ code: "ELOCKLOST" });
			else await operation;
			await manager.withSessionRead("default", id, async (session) =>
				expect(await session.fs.exists("/home/user/cancellation")).toBe(persisted),
			);
		},
	);
});

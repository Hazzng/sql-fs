import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { beforeAll, describe, expect, it, type MockInstance, vi } from "vitest";
import { destroyPostgresSandbox } from "../../../sql-fs/index.js";
import { requireMigratedSchema } from "../../../sql-fs/tests/integration/helpers/schema-preconditions.js";
import { SessionManager } from "../../session-manager.js";
import { loadTenantConfig } from "../../tenants.js";
import { loadWorkerPoolOptions, WorkerOwnerPool } from "../../worker-owner/pool.js";
import type { OwnerIdentity, OwnerRequest } from "../../worker-owner/protocol.js";

function checkpoint() {
	let resolve: () => void = () => {};
	const reached = new Promise<void>((done) => {
		resolve = done;
	});
	return { reached, resolve };
}

async function until(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 5000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Worker lifecycle checkpoint was not reached");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

interface ThreadFixture {
	readonly dead: boolean;
	terminate(): Promise<number>;
}

interface SlotFixture {
	readonly readers: number;
	readonly thread?: ThreadFixture;
}

describe.skipIf(!process.env.DATABASE_URL)("worker replacement ownership", () => {
	beforeAll(async () => {
		await requireMigratedSchema(process.env.DATABASE_URL ?? "");
	});

	it.each(["target", "previous", "rejected disconnect"] as const)(
		"keeps worker residency accurate after replacement failure (%s)",
		async (next) => {
			const connectionString = process.env.DATABASE_URL ?? "";
			const pool = new WorkerOwnerPool(
				loadWorkerPoolOptions({
					...process.env,
					SQL_FS_WORKER_COUNT: "1",
					SQL_FS_WORKER_ACTIVE_TENANT_MAX: "1",
					SQL_FS_WORKER_HEAP_MB: "256",
				}),
			);
			const id = randomUUID();
			const previous: OwnerIdentity = {
				tenantId: "default",
				sandboxId: `replacement-previous-${id}`,
				connectionString,
				runtimeOptions: { python: false, javascript: false, network: false },
				owner: "previous-owner",
				cwd: "/home/user",
			};
			const target = { ...previous, sandboxId: `replacement-target-${id}`, owner: "target-owner" };
			const unavailable = new URL(connectionString);
			unavailable.pathname = `/replacement-unavailable-${id}`;
			const requests: { thread: Worker; kind: OwnerRequest["command"]["kind"] }[] = [];
			const realPostMessage = Worker.prototype.postMessage;
			const postMessage = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
				this: Worker,
				value: OwnerRequest,
				transferList,
			) {
				requests.push({ thread: this, kind: value.command.kind });
				const delivered =
					next === "rejected disconnect" && value.command.kind === "disconnect"
						? { ...value, generation: value.generation + 1 }
						: value;
				return realPostMessage.call(this, delivered, transferList);
			});
			vi.stubEnv("REDIS_BLOB_CACHE_ENABLED", "false");
			try {
				await pool.run(previous.tenantId, previous.sandboxId, false, async () => {
					expect(await pool.attach(previous)).toMatchObject({ owner: previous.owner });
					await pool.send({ kind: "writeFile", args: ["/home/user/persisted", "durable previous bytes\n"] });
				});
				await pool.run(target.tenantId, target.sandboxId, false, async () => {
					await expect(pool.attach({ ...target, connectionString: unavailable.href })).rejects.toMatchObject({
						code: next === "rejected disconnect" ? "EEXEC_OUTCOME_UNKNOWN" : "3D000",
					});
					if (next === "rejected disconnect") {
						expect(pool.metadata).toMatchObject({ owner: previous.owner });
					} else {
						expect.soft(pool.metadata).toBeUndefined();
					}
					expect.soft(pool.metrics).toMatchObject({
						residentSessions: next === "rejected disconnect" ? 1 : 0,
						readyWorkers: 1,
						restarts: 0,
					});
				});
				expect(requests.map(({ kind }) => kind)).toEqual(
					next === "rejected disconnect"
						? ["attach", "writeFile", "disconnect"]
						: ["attach", "writeFile", "disconnect", "attach"],
				);
				const identity = next === "target" ? target : previous;
				const recovered = await pool.run(identity.tenantId, identity.sandboxId, false, async () => {
					const metadata = await pool.attach(identity);
					const result = await pool.send({
						kind: "exec",
						script: "echo once >> /home/user/attempts; cat /home/user/attempts",
						options: {},
					});
					return { metadata, result };
				});
				expect(recovered).toMatchObject({
					metadata: { owner: identity.owner },
					result: { exitCode: 0, stdout: "once\n" },
				});
				await pool.run(previous.tenantId, previous.sandboxId, false, async () => {
					expect(await pool.attach(previous)).toMatchObject({ owner: previous.owner });
					expect(await pool.send({ kind: "readFile", args: ["/home/user/persisted"] })).toBe(
						"durable previous bytes\n",
					);
				});
				expect(new Set(requests.map(({ thread }) => thread)).size).toBe(1);
				expect(requests.filter(({ kind }) => kind === "exec")).toHaveLength(1);
				expect(pool.metrics).toMatchObject({
					residentSessions: 1,
					readyWorkers: 1,
					restarts: 0,
					unknownOutcomes: 0,
					active: 0,
					queued: 0,
				});
			} finally {
				await pool.shutdown(1000);
				postMessage.mockRestore();
				vi.unstubAllEnvs();
				await destroyPostgresSandbox(connectionString, previous.sandboxId);
				await destroyPostgresSandbox(connectionString, target.sandboxId);
			}
		},
	);

	it.each(["idle", "active", "shutdown"] as const)(
		"shares one replacement and closes every actual worker (%s)",
		async (mode) => {
			const workers = new Set<Worker>();
			const exited = new Set<Worker>();
			const requests: OwnerRequest[] = [];
			let peakLiveWorkers = 0;
			const realOn = Worker.prototype.on;
			const on = vi.spyOn(Worker.prototype, "on").mockImplementation(function (this: Worker, event, listener) {
				if (!workers.has(this)) {
					workers.add(this);
					peakLiveWorkers = Math.max(peakLiveWorkers, workers.size - exited.size);
					realOn.call(this, "exit", () => exited.add(this));
				}
				return realOn.call(this, event, listener);
			});
			const dispatched = checkpoint();
			const realPostMessage = Worker.prototype.postMessage;
			const postMessage = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
				this: Worker,
				value: OwnerRequest,
				transferList,
			) {
				requests.push(value);
				realPostMessage.call(this, value, transferList);
				if (value.command.kind === "exec" && value.command.script === "sleep 30; echo unreachable") {
					dispatched.resolve();
				}
			});
			const manager = new SessionManager({
				tenantConfig: loadTenantConfig(),
				workerEnabled: true,
				workerOptions: loadWorkerPoolOptions({
					...process.env,
					SQL_FS_WORKER_COUNT: "9",
					SQL_FS_WORKER_ACTIVE_TENANT_MAX: "8",
					SQL_FS_WORKER_HEAP_MB: "128",
					SQL_FS_WORKER_PG_POOL_MAX: "1",
					SQL_FS_WORKER_MAX_PG_CONNECTIONS: "9",
					SQL_FS_WORKER_QUEUE_WAIT_MS: "5000",
				}),
				defenseInDepth: true,
				defenseAuditMode: false,
			});
			const id = `worker-replacement-${randomUUID()}`;
			const retire = checkpoint();
			let closed = false;
			let wave: Promise<PromiseSettledResult<{ bytes: string; cwd: string }>[]> | undefined;
			let terminate: MockInstance<ThreadFixture["terminate"]> | undefined;
			let attach: MockInstance<WorkerOwnerPool["attach"]> | undefined;
			try {
				await manager.withSession(
					"default",
					id,
					async (session) => {
						await session.fs.writeFile("/home/user/persisted", "durable before crash\n");
						expect(
							await manager.execWithRuntimeThrottle(session, "mkdir /home/user/project; cd /home/user/project"),
						).toMatchObject({ exitCode: 0 });
					},
					{ python: false, javascript: false, network: false },
				);
				if (mode === "active") {
					const operation = manager
						.withSessionRead("default", id, (session) =>
							manager.execWithRuntimeThrottle(session, "sleep 30; echo unreachable"),
						)
						.then(
							() => undefined,
							(error: unknown) => error,
						);
					await dispatched.reached;
					await manager.crashWorkerForTest("default", id);
					expect(await operation).toMatchObject({ code: "EEXEC_OUTCOME_UNKNOWN" });
				} else {
					await manager.crashWorkerForTest("default", id);
				}
				const pool = (manager as unknown as { workerPool: WorkerOwnerPool }).workerPool;
				const slot = (pool as unknown as { slots: SlotFixture[] }).slots[0];
				const oldThread = slot?.thread;
				if (slot === undefined || oldThread === undefined || !oldThread.dead) {
					throw new Error("The actual crashed worker was not retained for the replacement test");
				}
				const realTerminate = oldThread.terminate.bind(oldThread);
				let terminationCalls = 0;
				terminate = vi.spyOn(oldThread, "terminate").mockImplementation(async () => {
					terminationCalls++;
					await retire.reached;
					return realTerminate();
				});
				const realAttach = pool.attach.bind(pool);
				let attachCalls = 0;
				attach = vi.spyOn(pool, "attach").mockImplementation((identity) => {
					attachCalls++;
					return realAttach(identity);
				});
				wave = Promise.allSettled(
					Array.from({ length: 8 }, () =>
						manager.withSessionRead("default", id, async (session) => ({
							bytes: await session.fs.readFile("/home/user/persisted"),
							cwd: (await manager.execWithRuntimeThrottle(session, "pwd")).stdout,
						})),
					),
				);
				await until(() => attachCalls === 8 && slot.readers === 8);
				const shutdown = mode === "shutdown" ? manager.shutdown({ drainTimeoutMs: 0 }) : undefined;
				if (shutdown !== undefined) await until(() => terminationCalls === 2);
				retire.resolve();
				const results = await wave;
				await shutdown;
				const metrics = manager.getWorkerMetrics();
				const liveAfterRecovery = workers.size - exited.size;
				const attachRequests = requests.filter((request) => request.command.kind === "attach").length;
				if (shutdown === undefined) {
					await manager.destroy("default", id);
					await manager.shutdown({ drainTimeoutMs: 1000 });
				}
				closed = true;
				const liveAfterShutdown = workers.size - exited.size;
				console.log(
					JSON.stringify({
						case: "concurrent-worker-replacement",
						mode,
						readers: results.length,
						terminationCalls,
						constructedWorkers: workers.size,
						attachRequests,
						peakLiveWorkers,
						liveAfterRecovery,
						liveAfterShutdown,
						trackedReadyWorkers: metrics?.readyWorkers,
					}),
				);
				for (const result of results) {
					if (mode === "shutdown") {
						expect(result.status).toBe("rejected");
						if (result.status === "rejected") {
							expect(["ESHUTTINGDOWN", "ESESSIONCLOSING"]).toContain(result.reason.code);
						}
					} else {
						expect(result).toEqual({
							status: "fulfilled",
							value: { bytes: "durable before crash\n", cwd: "/home/user/project\n" },
						});
					}
				}
				expect(terminationCalls).toBe(mode === "shutdown" ? 2 : 1);
				expect(workers.size).toBe(mode === "shutdown" ? 1 : 2);
				expect(attachRequests).toBe(mode === "shutdown" ? 1 : 2);
				expect(peakLiveWorkers).toBe(1);
				expect(liveAfterRecovery).toBe(mode === "shutdown" ? 0 : 1);
				expect(liveAfterShutdown).toBe(0);
				expect([...workers].every((worker) => worker.threadId === -1)).toBe(true);
				if (mode !== "shutdown") {
					expect(metrics).toMatchObject({ readyWorkers: 1, residentSessions: 1, restarts: 1 });
				}
			} finally {
				retire.resolve();
				await wave;
				terminate?.mockRestore();
				attach?.mockRestore();
				if (!closed) {
					await manager.destroy("default", id).catch(() => {});
					await manager.shutdown({ drainTimeoutMs: 1000 });
				}
				await Promise.all([...workers].map((worker) => worker.terminate()));
				await destroyPostgresSandbox(process.env.DATABASE_URL ?? "", id);
				postMessage.mockRestore();
				on.mockRestore();
			}
		},
	);
});

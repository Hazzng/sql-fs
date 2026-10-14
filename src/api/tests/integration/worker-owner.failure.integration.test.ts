import { type ChildProcess, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { Redis } from "ioredis";
import postgres from "postgres";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PostgresDialect } from "../../../sql-fs/dialects/postgres.js";
import { destroyPostgresSandbox } from "../../../sql-fs/index.js";
import { SqlFs } from "../../../sql-fs/sql-fs.js";
import { requireMigratedSchema } from "../../../sql-fs/tests/integration/helpers/schema-preconditions.js";
import { rwLockKeys } from "../../distributed-rw-lock.js";
import { SessionManager } from "../../session-manager.js";
import { loadTenantConfig, type TenantConfig } from "../../tenants.js";
import { loadWorkerPoolOptions } from "../../worker-owner/pool.js";
import { workerRequestContext } from "../../worker-owner/request-context.js";
import { commitReplyGate } from "../fixtures/commit-reply-gate.js";

const SKIP = !process.env.DATABASE_URL || !process.env.REDIS_URL;
const TENANT = "default";

async function freshRead(id: string, path: string): Promise<string | false> {
	const dialect = new PostgresDialect(process.env.DATABASE_URL!, undefined, 1);
	await dialect.connect();
	try {
		const fs = new SqlFs({ dialect, sandboxId: id });
		await fs.ready();
		return (await fs.exists(path)) ? await fs.readFile(path) : false;
	} finally {
		await dialect.disconnect();
	}
}

async function sandboxExists(id: string): Promise<boolean> {
	const dialect = new PostgresDialect(process.env.DATABASE_URL!, undefined, 1);
	await dialect.connect();
	try {
		return (await dialect.transaction((tx) => dialect.getSandboxMeta(tx, id))) !== null;
	} finally {
		await dialect.disconnect();
	}
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}

async function until(predicate: () => boolean | Promise<boolean>, description: string): Promise<void> {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Did not observe ${description}`);
}

async function dispatched(gate: Promise<void>, outcome: Promise<unknown>): Promise<void> {
	await Promise.race([
		gate,
		outcome.then((error) => {
			throw error ?? new Error("Operation ended before the expected checkpoint");
		}),
	]);
}

function settledFailure(operation: Promise<unknown>): Promise<unknown> {
	return operation.then(
		() => undefined,
		(error: unknown) => error,
	);
}

describe.skipIf(SKIP)("worker owner failure contracts against Postgres and Redis", () => {
	const managers: SessionManager[] = [];
	const clients: Redis[] = [];
	const sandboxIds: string[] = [];
	const releases: Array<() => void> = [];
	const children: ChildProcess[] = [];
	const additionalRedisKeys: string[] = [];

	beforeAll(async () => {
		await requireMigratedSchema(process.env.DATABASE_URL!);
	});

	afterEach(async () => {
		for (const child of children.splice(0)) {
			if (child.exitCode === null && child.signalCode === null) {
				const exited = once(child, "exit");
				child.kill("SIGKILL");
				await exited;
			}
		}
		for (const release of releases.splice(0)) release();
		await Promise.allSettled(managers.splice(0).map((manager) => manager.shutdown()));
		for (const id of sandboxIds.splice(0)) {
			await destroyPostgresSandbox(process.env.DATABASE_URL!, id);
			const { writer, readers } = rwLockKeys(TENANT, id);
			await clients[0]?.del(writer, readers);
		}
		if (additionalRedisKeys.length > 0) await clients[0]?.del(...additionalRedisKeys.splice(0));
		await Promise.all(clients.splice(0).map((client) => client.quit()));
	});

	function manager(
		count = 2,
		waitMs = 500,
		workerEnabled = true,
		overrides: Partial<ReturnType<typeof loadWorkerPoolOptions>> = {},
		tenantConfig: TenantConfig = loadTenantConfig(),
	): SessionManager {
		const redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: 1 });
		clients.push(redis);
		const instance = new SessionManager({
			tenantConfig,
			redis,
			workerEnabled,
			workerOptions: {
				...loadWorkerPoolOptions(),
				count,
				waitMs,
				heapMb: 512,
				maxQueued: 2,
				maxQueuedPerTenant: 1,
				maxRssBytes: 4 * 1024 * 1024 * 1024,
				...overrides,
			},
			execLockOptions: { leaseMs: 5000, renewMs: 1000, acquireTimeoutMs: 5000, acquireRetryMs: 10 },
		});
		managers.push(instance);
		return instance;
	}

	function sandbox(): string {
		const id = `worker-failure-${randomUUID()}`;
		sandboxIds.push(id);
		return id;
	}

	function gate() {
		const value = deferred();
		releases.push(value.resolve);
		return value;
	}

	it("reports an unknown outcome when initial attach commits creation before worker loss", async () => {
		const id = sandbox();
		const proxy = await commitReplyGate(process.env.DATABASE_URL!, () => sandboxExists(id));
		const owner = manager(2, 500, true, {}, loadTenantConfig({ DATABASE_URL: proxy.connectionString }));
		try {
			proxy.arm();
			const creating = owner.getOrCreate(TENANT, id);
			const outcome = settledFailure(creating);
			await dispatched(proxy.held, outcome);
			expect(await sandboxExists(id)).toBe(true);
			await owner.crashWorkerForTest(TENANT, id);
			proxy.release();
			expect(await outcome).toMatchObject({ code: "EEXEC_OUTCOME_UNKNOWN" });
			expect(owner.getSession(TENANT, id)).toBeUndefined();
			expect(await sandboxExists(id)).toBe(true);
		} finally {
			proxy.release();
			await owner.shutdown({ drainTimeoutMs: 100 });
			await proxy.close();
		}
	}, 15000);

	it.each(["withSession", "withSessionRead"] as const)(
		"evicts a cached worker session after %s cannot reattach a deleted sandbox",
		async (method) => {
			const owner = manager();
			const peer = manager();
			const id = sandbox();
			await owner.withSession(TENANT, id, async () => {});
			await peer.withSession(TENANT, id, async () => {});
			const cached = peer.getSession(TENANT, id);
			expect(cached).toBeDefined();
			await peer.crashWorkerForTest(TENANT, id);
			await destroyPostgresSandbox(process.env.DATABASE_URL!, id);
			const callback = vi.fn(async () => "stale");
			const request =
				method === "withSession" ? peer.withSession(TENANT, id, callback) : peer.withSessionRead(TENANT, id, callback);
			await expect(request).rejects.toMatchObject({ code: "ENOENT" });
			expect(callback).not.toHaveBeenCalled();
			expect(peer.getSession(TENANT, id)).toBeUndefined();
			expect(cached?.state).toBe("closing");
		},
		15000,
	);

	it.each([true, false])(
		"discards an acknowledged write when its worker dies before commit (buffered=%s)",
		async (bufferedMode) => {
			const owner = manager(2, 500, true, {
				scriptTxBuffer: { enabled: bufferedMode, maxOps: 100, maxBytes: 1024 * 1024 },
			});
			const id = sandbox();
			const buffered = gate();
			const continueFlush = gate();
			let invocations = 0;
			const writing = owner.withSession(TENANT, id, async (session) => {
				invocations++;
				await session.scriptTx!.beginScope();
				await session.fs.writeFile("/uncommitted.txt", "must not persist\n");
				buffered.resolve();
				await continueFlush.promise;
				await session.scriptTx!.endScope();
			});
			const outcome = settledFailure(writing);
			await dispatched(buffered.promise, outcome);
			await owner.crashWorkerForTest(TENANT, id);
			continueFlush.resolve();
			expect(await outcome).toMatchObject({ code: "EEXEC_OUTCOME_UNKNOWN" });
			expect(invocations).toBe(1);
			expect(await freshRead(id, "/uncommitted.txt")).toBe(false);
			await owner.withSessionRead(TENANT, id, async (session) => {
				expect(await session.fs.exists("/uncommitted.txt")).toBe(false);
			});
			await owner.withSession(TENANT, id, async (session) => {
				await session.fs.writeFile("/recovered.txt", "healthy\n");
			});
			expect(await freshRead(id, "/recovered.txt")).toBe("healthy\n");
		},
	);

	it("rolls back a flush blocked on the real Postgres writer lock after worker loss", async () => {
		const owner = manager();
		const id = sandbox();
		const buffered = gate();
		const flush = gate();
		const releaseLock = gate();
		const writing = owner.withSession(TENANT, id, async (session) => {
			await session.scriptTx!.beginScope();
			await session.fs.writeFile("/blocked-flush.txt", "must roll back\n");
			buffered.resolve();
			await flush.promise;
			await session.scriptTx!.endScope();
		});
		const outcome = settledFailure(writing);
		await dispatched(buffered.promise, outcome);
		const blocker = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
		const inspector = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
		const locked = gate();
		let blockerPid = 0;
		const holding = blocker.begin(async (tx) => {
			await tx`SELECT pg_advisory_xact_lock(hashtextextended(${id}, 0))`;
			const rows = await tx`SELECT pg_backend_pid() AS pid`;
			blockerPid = Number(rows[0]!.pid);
			locked.resolve();
			await releaseLock.promise;
		});
		try {
			await locked.promise;
			flush.resolve();
			await until(async () => {
				const rows = await inspector`SELECT pid FROM pg_stat_activity WHERE ${blockerPid} = ANY(pg_blocking_pids(pid))`;
				return rows.length > 0;
			}, "worker flush waiting for its sandbox writer lock");
			await owner.crashWorkerForTest(TENANT, id);
			releaseLock.resolve();
			await holding;
			expect(await outcome).toMatchObject({ code: "EEXEC_OUTCOME_UNKNOWN" });
			expect(await freshRead(id, "/blocked-flush.txt")).toBe(false);
			await owner.withSessionRead(TENANT, id, async (session) => {
				expect(await session.fs.exists("/blocked-flush.txt")).toBe(false);
			});
		} finally {
			releaseLock.resolve();
			await holding;
			await Promise.all([blocker.end({ timeout: 5 }), inspector.end({ timeout: 5 })]);
		}
	});

	it.each([true, false])(
		"refreshes a warm peer (worker=%s) after a committed write loses its worker before parent acknowledgment",
		async (peerWorker) => {
			const owner = manager();
			const peer = manager(2, 500, peerWorker);
			const id = sandbox();
			await owner.withSession(TENANT, id, async (session) => session.fs.writeFile("/counter.txt", "initial\n"));
			await peer.withSession(TENANT, id, async () => {});
			await peer.withSessionRead(TENANT, id, async (session) => {
				expect(await session.fs.readFile("/counter.txt")).toBe("initial\n");
			});
			const committed = gate();
			const continueRequest = gate();
			let invocations = 0;
			const writing = owner.withSession(TENANT, id, async (session) => {
				invocations++;
				await session.fs.appendFile("/counter.txt", "once\n");
				committed.resolve();
				await continueRequest.promise;
				await session.fs.stat("/counter.txt");
			});
			const outcome = settledFailure(writing);
			await dispatched(committed.promise, outcome);
			await owner.crashWorkerForTest(TENANT, id);
			continueRequest.resolve();
			expect(await outcome).toMatchObject({ code: "EEXEC_OUTCOME_UNKNOWN" });
			expect(invocations).toBe(1);
			expect(await freshRead(id, "/counter.txt")).toBe("initial\nonce\n");
			await peer.withSessionRead(TENANT, id, async (session) => {
				expect(await session.fs.readFile("/counter.txt")).toBe("initial\nonce\n");
			});
			expect(owner.getWorkerMetrics()!.unknownOutcomes).toBeGreaterThan(0);
		},
	);

	it.each([true, false])(
		"refreshes a warm peer (worker=%s) when committed bytes lose their PostgreSQL acknowledgment and worker",
		async (peerWorker) => {
			const id = sandbox();
			const proxy = await commitReplyGate(
				process.env.DATABASE_URL!,
				async () => (await freshRead(id, "/counter.txt")) === "initial\nonce\n",
			);
			const config = loadTenantConfig({ DATABASE_URL: proxy.connectionString });
			const owner = manager(2, 500, true, {}, config);
			const peer = manager(2, 500, peerWorker);
			let invocations = 0;
			try {
				await owner.withSession(TENANT, id, async (session) => session.fs.writeFile("/counter.txt", "initial\n"));
				await peer.withSession(TENANT, id, async () => {});
				await peer.withSessionRead(TENANT, id, async (session) =>
					expect(await session.fs.readFile("/counter.txt")).toBe("initial\n"),
				);
				const writing = owner.withSession(TENANT, id, async (session) => {
					invocations++;
					proxy.arm();
					await session.fs.appendFile("/counter.txt", "once\n");
				});
				const outcome = settledFailure(writing);
				await dispatched(proxy.held, outcome);
				expect(await freshRead(id, "/counter.txt")).toBe("initial\nonce\n");
				await owner.crashWorkerForTest(TENANT, id);
				proxy.release();
				expect(await outcome).toMatchObject({ code: "EEXEC_OUTCOME_UNKNOWN" });
				expect(invocations).toBe(1);
				await peer.withSessionRead(TENANT, id, async (session) =>
					expect(await session.fs.readFile("/counter.txt")).toBe("initial\nonce\n"),
				);
				expect(owner.getWorkerMetrics()!.unknownOutcomes).toBeGreaterThan(0);
			} finally {
				proxy.release();
				await owner.shutdown({ drainTimeoutMs: 100 });
				await proxy.close();
			}
		},
		15000,
	);

	it("refuses bounded queued work without running its callback", async () => {
		const owner = manager(1, 80);
		const first = sandbox();
		const second = sandbox();
		const entered = gate();
		const release = gate();
		const running = owner.withSession(TENANT, first, async () => {
			entered.resolve();
			await release.promise;
		});
		await entered.promise;
		let queuedRan = false;
		const queued = owner.withSession(TENANT, second, async (session) => {
			queuedRan = true;
			await session.fs.writeFile("/must-not-run.txt", "forbidden\n");
		});
		const refused = settledFailure(queued);
		await until(() => owner.getWorkerMetrics()!.queued === 1, "one queued request");
		const metrics = owner.getWorkerMetrics()!;
		expect(metrics.busyWorkers).toBe(1);
		expect(metrics.queued).toBeLessThanOrEqual(2);
		expect(metrics.queuedBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
		expect(await refused).toMatchObject({ code: "EWORKER_BUSY" });
		expect(queuedRan).toBe(false);
		expect(owner.getWorkerMetrics()!.queued).toBe(0);
		release.resolve();
		await running;
		expect(owner.getWorkerMetrics()!.busyWorkers).toBe(0);
	});
	it.each(["buffered", "committed"])(
		"recovers a warm independent peer after parent SIGKILL with %s work",
		async (mode) => {
			const peer = manager();
			const id = sandbox();
			await peer.withSession(TENANT, id, async (session) => session.fs.writeFile("/counter.txt", "initial\n"));
			await peer.withSessionRead(TENANT, id, async (session) => {
				expect(await session.fs.readFile("/counter.txt")).toBe("initial\n");
			});
			const child = fork(fileURLToPath(new URL("../fixtures/worker-parent-loss.ts", import.meta.url)), [id, mode], {
				execArgv: ["--import", "tsx"],
				stdio: ["ignore", "ignore", "ignore", "ipc"],
			});
			children.push(child);
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("Parent-loss fixture did not reach its checkpoint")), 10000);
				child.once("error", reject);
				child.once("exit", () => reject(new Error("Parent-loss fixture exited before its checkpoint")));
				child.once("message", (message) => {
					clearTimeout(timer);
					if ((message as { checkpoint?: string }).checkpoint === mode) resolve();
					else reject(new Error("Parent-loss fixture failed before its checkpoint"));
				});
			});
			const exited = once(child, "exit");
			child.kill("SIGKILL");
			await exited;
			expect(child.signalCode).toBe("SIGKILL");
			expect(await freshRead(id, "/orphaned.txt")).toBe(false);
			expect(await freshRead(id, "/counter.txt")).toBe(mode === "committed" ? "initial\nonce\n" : "initial\n");
			await peer.withSessionRead(TENANT, id, async (session) => {
				expect(await session.fs.exists("/orphaned.txt")).toBe(false);
				expect(await session.fs.readFile("/counter.txt")).toBe(mode === "committed" ? "initial\nonce\n" : "initial\n");
			});
		},
		15000,
	);

	it("removes aborted queued payloads without dispatching or charging their bytes", async () => {
		const owner = manager(1, 5000);
		const entered = gate();
		const release = gate();
		const running = owner.withSession(TENANT, sandbox(), async () => {
			entered.resolve();
			await release.promise;
		});
		await entered.promise;
		const controller = new AbortController();
		let queuedRan = false;
		const bytes = 2 * 1024 * 1024;
		const refused = settledFailure(
			workerRequestContext.run({ bytes, signal: controller.signal }, () =>
				owner.withSession(TENANT, sandbox(), async () => {
					queuedRan = true;
				}),
			),
		);
		await until(() => owner.getWorkerMetrics()!.queued === 1, "queued decoded payload");
		expect(owner.getWorkerMetrics()!.queuedBytes).toBe(bytes);
		controller.abort();
		expect(await refused).toMatchObject({ code: "ABORTED" });
		expect(queuedRan).toBe(false);
		expect(owner.getWorkerMetrics()!.queuedBytes).toBe(0);
		expect(owner.getWorkerMetrics()!.queued).toBe(0);
		release.resolve();
		await running;
	});

	it("refuses oversized retained payloads while worker capacity is occupied", async () => {
		const owner = manager(1, 5000, true, { maxQueuedBytes: 1024 * 1024, maxQueuedBytesPerTenant: 512 * 1024 });
		const entered = gate();
		const release = gate();
		const running = owner.withSession(TENANT, sandbox(), async () => {
			entered.resolve();
			await release.promise;
		});
		await entered.promise;
		let queuedRan = false;
		const refused = settledFailure(
			workerRequestContext.run({ bytes: 2 * 1024 * 1024 }, () =>
				owner.withSession(TENANT, sandbox(), async () => {
					queuedRan = true;
				}),
			),
		);
		expect(await refused).toMatchObject({ code: "EWORKER_BUSY" });
		expect(queuedRan).toBe(false);
		expect(owner.getWorkerMetrics()!.queuedBytes).toBe(0);
		expect(owner.getWorkerMetrics()!.queued).toBe(0);
		release.resolve();
		await running;
	});

	it("rejects queued work on shutdown while allowing admitted work to finish", async () => {
		const owner = manager(1, 5000);
		const entered = gate();
		const release = gate();
		const id = sandbox();
		const running = owner.withSession(TENANT, id, async (session) => {
			entered.resolve();
			await release.promise;
			await session.fs.writeFile("/shutdown.txt", "completed\n");
		});
		await entered.promise;
		let queuedRan = false;
		const refused = settledFailure(
			owner.withSession(TENANT, sandbox(), async () => {
				queuedRan = true;
			}),
		);
		await until(() => owner.getWorkerMetrics()!.queued === 1, "queued request before shutdown");
		const shuttingDown = owner.shutdown({ drainTimeoutMs: 5000 });
		expect(await refused).toMatchObject({ code: "ESHUTTINGDOWN" });
		expect(queuedRan).toBe(false);
		release.resolve();
		await running;
		await shuttingDown;
		expect(owner.getWorkerMetrics()!.queued).toBe(0);
		expect(owner.getWorkerMetrics()!.active).toBe(0);
		const peer = manager();
		await peer.withSession(TENANT, id, async (session) =>
			expect(await session.fs.readFile("/shutdown.txt")).toBe("completed\n"),
		);
	});
	it("holds script dispatch behind durable generation claim and recovers if claim loses its worker", async () => {
		const owner = manager();
		const id = sandbox();
		await owner.withSession(TENANT, id, async (session) => session.fs.writeFile("/claim.txt", "initial\n"));
		const blocker = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
		const inspector = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
		const locked = gate();
		const releaseLock = gate();
		let blockerPid = 0;
		let scriptDispatched = false;
		const holding = blocker.begin(async (tx) => {
			await tx`SELECT pg_advisory_xact_lock(hashtextextended(${id}, 0))`;
			const rows = await tx`SELECT pg_backend_pid() AS pid`;
			blockerPid = Number(rows[0]!.pid);
			locked.resolve();
			await releaseLock.promise;
		});
		try {
			await locked.promise;
			const outcome = settledFailure(
				owner.withSessionRead(TENANT, id, async (session) => {
					scriptDispatched = true;
					return owner.execWithRuntimeThrottle(session, "echo must-not-run");
				}),
			);
			await until(async () => {
				const rows = await inspector`SELECT pid FROM pg_stat_activity WHERE ${blockerPid} = ANY(pg_blocking_pids(pid))`;
				return rows.length > 0;
			}, "durable generation claim waiting for its Postgres lock");
			expect(scriptDispatched).toBe(false);
			await owner.crashWorkerForTest(TENANT, id);
			releaseLock.resolve();
			await holding;
			expect(await outcome).toBeInstanceOf(Error);
			expect(scriptDispatched).toBe(false);
			await owner.withSessionRead(TENANT, id, async (session) =>
				expect(await session.fs.readFile("/claim.txt")).toBe("initial\n"),
			);
			expect(await freshRead(id, "/claim.txt")).toBe("initial\n");
		} finally {
			releaseLock.resolve();
			await holding;
			await Promise.all([blocker.end({ timeout: 5 }), inspector.end({ timeout: 5 })]);
		}
	});

	it("rotates real worker admission between tenants without skipping either tenant's queued order", async () => {
		const tenantA = `fair-a-${randomUUID()}`;
		const tenantB = `fair-b-${randomUUID()}`;
		const config = loadTenantConfig({
			TENANT_DATABASES: JSON.stringify({
				[tenantA]: process.env.DATABASE_URL!,
				[tenantB]: process.env.DATABASE_URL!,
			}),
		});
		const owner = manager(1, 5000, true, { maxQueued: 4, maxQueuedPerTenant: 3 }, config);
		const order: string[] = [];
		const start = gate();
		const continueActive = gate();
		const ids = new Map<string, { tenant: string; id: string }>();
		const execute = (tenant: string, name: string, release?: Promise<void>) => {
			const id = sandbox();
			ids.set(name, { tenant, id });
			const { writer, readers } = rwLockKeys(tenant, id);
			additionalRedisKeys.push(writer, readers);
			return settledFailure(
				owner.withSession(tenant, id, async (session) => {
					order.push(name);
					await session.fs.writeFile("/admission.txt", `${name}\n`);
					if (name === "active") start.resolve();
					if (release !== undefined) await release;
				}),
			);
		};
		const active = execute(tenantA, "active", continueActive.promise);
		await dispatched(start.promise, active);
		const a1 = execute(tenantA, "a1");
		const a2 = execute(tenantA, "a2");
		const b1 = execute(tenantB, "b1");
		await until(() => owner.getWorkerMetrics()?.queued === 3, "three queued requests from two tenants");
		expect(owner.getWorkerMetrics()).toMatchObject({ active: 1, queued: 3, residentSessions: 1 });
		continueActive.resolve();
		expect(await Promise.all([active, a1, a2, b1])).toEqual([undefined, undefined, undefined, undefined]);
		expect(order).toEqual(["active", "a1", "b1", "a2"]);
		for (const [name, { id }] of ids) {
			expect(await freshRead(id, "/admission.txt")).toBe(`${name}\n`);
		}
		expect(owner.getWorkerMetrics()).toMatchObject({ active: 0, queued: 0, queuedBytes: 0, residentSessions: 1 });
	});

	it("does not dispatch a callback when the tenant database connection is unavailable", async () => {
		const listener = createServer().listen(0, "127.0.0.1");
		await once(listener, "listening");
		const address = listener.address();
		if (!address || typeof address === "string") throw new Error("Expected a local TCP address");
		const unavailable = new URL(process.env.DATABASE_URL!);
		unavailable.hostname = "127.0.0.1";
		unavailable.port = String(address.port);
		await new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
		const config = loadTenantConfig({ DATABASE_URL: unavailable.toString() });
		const owner = manager(2, 500, true, {}, config);
		const id = sandbox();
		let dispatched = false;
		const outcome = settledFailure(
			owner.withSession(TENANT, id, async () => {
				dispatched = true;
			}),
		);
		expect(await outcome).toBeInstanceOf(Error);
		expect(dispatched).toBe(false);
		expect(owner.getWorkerMetrics()!.active).toBe(0);
		expect(owner.getWorkerMetrics()!.queued).toBe(0);
		const peer = manager();
		await peer.withSession(TENANT, id, async (session) => session.fs.writeFile("/healthy.txt", "healthy\n"));
		expect(await freshRead(id, "/healthy.txt")).toBe("healthy\n");
	});
});

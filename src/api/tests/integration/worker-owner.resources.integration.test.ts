import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import postgres from "postgres";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { destroyPostgresSandbox } from "../../../sql-fs/index.js";
import { requireMigratedSchema } from "../../../sql-fs/tests/integration/helpers/schema-preconditions.js";
import { type RuntimeOptions, SessionManager } from "../../session-manager.js";
import { loadTenantConfig } from "../../tenants.js";
import { WorkerOwnerPool, loadWorkerPoolOptions } from "../../worker-owner/pool.js";
import type { OwnerCommand } from "../../worker-owner/protocol.js";
import { workerRequestContext } from "../../worker-owner/request-context.js";

const TENANTS = ["worker-resource-a", "worker-resource-b"] as const;

async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Resource checkpoint was not reached");
}

describe.skipIf(!process.env.DATABASE_URL)("worker owner global resource bounds", () => {
	const managers: SessionManager[] = [];
	const sandboxes: Array<{ tenant: string; id: string }> = [];
	const timers: Array<ReturnType<typeof setInterval>> = [];

	beforeAll(async () => {
		await requireMigratedSchema(process.env.DATABASE_URL!);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const timer of timers.splice(0)) clearInterval(timer);
		await Promise.all(managers.splice(0).map((manager) => manager.shutdown()));
		for (const { id } of sandboxes.splice(0)) await destroyPostgresSandbox(process.env.DATABASE_URL!, id);
	});

	function manager(connectionString = process.env.DATABASE_URL!): SessionManager {
		const owner = new SessionManager({
			tenantConfig: loadTenantConfig({
				TENANT_DATABASES: JSON.stringify(Object.fromEntries(TENANTS.map((tenant) => [tenant, connectionString]))),
			}),
			workerEnabled: true,
			workerOptions: loadWorkerPoolOptions({
				SQL_FS_WORKER_COUNT: "2",
				SQL_FS_WORKER_ACTIVE_TENANT_MAX: "1",
				SQL_FS_WORKER_PG_POOL_MAX: "2",
				SQL_FS_WORKER_MAX_PG_CONNECTIONS: "4",
				SQL_FS_WORKER_QUEUE_WAIT_MS: "5000",
			}),
			maxConcurrentJs: 1,
			maxConcurrentPython: 1,
			defenseInDepth: true,
			defenseAuditMode: false,
		});
		managers.push(owner);
		return owner;
	}

	async function sandbox(owner: SessionManager, tenant: string, runtime?: RuntimeOptions) {
		const id = `worker-resource-${randomUUID()}`;
		const identity = { tenant, id };
		sandboxes.push(identity);
		await owner.withSession(tenant, id, async () => {}, runtime);
		return identity;
	}

	it.each(["javascript", "python"] as const)(
		"preserves the parent-global %s quota across sixteen shared readers from two tenants and workers",
		async (runtime) => {
			const owner = manager();
			await owner.initializeWorkers();
			const options = { javascript: runtime === "javascript", python: runtime === "python", network: false };
			const residents = await Promise.all(TENANTS.map((tenant) => sandbox(owner, tenant, options)));
			const command =
				runtime === "javascript" ? 'sleep .15; node -e "console.log(42)"' : "sleep .15; python3 -c 'print(42)'";
			const intervals: Array<{ start: number; end?: number }> = [];
			const send = WorkerOwnerPool.prototype.send;
			vi.spyOn(WorkerOwnerPool.prototype, "send").mockImplementation(async function <T>(
				this: WorkerOwnerPool,
				command: OwnerCommand,
				signal?: AbortSignal,
				forceReadOnly?: boolean,
			): Promise<T> {
				if (command.kind !== "exec") return send.call(this, command, signal, forceReadOnly) as Promise<T>;
				const interval = { start: performance.now(), end: undefined as number | undefined };
				intervals.push(interval);
				try {
					return (await send.call(this, command, signal, forceReadOnly)) as T;
				} finally {
					interval.end = performance.now();
				}
			});
			const samples: Array<NonNullable<ReturnType<SessionManager["getWorkerMetrics"]>>> = [];
			const timer = setInterval(() => samples.push(owner.getWorkerMetrics()!), 5);
			timers.push(timer);
			const operations = residents.flatMap(({ tenant, id }) =>
				Array.from({ length: 8 }, () =>
					workerRequestContext.run({ bytes: Buffer.byteLength(command) }, () =>
						owner.withSessionRead(tenant, id, (session) => owner.execWithRuntimeThrottle(session, command)),
					),
				),
			);
			const results = await Promise.all(operations);
			clearInterval(timer);
			expect(results).toHaveLength(16);
			for (const result of results) expect(result).toMatchObject({ exitCode: 0, stdout: "42\n" });
			const endpoints = intervals
				.flatMap(({ start, end }) => {
					expect(end).toBeTypeOf("number");
					return [
						{ at: start, change: 1 },
						{ at: end!, change: -1 },
					];
				})
				.sort((left, right) => left.at - right.at || left.change - right.change);
			let concurrent = 0;
			let measuredPeak = 0;
			for (const { change } of endpoints) {
				concurrent += change;
				measuredPeak = Math.max(measuredPeak, concurrent);
			}
			expect(intervals).toHaveLength(16);
			expect(measuredPeak).toBe(1);
			const active = runtime === "javascript" ? "javascriptActive" : "pythonActive";
			const queued = runtime === "javascript" ? "javascriptQueued" : "pythonQueued";
			expect(Math.max(...samples.map((sample) => sample[active]))).toBe(1);
			expect(Math.max(...samples.map((sample) => sample[queued]))).toBe(1);
			expect(
				samples.some((sample) => sample.busyWorkers === 2 && sample.residentSessions === 2 && sample.queued === 14),
			).toBe(true);
			expect(owner.getWorkerMetrics()![active]).toBe(0);
			expect(owner.getWorkerMetrics()![queued]).toBe(0);
			expect(owner.getWorkerMetrics()!.residentSessions).toBeLessThanOrEqual(2);
			console.log(
				JSON.stringify({
					case: "parent-global-runtime-quota",
					runtime,
					sharedRequests: 16,
					tenants: TENANTS.length,
					workerCount: 2,
					measuredPeak,
					observedQueued: Math.max(...samples.map((sample) => sample[queued])),
					observedWorkerQueued: Math.max(...samples.map((sample) => sample.queued)),
					intervals,
				}),
			);
		},
		60000,
	);

	it("caps tagged PostgreSQL connections across thirty-two sandbox evictions and closes every owner connection", async () => {
		const applicationName = `issue198-resource-${randomUUID()}`;
		const tagged = new URL(process.env.DATABASE_URL!);
		tagged.searchParams.set("application_name", applicationName);
		const owner = manager(tagged.toString());
		await owner.initializeWorkers();
		const inspector = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
		const samples: number[] = [];
		const connections = async () => {
			const rows =
				await inspector`SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name = ${applicationName}`;
			const count = Number(rows[0]!.count);
			samples.push(count);
			return count;
		};
		let observing = false;
		let observed: Promise<void> = Promise.resolve();
		let samplingError: unknown;
		const sampler = setInterval(() => {
			if (observing) return;
			observing = true;
			observed = connections()
				.then((count) => {
					expect(count).toBeLessThanOrEqual(4);
				})
				.catch((error: unknown) => {
					samplingError ??= error;
				})
				.finally(() => {
					observing = false;
				});
		}, 10);
		timers.push(sampler);
		try {
			for (let pair = 0; pair < 16; pair++) {
				await Promise.all(
					TENANTS.map(async (tenant) => {
						const { id } = await sandbox(owner, tenant);
						await owner.withSession(tenant, id, async (session) => {
							await session.fs.writeFile("/retained.txt", id);
							await new Promise((resolve) => setTimeout(resolve, 10));
						});
					}),
				);
				expect(owner.getWorkerMetrics()!.residentSessions).toBe(2);
				expect(await connections()).toBeLessThanOrEqual(4);
			}
			for (const { tenant, id } of sandboxes) {
				await owner.withSession(tenant, id, async (session) =>
					expect(await session.fs.readFile("/retained.txt")).toBe(id),
				);
				expect(await connections()).toBeLessThanOrEqual(4);
			}
			expect(Math.max(...samples)).toBeGreaterThanOrEqual(2);
			await owner.shutdown();
			await until(async () => (await connections()) === 0);
			expect(await connections()).toBe(0);
			await observed;
			expect(samplingError).toBeUndefined();
			console.log(
				JSON.stringify({
					case: "worker-owned-postgres-connections",
					sandboxes: 32,
					tenants: TENANTS.length,
					workerCount: 2,
					perWorkerPool: 2,
					observedPeak: Math.max(...samples),
					afterShutdown: 0,
				}),
			);
		} finally {
			clearInterval(sampler);
			await observed;
			await inspector.end({ timeout: 5 });
		}
	}, 60000);
});

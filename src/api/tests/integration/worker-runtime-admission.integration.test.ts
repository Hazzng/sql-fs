import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { requireMigratedSchema } from "../../../sql-fs/tests/integration/helpers/schema-preconditions.js";
import { type RuntimeOptions, SessionManager } from "../../session-manager.js";
import { loadTenantConfig } from "../../tenants.js";
import { WorkerOwnerPool, loadWorkerPoolOptions } from "../../worker-owner/pool.js";
import type { OwnerCommand } from "../../worker-owner/protocol.js";

const TENANTS = ["worker-runtime-a", "worker-runtime-b"] as const;

async function until(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 5000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Runtime admission checkpoint was not reached");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe.skipIf(!process.env.DATABASE_URL)("worker runtime admission for dynamic commands", () => {
	let manager: SessionManager | undefined;
	const sandboxes: Array<{ tenant: string; id: string }> = [];

	beforeAll(async () => {
		await requireMigratedSchema(process.env.DATABASE_URL ?? "");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		try {
			for (const { tenant, id } of sandboxes.splice(0)) await manager?.destroy(tenant, id);
		} finally {
			await manager?.shutdown();
		}
	});

	function makeManager(): SessionManager {
		manager = new SessionManager({
			tenantConfig: loadTenantConfig({
				TENANT_DATABASES: JSON.stringify(
					Object.fromEntries(TENANTS.map((tenant) => [tenant, process.env.DATABASE_URL])),
				),
			}),
			workerEnabled: true,
			workerOptions: loadWorkerPoolOptions({
				SQL_FS_WORKER_COUNT: "2",
				SQL_FS_WORKER_ACTIVE_TENANT_MAX: "1",
				SQL_FS_WORKER_QUEUE_WAIT_MS: "30000",
			}),
			maxConcurrentPython: 1,
			maxConcurrentJs: 1,
			defenseInDepth: true,
			defenseAuditMode: false,
		});
		return manager;
	}

	async function create(owner: SessionManager, tenant: string, runtime: RuntimeOptions, command = ""): Promise<string> {
		const id = `worker-runtime-${randomUUID()}`;
		sandboxes.push({ tenant, id });
		await owner.withSession(
			tenant,
			id,
			async (session) => {
				if (command) await session.fs.writeFile("/home/user/runtime", command);
			},
			runtime,
		);
		return id;
	}

	it.each([
		{ runner: "python3", invocation: "variable", guest: "print(42)", args: "-c", runtime: "python" },
		{ runner: "js-exec", invocation: "variable", guest: "console.log(42)", args: "-c", runtime: "javascript" },
		{ runner: "node", invocation: "variable", guest: "console.log(42)", args: "-e", runtime: "javascript" },
		{ runner: "python3", invocation: "source", guest: "print(42)", args: "-c", runtime: "python" },
		{ runner: "js-exec", invocation: "source", guest: "console.log(42)", args: "-c", runtime: "javascript" },
	] as const)(
		"bounds sixteen $invocation $runner executions across two tenants and residents",
		async (testCase) => {
			const owner = makeManager();
			const runtime = {
				python: testCase.runtime === "python",
				javascript: testCase.runtime === "javascript",
				network: false,
			};
			const sourced = `${testCase.runner} ${testCase.args} '${testCase.guest}'`;
			const ids = await Promise.all(TENANTS.map((tenant) => create(owner, tenant, runtime, sourced)));
			const script =
				testCase.invocation === "source"
					? 'sleep "$DELAY"; . /home/user/runtime'
					: `sleep "$DELAY"; "$RUNNER" ${testCase.args} '${testCase.guest}'`;
			const send = WorkerOwnerPool.prototype.send;
			let activeRpc = 0;
			let peakRpc = 0;
			let dispatched = 0;
			vi.spyOn(WorkerOwnerPool.prototype, "send").mockImplementation(async function <T>(
				this: WorkerOwnerPool,
				command: OwnerCommand,
				signal?: AbortSignal,
				forceReadOnly?: boolean,
			): Promise<T> {
				if (command.kind !== "exec") return send.call(this, command, signal, forceReadOnly) as Promise<T>;
				dispatched++;
				activeRpc++;
				peakRpc = Math.max(peakRpc, activeRpc);
				try {
					return (await send.call(this, command, signal, forceReadOnly)) as T;
				} finally {
					activeRpc--;
				}
			});
			const active = testCase.runtime === "python" ? "pythonActive" : "javascriptActive";
			const queued = testCase.runtime === "python" ? "pythonQueued" : "javascriptQueued";
			const operations = ids.flatMap((id, sandboxIndex) =>
				Array.from({ length: 8 }, (_, index) =>
					owner.withSessionRead(TENANTS[sandboxIndex]!, id, (session) =>
						owner.execWithRuntimeThrottle(session, script, {
							env: { RUNNER: testCase.runner, DELAY: sandboxIndex === 0 && index === 0 ? "0.5" : "0.01" },
						}),
					),
				),
			);
			const settled = Promise.all(operations);
			await until(() => (owner.getWorkerMetrics()?.[queued] ?? 0) === 1 || dispatched > 1);
			const metrics = owner.getWorkerMetrics();
			const results = await settled;
			console.log(
				JSON.stringify({
					case: "dynamic-runtime-quota",
					...testCase,
					requests: 16,
					tenants: TENANTS.length,
					peakRpc,
					observedQueued: metrics?.[queued],
					observedWorkerQueued: metrics?.queued,
				}),
			);
			expect(metrics?.[active]).toBe(1);
			expect(metrics?.[queued]).toBe(1);
			expect(metrics?.queued).toBe(14);
			expect(metrics?.active).toBe(2);
			expect(metrics?.busyWorkers).toBe(2);
			expect(metrics?.residentSessions).toBe(2);
			for (const result of results) expect(result).toMatchObject({ exitCode: 0, stdout: "42\n" });
			expect(dispatched).toBe(16);
			expect(peakRpc).toBe(1);
			expect(owner.getWorkerMetrics()?.[active]).toBe(0);
			expect(owner.getWorkerMetrics()?.[queued]).toBe(0);
		},
		60000,
	);

	it("releases both enabled quotas after queued cancellation and a rejected execution", async () => {
		const owner = makeManager();
		const runtime = { python: true, javascript: true, network: false };
		const [firstId, secondId] = await Promise.all(TENANTS.map((tenant) => create(owner, tenant, runtime)));
		const first = owner.withSessionRead(TENANTS[0], firstId!, (session) =>
			owner.execWithRuntimeThrottle(session, "sleep 2; echo first"),
		);
		await until(() => owner.getWorkerMetrics()?.pythonActive === 1 && owner.getWorkerMetrics()?.javascriptActive === 1);
		const controller = new AbortController();
		const cancelled = owner.withSessionRead(TENANTS[1], secondId!, (session) =>
			owner.execWithRuntimeThrottle(session, "echo cancelled", { signal: controller.signal }),
		);
		const rejection = expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
		await until(() => owner.getWorkerMetrics()?.pythonQueued === 1);
		expect(owner.getWorkerMetrics()).toMatchObject({ active: 2, queued: 0, busyWorkers: 2 });
		controller.abort();
		await rejection;
		expect(owner.getWorkerMetrics()).toMatchObject({
			active: 1,
			queued: 0,
			busyWorkers: 1,
			pythonQueued: 0,
			javascriptQueued: 0,
		});
		expect(await first).toMatchObject({ exitCode: 0, stdout: "first\n" });
		await expect(
			owner.withSessionRead(TENANTS[1], secondId!, (session) =>
				owner.execWithRuntimeThrottle(session, "echo rejected > /home/user/rejected"),
			),
		).rejects.toMatchObject({ code: "EREADONLY_VIOLATION" });
		expect(
			await owner.withSessionRead(TENANTS[1], secondId!, (session) =>
				owner.execWithRuntimeThrottle(session, "echo healthy"),
			),
		).toMatchObject({ exitCode: 0, stdout: "healthy\n" });
		expect(owner.getWorkerMetrics()).toMatchObject({
			active: 0,
			queued: 0,
			pythonActive: 0,
			pythonQueued: 0,
			javascriptActive: 0,
			javascriptQueued: 0,
		});
	});
});

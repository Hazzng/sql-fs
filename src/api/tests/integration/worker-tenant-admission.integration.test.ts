import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { requireMigratedSchema } from "../../../sql-fs/tests/integration/helpers/schema-preconditions.js";
import { SessionManager } from "../../session-manager.js";
import { loadTenantConfig } from "../../tenants.js";
import { loadWorkerPoolOptions } from "../../worker-owner/pool.js";

function checkpoint() {
	let resolve = () => {};
	const reached = new Promise<void>((done) => {
		resolve = done;
	});
	return { reached, resolve };
}

describe.skipIf(!process.env.DATABASE_URL)("active tenant isolation with two PostgreSQL workers", () => {
	let manager: SessionManager | undefined;
	const sandboxes: Array<{ tenant: string; id: string }> = [];

	beforeAll(async () => {
		await requireMigratedSchema(process.env.DATABASE_URL ?? "");
	});

	afterEach(async () => {
		try {
			for (const { tenant, id } of sandboxes.splice(0)) await manager?.destroy(tenant, id);
		} finally {
			await manager?.shutdown();
		}
	});

	it.each([
		{ sandbox: "same", outcome: "success" },
		{ sandbox: "other", outcome: "success" },
		{ sandbox: "same", outcome: "failure" },
		{ sandbox: "other", outcome: "cancellation" },
	])("lets tenant B finish while tenant A's $sandbox sandbox waits, then recovers after $outcome", async (testCase) => {
		const tenantA = `quota-a-${randomUUID()}`;
		const tenantB = `quota-b-${randomUUID()}`;
		const options = { ...loadWorkerPoolOptions({}), waitMs: 5000 };
		const owner = new SessionManager({
			tenantConfig: loadTenantConfig({
				TENANT_DATABASES: JSON.stringify({
					[tenantA]: process.env.DATABASE_URL,
					[tenantB]: process.env.DATABASE_URL,
				}),
			}),
			workerEnabled: true,
			workerOptions: options,
			defenseInDepth: true,
			defenseAuditMode: false,
		});
		manager = owner;
		await owner.initializeWorkers();
		const create = async (tenant: string) => {
			const id = `worker-tenant-${randomUUID()}`;
			sandboxes.push({ tenant, id });
			await owner.withSession(tenant, id, (session) => session.fs.writeFile("/home/user/tenant", tenant));
			return id;
		};
		const a = await create(tenantA);
		const nextA = testCase.sandbox === "same" ? a : await create(tenantA);
		const b = await create(tenantB);
		const started = checkpoint();
		const finish = checkpoint();
		const controller = new AbortController();
		const active = owner.withSessionRead(tenantA, a, async (session) => {
			expect(await session.fs.readFile("/home/user/tenant")).toBe(tenantA);
			started.resolve();
			await finish.reached;
			if (testCase.outcome === "failure") throw Object.assign(new Error("rejected read"), { code: "EINVAL" });
			if (testCase.outcome === "cancellation") {
				controller.abort();
				await owner.execWithRuntimeThrottle(session, "echo unreachable", { signal: controller.signal });
			}
		});
		const activeOutcome = active.then(
			() => ({ code: undefined }),
			(error: { code?: string }) => error,
		);
		await started.reached;
		const callback = vi.fn(async () => "a-finished");
		const waiting = owner.withSessionRead(tenantA, nextA, async (session) => {
			expect(await session.fs.stat("/home/user/tenant")).toMatchObject({ isFile: true });
			return callback();
		});
		const settled = Promise.allSettled([active, waiting]);
		try {
			await vi.waitFor(() => expect(owner.getWorkerMetrics()?.queued).toBe(1));
			expect(callback).not.toHaveBeenCalled();
			await owner.withSession(tenantB, b, async (session) => {
				expect(owner.getWorkerMetrics()).toMatchObject({ active: 2, busyWorkers: 2, queued: 1 });
				expect(
					await owner.execWithRuntimeThrottle(session, "echo b-finished > /home/user/result; cat /home/user/result"),
				).toMatchObject({ exitCode: 0, stdout: "b-finished\n" });
			});
			expect(callback).not.toHaveBeenCalled();
			expect(owner.getWorkerMetrics()).toMatchObject({ active: 1, queued: 1, busyWorkers: 1 });
			finish.resolve();
			expect(await activeOutcome).toMatchObject({
				code: testCase.outcome === "failure" ? "EINVAL" : testCase.outcome === "cancellation" ? "ABORTED" : undefined,
			});
			await expect(waiting).resolves.toBe("a-finished");
			expect(callback).toHaveBeenCalledOnce();
			const metrics = owner.getWorkerMetrics();
			expect(metrics).toMatchObject({ active: 0, queued: 0, queuedBytes: 0, busyWorkers: 0, readyWorkers: 2 });
			expect(metrics?.completed).toBe(metrics?.admitted);
			console.log(
				JSON.stringify({
					case: "active-tenant-isolation",
					...testCase,
					workers: options.count,
					tenantMax: options.maxActivePerTenant,
					otherTenantFinishedBeforeRelease: true,
					admitted: metrics?.admitted,
					completed: metrics?.completed,
				}),
			);
		} finally {
			finish.resolve();
			await settled;
		}
	});
});

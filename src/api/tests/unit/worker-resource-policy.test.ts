import { InMemoryFs } from "just-bash";
import { describe, expect, it } from "vitest";
import { createSessionRuntime } from "../../session-runtime/engine.js";
import { WorkerOwnerPool, loadWorkerPoolOptions } from "../../worker-owner/pool.js";

describe("worker resource policy", () => {
	it.each([0, 23])("preserves an explicit invalid %i byte Python bridge cap", async (maxPythonBridgeBytes) => {
		const runtime = createSessionRuntime(
			new InMemoryFs(),
			{
				tenantId: "default",
				sandboxId: "invalid-python-bridge",
				runtimeOptions: { python: true, javascript: false, network: false },
			},
			{
				defenseInDepth: false,
				defenseAuditMode: false,
				execFileLimitBytes: 1024,
				executionLimits: { maxPythonBridgeBytes },
			},
		);
		expect(await runtime.bash.exec("python3 -c 'print(1)'")).toMatchObject({
			exitCode: 1,
			stdout: "",
			stderr: "python3: worker bridge requires an integer maxPythonBridgeBytes >= 24\n",
		});
	});
	it.each([undefined, 0, Number.NaN, Number.POSITIVE_INFINITY])(
		"refuses an uncapped owner without a usable aggregate input budget (%s)",
		(maxInputBytes) => {
			expect(() =>
				createSessionRuntime(
					new InMemoryFs(),
					{
						tenantId: "default",
						sandboxId: "invalid-budget",
						runtimeOptions: { python: false, javascript: false, network: false },
					},
					{
						defenseInDepth: false,
						defenseAuditMode: false,
						execFileLimitBytes: null,
						executionLimits: { maxInputBytes },
					},
				),
			).toThrow("aggregate input budget");
		},
	);

	it("budgets fixed workers, database connections, shell memory and transaction metadata", () => {
		const options = loadWorkerPoolOptions({});
		expect(options).toMatchObject({ count: 2, maxActivePerTenant: 1, heapMb: 512, pgPoolMax: 2, maxPgConnections: 4 });
		expect(options.execFileLimitBytes).toBe(8 * 1024 * 1024);
		expect(options.executionLimits).toMatchObject({
			maxStringLength: 64 * 1024 * 1024,
			maxInputBytes: 128 * 1024 * 1024,
			maxOutputSize: 64 * 1024 * 1024,
			maxLiveBytes: 128 * 1024 * 1024,
			maxPythonBridgeBytes: 64 * 1024 * 1024,
		});
		expect(options.scriptTxBuffer).toEqual({ enabled: true, maxOps: 50_000, maxBytes: 32 * 1024 * 1024 });
		expect(options).toMatchObject({ maxQueuedBytes: 64 * 1024 * 1024, maxQueuedBytesPerTenant: 32 * 1024 * 1024 });
	});

	it("rejects pool configurations that exceed the database connection allowance", () => {
		expect(() => loadWorkerPoolOptions({ SQL_FS_WORKER_COUNT: "3" })).toThrow("PG pool size");
	});

	it("honors an explicit deployment file limit on worker execution", () => {
		expect(loadWorkerPoolOptions({ MAX_EXEC_FILE_BYTES: "1024" }).execFileLimitBytes).toBe(1024);
		expect(loadWorkerPoolOptions({ MAX_EXEC_FILE_BYTES: "1.9" }).execFileLimitBytes).toBe(1);
	});

	it.each(["", "0", "-1", "NaN", "Infinity"])(
		"preserves the protective fallback for explicit invalid file cap %s",
		(value) => {
			expect(loadWorkerPoolOptions({ MAX_EXEC_FILE_BYTES: value }).execFileLimitBytes).toBe(8 * 1024 * 1024);
		},
	);

	it("requires RSS headroom beyond every worker's permitted heap", () => {
		expect(() => loadWorkerPoolOptions({ SQL_FS_WORKER_HEAP_MB: "768" })).toThrow("RSS headroom");
	});

	it.each(["0", "-1", "1.5", "NaN", "Infinity"])("rejects invalid queue sizing %s", (value) => {
		expect(() => loadWorkerPoolOptions({ SQL_FS_WORKER_QUEUE_MAX: value })).toThrow("positive integer");
	});

	it.each([
		{ total: 1, expected: 1 },
		{ total: 2, expected: 1 },
		{ total: 8, expected: 4 },
		{ total: 32, expected: 8 },
	])("defaults a $total request queue to $expected queued requests per tenant", ({ total, expected }) => {
		expect(loadWorkerPoolOptions({ SQL_FS_WORKER_QUEUE_MAX: String(total) }).maxQueuedPerTenant).toBe(expected);
	});

	it.each([
		{ total: 1, limit: 2 },
		{ total: 2, limit: 2 },
		{ total: 8, limit: 8 },
		{ total: 32, limit: 32 },
		{ total: 8, limit: 9 },
	])("rejects tenant $limit requests that exhaust the global $total request queue", ({ total, limit }) => {
		expect(() =>
			loadWorkerPoolOptions({
				SQL_FS_WORKER_QUEUE_MAX: String(total),
				SQL_FS_WORKER_QUEUE_TENANT_MAX: String(limit),
			}),
		).toThrow("leave queue capacity for other tenants");
	});

	it("accepts an explicit request quota below the global queue limit", () => {
		expect(
			loadWorkerPoolOptions({ SQL_FS_WORKER_QUEUE_MAX: "8", SQL_FS_WORKER_QUEUE_TENANT_MAX: "7" }).maxQueuedPerTenant,
		).toBe(7);
	});

	it("validates tenant counts after programmatic global queue overrides", () => {
		expect(() => new WorkerOwnerPool({ ...loadWorkerPoolOptions({}), maxQueued: 2 })).toThrow(
			"leave queue capacity for other tenants",
		);
	});

	it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
		"rejects an invalid programmatic tenant queue count %s",
		(maxQueuedPerTenant) => {
			expect(() => new WorkerOwnerPool({ ...loadWorkerPoolOptions({}), maxQueuedPerTenant })).toThrow(
				"positive integer",
			);
		},
	);

	it.each([
		{ count: 1, expected: 1 },
		{ count: 2, expected: 1 },
		{ count: 3, expected: 1 },
		{ count: 4, expected: 2 },
		{ count: 5, expected: 2 },
	])("defaults $count workers to $expected active operations per tenant", ({ count, expected }) => {
		const options = loadWorkerPoolOptions({
			SQL_FS_WORKER_COUNT: String(count),
			SQL_FS_WORKER_HEAP_MB: "64",
			SQL_FS_WORKER_PG_POOL_MAX: "1",
			SQL_FS_WORKER_MAX_PG_CONNECTIONS: "5",
		});
		expect(options.maxActivePerTenant).toBe(expected);
	});

	it.each(["", "0", "-1", "1.5", "NaN", "Infinity", "9007199254740992"])(
		"rejects invalid active tenant quota %s",
		(value) => {
			expect(() => loadWorkerPoolOptions({ SQL_FS_WORKER_ACTIVE_TENANT_MAX: value })).toThrow("positive integer");
		},
	);

	it.each([1, 2, 3, 4])("rejects a tenant quota that consumes a pool of %s workers", (count) => {
		expect(() =>
			loadWorkerPoolOptions({
				SQL_FS_WORKER_COUNT: String(count),
				SQL_FS_WORKER_ACTIVE_TENANT_MAX: String(Math.max(2, count)),
			}),
		).toThrow("leave a worker for other tenants");
	});

	it("accepts an explicit larger tenant quota while retaining spare worker capacity", () => {
		expect(
			loadWorkerPoolOptions({
				SQL_FS_WORKER_COUNT: "3",
				SQL_FS_WORKER_ACTIVE_TENANT_MAX: "2",
				SQL_FS_WORKER_HEAP_MB: "256",
				SQL_FS_WORKER_MAX_PG_CONNECTIONS: "6",
			}).maxActivePerTenant,
		).toBe(2);
	});

	it.each([
		{ total: 1, expected: 1 },
		{ total: 2, expected: 1 },
		{ total: 3, expected: 1 },
		{ total: 100, expected: 50 },
	])("defaults $total queue bytes to $expected queued bytes per tenant", ({ total, expected }) => {
		expect(loadWorkerPoolOptions({ SQL_FS_WORKER_QUEUE_BYTES: String(total) }).maxQueuedBytesPerTenant).toBe(expected);
	});

	it.each(["", "0", "-1", "1.5", "NaN", "Infinity", "9007199254740992"])(
		"rejects invalid queued tenant byte quota %s",
		(value) => {
			expect(() => loadWorkerPoolOptions({ SQL_FS_WORKER_QUEUE_TENANT_BYTES: value })).toThrow("positive integer");
		},
	);

	it.each([
		{ total: 1, limit: 2 },
		{ total: 2, limit: 2 },
		{ total: 100, limit: 100 },
		{ total: 100, limit: 101 },
	])("rejects tenant $limit bytes that exhaust the global $total byte queue", ({ total, limit }) => {
		expect(() =>
			loadWorkerPoolOptions({
				SQL_FS_WORKER_QUEUE_BYTES: String(total),
				SQL_FS_WORKER_QUEUE_TENANT_BYTES: String(limit),
			}),
		).toThrow("leave queue bytes for other tenants");
	});

	it("accepts an explicit byte quota below the global queue limit", () => {
		expect(
			loadWorkerPoolOptions({ SQL_FS_WORKER_QUEUE_BYTES: "100", SQL_FS_WORKER_QUEUE_TENANT_BYTES: "99" })
				.maxQueuedBytesPerTenant,
		).toBe(99);
	});

	it("validates tenant bytes after programmatic global queue overrides", () => {
		expect(() => new WorkerOwnerPool({ ...loadWorkerPoolOptions({}), maxQueuedBytes: 100 })).toThrow(
			"leave queue bytes for other tenants",
		);
	});
});

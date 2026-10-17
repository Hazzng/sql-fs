import { InMemoryFs } from "just-bash";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionRuntime } from "../../session-runtime/engine.js";
import { budgetWorkerReply } from "../../worker-owner/message-budget.js";
import { loadWorkerPoolOptions, WorkerOwnerPool } from "../../worker-owner/pool.js";
import type { OwnerReply } from "../../worker-owner/protocol.js";

const cpuProbe = vi.hoisted(() => ({
	membership: undefined as string | null | undefined,
	quota: undefined as string | undefined,
	parallelism: undefined as number | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		readFileSync: (path: string, options?: unknown) => {
			if (path === "/proc/self/cgroup" && cpuProbe.membership === null) throw new Error("cgroup unavailable");
			if (path === "/proc/self/cgroup" && cpuProbe.membership !== undefined) return cpuProbe.membership;
			if (path === "/sys/fs/cgroup/cpu.max" && cpuProbe.quota !== undefined) return cpuProbe.quota;
			return (actual.readFileSync as (path: string, options?: unknown) => unknown)(path, options);
		},
	};
});

vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	return { ...actual, availableParallelism: () => cpuProbe.parallelism ?? actual.availableParallelism() };
});

afterEach(() => {
	vi.restoreAllMocks();
	cpuProbe.membership = undefined;
	cpuProbe.quota = undefined;
	cpuProbe.parallelism = undefined;
});

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

	it.each([
		[{}, 64],
		[{ SQL_FS_WORKER_OUTPUT_BYTES: String(96 * 1024 * 1024) }, 96],
	])("fits maximum stdout and an ordinary reply envelope into the default message budget (%j)", (env, outputMib) => {
		const options = loadWorkerPoolOptions(env);
		const outputBytes = options.executionLimits.maxOutputSize ?? 0;
		const messageBytes = options.executionLimits.maxWorkerMessageBytes ?? 0;
		expect(outputBytes).toBe(outputMib * 1024 * 1024);
		expect(messageBytes).toBe((outputMib + 1) * 1024 * 1024);
		const reply = {
			id: 1,
			generation: 1,
			metadata: {
				owner: "owner",
				createdAt: "2026-10-12T00:00:00.000Z",
				cwd: "/home/user",
				dirty: false,
				poisoned: false,
				pathCacheBytes: 0,
			},
			readOnlyViolated: false,
			memory: { heapUsed: 1, external: 1, rss: 1 },
			ok: true,
			value: { stdout: "x".repeat(outputBytes), stderr: "", exitCode: 0, env: { PWD: "/home/user" } },
		} satisfies OwnerReply;
		expect(budgetWorkerReply(reply, { kind: "exec", script: "printf", options: {} }, messageBytes)).toBe(reply);
	});

	it("keeps the 65 MiB command budget when the output cap is lowered", () => {
		expect(
			loadWorkerPoolOptions({ SQL_FS_WORKER_OUTPUT_BYTES: String(8 * 1024 * 1024) }).executionLimits
				.maxWorkerMessageBytes,
		).toBe(65 * 1024 * 1024);
	});

	it("rejects a worker queue wait that Node's timer would cut to 1 ms", () => {
		expect(() => loadWorkerPoolOptions({ SQL_FS_WORKER_QUEUE_WAIT_MS: "2147483648" })).toThrow(
			"SQL_FS_WORKER_QUEUE_WAIT_MS must be at most 2147483647",
		);
	});

	it("keeps an explicit SQL_FS_WORKER_MESSAGE_BYTES over the output-derived default", () => {
		expect(loadWorkerPoolOptions({ SQL_FS_WORKER_MESSAGE_BYTES: "4096" }).executionLimits.maxWorkerMessageBytes).toBe(
			4096,
		);
	});

	const largeFileEnv = {
		SQL_FS_WORKER_LARGE_FILES: "true",
		SQL_FS_WORKER_MAX_RSS_BYTES: "2415919104",
		SQL_FS_WORKER_MAX_EXTERNAL_BYTES: "1073741824",
	};
	const largeFileResources = { cpus: 2, memoryBytes: 3 * 1024 ** 3 };

	it.each([
		{ membership: "0::/\n", quota: "400000 100000", accepted: true },
		{ membership: "0::/", quota: "400000 100000", accepted: true },
		{ membership: "0::/\n", quota: "100000 100000", accepted: false },
		{ membership: "0::/\n", quota: "50000 100000", accepted: false },
		{ membership: "0::/docker/limited\n", quota: "400000 100000", accepted: false },
		{ membership: "0::/\n0::/docker/limited\n", quota: "400000 100000", accepted: false },
		{ membership: "0::/docker/limited\n0::/\n", quota: "400000 100000", accepted: false },
		{ membership: "0::/\n\n", quota: "400000 100000", accepted: false },
		{ membership: "", quota: "400000 100000", accepted: false },
		{ membership: null, quota: "400000 100000", accepted: false },
		{ membership: "0::/\r\n", quota: "400000 100000", accepted: false },
		{ membership: "1:cpu:/\n", quota: "400000 100000", accepted: false },
	])("only trusts the private root cgroup and its quota: $membership / $quota", ({ membership, quota, accepted }) => {
		cpuProbe.membership = membership;
		cpuProbe.quota = quota;
		cpuProbe.parallelism = 4;
		vi.spyOn(process, "constrainedMemory").mockReturnValue(3 * 1024 ** 3);
		if (accepted) expect(loadWorkerPoolOptions(largeFileEnv).execFileLimitBytes).toBeNull();
		else {
			expect(() => loadWorkerPoolOptions(largeFileEnv)).toThrow("at least 2 CPUs");
			expect(loadWorkerPoolOptions({ ...largeFileEnv, MAX_EXEC_FILE_BYTES: "1024" }).execFileLimitBytes).toBe(1024);
			expect(loadWorkerPoolOptions({}).execFileLimitBytes).toBe(8 * 1024 * 1024);
		}
	});

	it("removes the file cap only after an explicit large-file profile opt-in", () => {
		expect(loadWorkerPoolOptions(largeFileEnv, largeFileResources).execFileLimitBytes).toBeNull();
		expect(
			loadWorkerPoolOptions({ ...largeFileEnv, SQL_FS_WORKER_LARGE_FILES: "false" }, largeFileResources)
				.execFileLimitBytes,
		).toBe(8 * 1024 * 1024);
	});

	it.each(["", "1", "TRUE", "yes"])("rejects an invalid large-file opt-in %s", (value) => {
		expect(() => loadWorkerPoolOptions({ SQL_FS_WORKER_LARGE_FILES: value })).toThrow(
			"SQL_FS_WORKER_LARGE_FILES must be true or false",
		);
	});

	it.each([
		{ cpus: 0.5, memoryBytes: 3 * 1024 ** 3 },
		{ cpus: 1, memoryBytes: 3 * 1024 ** 3 },
		{ cpus: 2, memoryBytes: 2 * 1024 ** 3 },
		{ cpus: 2, memoryBytes: 0 },
		{ cpus: Number.NaN, memoryBytes: 3 * 1024 ** 3 },
	])("rejects an uncapped profile with $cpus CPUs and $memoryBytes memory bytes", (resources) => {
		expect(() => loadWorkerPoolOptions(largeFileEnv, resources)).toThrow("at least 2 CPUs and a 3 GiB memory limit");
	});

	it.each([
		{ SQL_FS_WORKER_MAX_RSS_BYTES: "1610612736" },
		{ SQL_FS_WORKER_MAX_EXTERNAL_BYTES: "536870912" },
		{ SQL_FS_WORKER_MAX_RSS_BYTES: "3221225472" },
	])("rejects unmeasured memory thresholds %j", (override) => {
		expect(() => loadWorkerPoolOptions({ ...largeFileEnv, ...override }, largeFileResources)).toThrow(
			"large-file memory thresholds",
		);
	});

	it("preserves operator caps on an opted-in constrained container", () => {
		for (const cap of ["1024", "", "0", "NaN"]) {
			expect(
				loadWorkerPoolOptions(
					{ SQL_FS_WORKER_LARGE_FILES: "true", MAX_EXEC_FILE_BYTES: cap },
					{ cpus: 1, memoryBytes: 2 * 1024 ** 3 },
				).execFileLimitBytes,
			).toBe(cap === "1024" ? 1024 : 8 * 1024 * 1024);
		}
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

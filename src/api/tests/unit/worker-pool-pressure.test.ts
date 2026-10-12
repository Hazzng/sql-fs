import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkerOwnerPool, loadWorkerPoolOptions, workerReservation } from "../../worker-owner/pool.js";

function checkpoint() {
	let release = () => {};
	const reached = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { reached, release };
}

describe("worker pool memory pressure", () => {
	afterEach(() => vi.restoreAllMocks());

	it.each(["rss", "external"] as const)(
		"rejects another shared reader under %s pressure and admits it after recovery",
		async (pressure) => {
			const options = loadWorkerPoolOptions({
				SQL_FS_WORKER_COUNT: "3",
				SQL_FS_WORKER_ACTIVE_TENANT_MAX: "2",
				SQL_FS_WORKER_HEAP_MB: "256",
				SQL_FS_WORKER_MAX_PG_CONNECTIONS: "6",
				SQL_FS_WORKER_QUEUE_WAIT_MS: "20",
			});
			const pool = new WorkerOwnerPool(options);
			const memory = process.memoryUsage();
			let rss = memory.rss;
			vi.spyOn(process, "memoryUsage").mockImplementation(() => ({ ...memory, rss }));
			const started = checkpoint();
			const finish = checkpoint();
			let reportExternal = (_bytes: number) => {};
			const active = pool.run("tenant", "sandbox", true, async () => {
				const reservation = workerReservation.getStore();
				if (reservation === undefined) throw new Error("Reader was not reserved");
				reportExternal = (bytes) => {
					reservation.slot.external = bytes;
				};
				if (pressure === "rss") rss = options.maxRssBytes;
				else reportExternal(options.maxExternalBytes);
				started.release();
				await finish.reached;
			});
			await started.reached;
			try {
				const rejected = vi.fn(async () => "rejected reader ran");
				await expect(pool.run("tenant", "sandbox", true, rejected)).rejects.toMatchObject({
					code: "EWORKER_BUSY",
				});
				expect(rejected).not.toHaveBeenCalled();
				expect(pool.metrics).toMatchObject({ active: 1, admitted: 1, refused: 1, queued: 0, busyWorkers: 1 });
				rss = memory.rss;
				reportExternal(0);
				const recovered = vi.fn(async () => "healthy reader");
				await expect(pool.run("tenant", "sandbox", true, recovered)).resolves.toBe("healthy reader");
				expect(recovered).toHaveBeenCalledOnce();
				expect(pool.metrics).toMatchObject({ active: 1, admitted: 2, queued: 0, completed: 1 });
			} finally {
				rss = memory.rss;
				reportExternal(0);
				finish.release();
				await active;
				await pool.shutdown(0);
			}
			expect(pool.metrics).toMatchObject({ active: 0, queued: 0, completed: 2 });
		},
	);

	it("keeps shared and other-tenant work queued under pressure and drains both after recovery", async () => {
		const options = { ...loadWorkerPoolOptions({}), waitMs: 1000 };
		const pool = new WorkerOwnerPool(options);
		const memory = process.memoryUsage();
		let rss = memory.rss;
		vi.spyOn(process, "memoryUsage").mockImplementation(() => ({ ...memory, rss }));
		const started = checkpoint();
		const finish = checkpoint();
		const active = pool.run("a", "shared", true, async () => {
			rss = options.maxRssBytes;
			started.release();
			await finish.reached;
		});
		await started.reached;
		const order: string[] = [];
		const shared = pool.run("a", "shared", true, async () => {
			order.push("a");
		});
		const other = pool.run("b", "other", false, async () => {
			order.push("b");
		});
		const pending = Promise.allSettled([shared, other]);
		try {
			await vi.waitFor(() => expect(pool.metrics.queued).toBe(2));
			expect(order).toEqual([]);
			expect(pool.metrics).toMatchObject({ active: 1, admitted: 1, runnableQueued: 1, sandboxWaiting: 1 });
			rss = memory.rss;
			finish.release();
			await active;
			expect(await pending).toEqual([
				{ status: "fulfilled", value: undefined },
				{ status: "fulfilled", value: undefined },
			]);
			expect(order).toEqual(["a", "b"]);
			expect(pool.metrics).toMatchObject({ active: 0, queued: 0, queuedBytes: 0, admitted: 3, completed: 3 });
		} finally {
			rss = memory.rss;
			finish.release();
			await active;
			await pending;
			await pool.shutdown(0);
		}
	});
});

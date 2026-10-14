import { InMemoryFs } from "just-bash";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../session-manager.js";
import { FairAdmission } from "../../worker-owner/admission.js";
import { loadWorkerPoolOptions, WorkerOwnerPool } from "../../worker-owner/pool.js";
import { workerRequestContext } from "../../worker-owner/request-context.js";

function checkpoint() {
	let resolve = () => {};
	const reached = new Promise<void>((done) => {
		resolve = done;
	});
	return { reached, resolve };
}

describe("active tenant worker admission", () => {
	afterEach(() => vi.unstubAllEnvs());

	it.each(["same-sandbox", "other-sandbox"])("keeps another tenant runnable while %s work waits", async (sandbox) => {
		const pool = new WorkerOwnerPool({ ...loadWorkerPoolOptions({}), waitMs: 1000 });
		const started = checkpoint();
		const finish = checkpoint();
		const active = pool.run("a", "a-first", true, async () => {
			started.resolve();
			await finish.reached;
		});
		await started.reached;
		const next = vi.fn(async () => "a-next");
		const waiting = pool.run("a", sandbox === "same-sandbox" ? "a-first" : "a-second", true, next);
		const settled = Promise.allSettled([active, waiting]);
		try {
			await vi.waitFor(() => expect(pool.metrics.queued).toBe(1));
			await expect(pool.run("b", "b-first", false, async () => "b-finished")).resolves.toBe("b-finished");
			expect(next).not.toHaveBeenCalled();
			expect(pool.metrics).toMatchObject({ active: 1, queued: 1, busyWorkers: 1, admitted: 2, completed: 1 });
			finish.resolve();
			await active;
			await expect(waiting).resolves.toBe("a-next");
			expect(next).toHaveBeenCalledOnce();
			expect(pool.metrics).toMatchObject({ active: 0, queued: 0, queuedBytes: 0, admitted: 3, completed: 3 });
		} finally {
			finish.resolve();
			await settled;
			await pool.shutdown(0);
		}
	});

	it.each(["EINVAL", "ABORTED", "EEXEC_OUTCOME_UNKNOWN"])(
		"releases the active tenant charge after %s",
		async (code) => {
			const pool = new WorkerOwnerPool({ ...loadWorkerPoolOptions({}), waitMs: 1000 });
			const started = checkpoint();
			const finish = checkpoint();
			const active = pool.run("a", "first", false, async () => {
				started.resolve();
				await finish.reached;
				throw Object.assign(new Error(code), { code });
			});
			const assertion = expect(active).rejects.toMatchObject({ code });
			await started.reached;
			const next = vi.fn(async () => "next");
			const waiting = pool.run("a", "second", false, next);
			const settled = Promise.allSettled([active, waiting]);
			try {
				await vi.waitFor(() => expect(pool.metrics.queued).toBe(1));
				expect(next).not.toHaveBeenCalled();
				finish.resolve();
				await assertion;
				await expect(waiting).resolves.toBe("next");
				expect(pool.metrics).toMatchObject({ active: 0, queued: 0, admitted: 2, completed: 2 });
			} finally {
				finish.resolve();
				await settled;
				await pool.shutdown(0);
			}
		},
	);

	it("cancels quota waiters without changing the active operation's charge", async () => {
		const pool = new WorkerOwnerPool({ ...loadWorkerPoolOptions({}), waitMs: 1000 });
		const started = checkpoint();
		const finish = checkpoint();
		const active = pool.run("a", "first", true, async () => {
			started.resolve();
			await finish.reached;
		});
		await started.reached;
		const controller = new AbortController();
		const callback = vi.fn(async () => {});
		const cancelled = workerRequestContext.run({ bytes: 12, signal: controller.signal }, () =>
			pool.run("a", "first", true, callback),
		);
		const assertion = expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
		try {
			await vi.waitFor(() => expect(pool.metrics.queued).toBe(1));
			controller.abort();
			await assertion;
			expect(callback).not.toHaveBeenCalled();
			expect(pool.metrics).toMatchObject({ active: 1, queued: 0, queuedBytes: 0, admitted: 1 });
			await expect(pool.run("a", "second", false, callback)).rejects.toMatchObject({ code: "EWORKER_BUSY" });
			finish.resolve();
			await active;
			await pool.run("a", "second", false, callback);
			expect(callback).toHaveBeenCalledOnce();
			expect(pool.metrics).toMatchObject({ active: 0, queued: 0, admitted: 2, completed: 2 });
		} finally {
			finish.resolve();
			await active;
			await pool.shutdown(0);
		}
	});

	it("charges nested same-sandbox calls once and releases only once", async () => {
		const pool = new WorkerOwnerPool(loadWorkerPoolOptions({}));
		try {
			await pool.run("a", "first", false, async () => {
				await pool.run("a", "first", false, async () => expect(pool.metrics.active).toBe(1));
			});
			expect(pool.metrics).toMatchObject({ active: 0, admitted: 1, completed: 1 });
			await pool.run("a", "second", false, async () => {});
			expect(pool.metrics).toMatchObject({ active: 0, admitted: 2, completed: 2 });
		} finally {
			await pool.shutdown(0);
		}
	});

	it("charges only successful reservations and makes release idempotent", async () => {
		let available = false;
		const releaseResource = vi.fn();
		const admission = new FairAdmission(
			{
				capacity: 2,
				maxActivePerTenant: 1,
				maxQueued: 4,
				maxQueuedPerTenant: 2,
				maxQueuedBytes: 100,
				maxQueuedBytesPerTenant: 50,
				waitMs: 1000,
			},
			() => (available ? releaseResource : undefined),
		);
		const waiting = admission.acquire("a", "first", 1);
		expect(admission.metrics).toMatchObject({ active: 0, queued: 1, admitted: 0 });
		available = true;
		admission.wake();
		const release = await waiting;
		release();
		release();
		expect(releaseResource).toHaveBeenCalledOnce();
		const reused = await admission.acquire("a", "second", 1);
		expect(admission.metrics).toMatchObject({ active: 1, admitted: 2, completed: 1 });
		reused();
	});

	it("leaves disabled inline sessions concurrent and ignores worker-only configuration", async () => {
		vi.stubEnv("SQL_FS_WORKER_ACTIVE_TENANT_MAX", "0");
		const manager = new SessionManager({ workerEnabled: false, createFs: async () => new InMemoryFs() });
		const started = checkpoint();
		const finish = checkpoint();
		await manager.getOrCreate("a", "inline");
		const active = manager.withSessionRead("a", "inline", async () => {
			started.resolve();
			await finish.reached;
		});
		await started.reached;
		try {
			await expect(manager.withSessionRead("a", "inline", async () => "second-reader")).resolves.toBe("second-reader");
			expect(manager.getWorkerMetrics()).toBeUndefined();
		} finally {
			finish.resolve();
			await active;
			await manager.shutdown();
		}
	});
});

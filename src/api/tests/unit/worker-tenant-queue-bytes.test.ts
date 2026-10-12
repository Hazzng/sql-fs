import { describe, expect, it } from "vitest";
import { FairAdmission } from "../../worker-owner/admission.js";
import { loadWorkerPoolOptions } from "../../worker-owner/pool.js";

const options = {
	capacity: 2,
	maxActivePerTenant: 1,
	maxQueued: 8,
	maxQueuedPerTenant: 4,
	maxQueuedBytes: 100,
	maxQueuedBytesPerTenant: 50,
	waitMs: 1000,
};

describe("queued bytes per tenant", () => {
	it.each([
		{ total: 2, tenantLimit: 1 },
		{ total: 8, tenantLimit: 4 },
		{ total: undefined, tenantLimit: 8 },
	])("preserves another tenant's queue capacity with global request limit $total", async ({ total, tenantLimit }) => {
		const configured = loadWorkerPoolOptions(total === undefined ? {} : { SQL_FS_WORKER_QUEUE_MAX: String(total) });
		const admission = new FairAdmission({ ...configured, capacity: configured.count, waitMs: 1000 });
		const finishA = await admission.acquire("a", "a-active", 0);
		const finishB = await admission.acquire("b", "b-active", 0);
		const order: string[] = [];
		const waitingA = Array.from({ length: tenantLimit }, (_, index) =>
			admission.acquire("a", `a-${index}`, 1).then((release) => {
				order.push(`a-${index}`);
				release();
			}),
		);
		const excess = admission.acquire("a", "a-excess", 1).then(
			(release) => {
				release();
				return { code: undefined };
			},
			(error: { code?: string }) => error,
		);
		const waitingB = admission.acquire("b", "b-next", 1).then((release) => {
			order.push("b");
			release();
		});
		const settled = Promise.allSettled([...waitingA, excess, waitingB]);
		try {
			expect(admission.metrics).toMatchObject({
				active: 2,
				queued: tenantLimit + 1,
				queuedBytes: tenantLimit + 1,
				refused: 1,
			});
			expect(await excess).toMatchObject({ code: "EWORKER_BUSY" });
			finishB();
			await waitingB;
			expect(order).toEqual(["b"]);
			finishA();
			await Promise.all(waitingA);
			expect(order).toEqual(["b", ...Array.from({ length: tenantLimit }, (_, index) => `a-${index}`)]);
			expect(admission.metrics).toMatchObject({ active: 0, queued: 0, queuedBytes: 0, completed: tenantLimit + 3 });
		} finally {
			admission.close();
			finishA();
			finishB();
			await settled;
		}
	});

	it("admits eligible work beside a tenant occupying the single queue slot", async () => {
		const configured = loadWorkerPoolOptions({ SQL_FS_WORKER_QUEUE_MAX: "1" });
		const admission = new FairAdmission({ ...configured, capacity: configured.count, waitMs: 1000 });
		const finishA = await admission.acquire("a", "a-active", 0);
		const waitingA = admission.acquire("a", "a-next", 1).then((release) => release());
		const settled = Promise.allSettled([waitingA]);
		let finishB: (() => void) | undefined;
		try {
			finishB = await admission.acquire("b", "b-active", 0);
			expect(admission.metrics).toMatchObject({ active: 2, queued: 1, queuedBytes: 1, refused: 0 });
			await expect(admission.acquire("b", "b-next", 1)).rejects.toMatchObject({ code: "EWORKER_BUSY" });
			finishB();
			finishA();
			await waitingA;
			expect(admission.metrics).toMatchObject({ active: 0, queued: 0, queuedBytes: 0, completed: 3 });
		} finally {
			admission.close();
			finishA();
			finishB?.();
			await settled;
		}
	});

	it("admits another tenant's large request immediately beside a quota-blocked waiter", async () => {
		const admission = new FairAdmission(options);
		const finishA = await admission.acquire("a", "a-active", 0);
		const waitingA = admission.acquire("a", "a-next", 1).then((release) => release());
		const b = admission.acquire("b", "b-large", 60);
		const settled = Promise.allSettled([waitingA, b]);
		let finishB: (() => void) | undefined;
		try {
			finishB = await b;
			expect(admission.metrics).toMatchObject({ active: 2, queued: 1, queuedBytes: 1, admitted: 2, refused: 0 });
			finishB();
			expect(admission.metrics).toMatchObject({ active: 1, queued: 1, queuedBytes: 1, completed: 1 });
			finishA();
			await waitingA;
			expect(admission.metrics).toMatchObject({ active: 0, queued: 0, queuedBytes: 0, admitted: 3, completed: 3 });
		} finally {
			admission.close();
			finishA();
			finishB?.();
			await settled;
		}
	});

	it("serves an earlier runnable waiter before a new request when its resource recovers without a wake", async () => {
		let available = false;
		const reserved: string[] = [];
		const admission = new FairAdmission({ ...options, capacity: 1 }, (key) => {
			if (!available) return undefined;
			available = false;
			reserved.push(key);
			return () => {
				available = true;
			};
		});
		const earlier = admission.acquire("a", "earlier", 1);
		const settled = Promise.allSettled([earlier]);
		let release: (() => void) | undefined;
		try {
			expect(admission.metrics).toMatchObject({ active: 0, queued: 1, queuedBytes: 1 });
			available = true;
			await expect(admission.acquire("b", "newcomer", 60)).rejects.toMatchObject({ code: "EWORKER_BUSY" });
			expect(reserved).toEqual(["earlier"]);
			expect(admission.metrics).toMatchObject({ active: 1, queued: 0, queuedBytes: 0, admitted: 1, refused: 1 });
			release = await earlier;
			release();
		} finally {
			admission.close();
			release?.();
			await settled;
		}
	});

	it("leaves room for another tenant's queue while the first tenant remains active", async () => {
		const admission = new FairAdmission(options);
		const finishA = await admission.acquire("a", "a-active", 0);
		const finishB = await admission.acquire("b", "b-active", 0);
		const order: string[] = [];
		const a = admission.acquire("a", "a-next", 50).then((release) => {
			order.push("a");
			release();
		});
		const excess = admission.acquire("a", "a-excess", 50).then(
			(release) => {
				release();
				return { code: undefined };
			},
			(error: { code?: string }) => error,
		);
		const b = admission.acquire("b", "b-next", 1).then((release) => {
			order.push("b");
			release();
		});
		const settled = Promise.allSettled([a, excess, b]);
		try {
			expect(admission.metrics).toMatchObject({ active: 2, queued: 2, queuedBytes: 51, admitted: 2, refused: 1 });
			expect(await excess).toMatchObject({ code: "EWORKER_BUSY" });
			finishB();
			await b;
			expect(order).toEqual(["b"]);
			expect(admission.metrics).toMatchObject({ active: 1, queued: 1, queuedBytes: 50, completed: 2 });
			finishA();
			await a;
			expect(order).toEqual(["b", "a"]);
			expect(admission.metrics).toMatchObject({ active: 0, queued: 0, queuedBytes: 0, admitted: 4, completed: 4 });
		} finally {
			admission.close();
			finishA();
			finishB();
			await settled;
		}
	});

	it.each(["abort", "timeout"] as const)("restores the tenant byte allowance after queued %s", async (mode) => {
		const admission = new FairAdmission({ ...options, waitMs: mode === "timeout" ? 20 : 1000 });
		const finish = await admission.acquire("a", "a-active", 0);
		const controller = new AbortController();
		const waiting = admission.acquire("a", "a-next", 50, controller.signal);
		const rejection = expect(waiting).rejects.toMatchObject({ code: mode === "abort" ? "ABORTED" : "EWORKER_BUSY" });
		try {
			expect(admission.metrics).toMatchObject({ active: 1, queued: 1, queuedBytes: 50 });
			await expect(admission.acquire("a", "a-excess", 1)).rejects.toMatchObject({ code: "EWORKER_BUSY" });
			if (mode === "abort") controller.abort();
			await rejection;
			expect(admission.metrics).toMatchObject({ active: 1, queued: 0, queuedBytes: 0 });
			const reused = admission.acquire("a", "a-reused", 50);
			expect(admission.metrics).toMatchObject({ active: 1, queued: 1, queuedBytes: 50 });
			finish();
			(await reused)();
			expect(admission.metrics).toMatchObject({ active: 0, queued: 0, queuedBytes: 0, admitted: 2, completed: 2 });
		} finally {
			admission.close();
			finish();
			await Promise.allSettled([waiting]);
		}
	});

	it("releases every queued tenant byte at shutdown while active operations drain", async () => {
		const admission = new FairAdmission(options);
		const finishA = await admission.acquire("a", "a-active", 0);
		const finishB = await admission.acquire("b", "b-active", 0);
		const a = admission.acquire("a", "a-next", 50);
		const b = admission.acquire("b", "b-next", 1);
		const rejectedA = expect(a).rejects.toMatchObject({ code: "ESHUTTINGDOWN" });
		const rejectedB = expect(b).rejects.toMatchObject({ code: "ESHUTTINGDOWN" });
		admission.close();
		await Promise.all([rejectedA, rejectedB]);
		expect(admission.metrics).toMatchObject({ active: 2, queued: 0, queuedBytes: 0 });
		finishA();
		finishB();
		expect(admission.metrics).toMatchObject({ active: 0, completed: 2 });
	});

	it("admits a large request immediately and refuses to retain it when its tenant is busy", async () => {
		const admission = new FairAdmission({
			...options,
			maxQueuedBytes: 64 * 1024 * 1024,
			maxQueuedBytesPerTenant: 32 * 1024 * 1024,
		});
		const requestBytes = 40 * 1024 * 1024;
		const release = await admission.acquire("a", "large", requestBytes);
		try {
			expect(admission.metrics).toMatchObject({ active: 1, admitted: 1, queuedBytes: 0 });
			await expect(admission.acquire("a", "waiting", requestBytes)).rejects.toMatchObject({ code: "EWORKER_BUSY" });
			expect(admission.metrics).toMatchObject({ active: 1, queued: 0, queuedBytes: 0 });
		} finally {
			release();
		}
		const retried = await admission.acquire("a", "large", requestBytes);
		retried();
		expect(admission.metrics).toMatchObject({ active: 0, admitted: 2, completed: 2, queuedBytes: 0 });
	});
});

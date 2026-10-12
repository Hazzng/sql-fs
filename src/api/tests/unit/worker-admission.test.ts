import { describe, expect, it } from "vitest";
import { FairAdmission } from "../../worker-owner/admission.js";

const options = {
	capacity: 1,
	maxActivePerTenant: 1,
	maxQueued: 3,
	maxQueuedPerTenant: 2,
	maxQueuedBytes: 12,
	maxQueuedBytesPerTenant: 11,
	waitMs: 20,
};

describe("bounded tenant admission", () => {
	it("gives a queued writer priority over later readers of that sandbox", async () => {
		const admission = new FairAdmission({ ...options, capacity: 3, maxActivePerTenant: 2, waitMs: 1000 });
		const firstReader = await admission.acquire("tenant", "sandbox", 1, undefined, true);
		const order: string[] = [];
		const writer = admission.acquire("tenant", "sandbox", 1).then((release) => {
			order.push("writer");
			return release;
		});
		const secondReader = admission.acquire("tenant", "sandbox", 1, undefined, true).then((release) => {
			order.push("reader");
			return release;
		});
		expect(admission.metrics.queued).toBe(2);
		firstReader();
		const finishWrite = await writer;
		expect(order).toEqual(["writer"]);
		finishWrite();
		(await secondReader)();
		expect(order).toEqual(["writer", "reader"]);
	});
	it("rejects excess queue count and bytes before executing work", async () => {
		const admission = new FairAdmission(options);
		const release = await admission.acquire("active", "active", 1);
		const waiting = admission.acquire("one", "one", 8);
		await expect(admission.acquire("two", "two", 5)).rejects.toMatchObject({ code: "EWORKER_BUSY" });
		expect(admission.metrics).toMatchObject({ active: 1, queued: 1, queuedBytes: 8, refused: 1 });
		release();
		(await waiting)();
		expect(admission.metrics).toMatchObject({ active: 0, queued: 0, queuedBytes: 0, completed: 2 });
	});

	it("rotates tenants while preserving each runnable tenant's order", async () => {
		const admission = new FairAdmission({ ...options, maxQueued: 8, maxQueuedBytes: 100, waitMs: 1000 });
		const active = await admission.acquire("a", "active", 1);
		const order: string[] = [];
		const a1 = admission.acquire("a", "a1", 1).then((release) => {
			order.push("a1");
			return release;
		});
		const a2 = admission.acquire("a", "a2", 1).then((release) => {
			order.push("a2");
			return release;
		});
		const b1 = admission.acquire("b", "b1", 1).then((release) => {
			order.push("b1");
			return release;
		});
		active();
		(await a1)();
		(await b1)();
		(await a2)();
		expect(order).toEqual(["a1", "b1", "a2"]);
	});

	it("cancels queued work and restores every charge", async () => {
		const admission = new FairAdmission(options);
		const release = await admission.acquire("active", "active", 1);
		const controller = new AbortController();
		const waiting = admission.acquire("queued", "queued", 9, controller.signal);
		controller.abort();
		await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
		expect(admission.metrics).toMatchObject({ queued: 0, queuedBytes: 0, admitted: 1 });
		release();
	});

	it("times out without admitting a script", async () => {
		const admission = new FairAdmission(options);
		const release = await admission.acquire("active", "active", 1);
		await expect(admission.acquire("queued", "queued", 2)).rejects.toMatchObject({ code: "EWORKER_BUSY" });
		expect(admission.metrics).toMatchObject({ offered: 2, admitted: 1, refused: 1, queued: 0, queuedBytes: 0 });
		release();
	});

	it("drains accepted work and rejects queued work at shutdown", async () => {
		const admission = new FairAdmission(options);
		const release = await admission.acquire("active", "active", 1);
		const waiting = admission.acquire("queued", "queued", 1);
		admission.close();
		await expect(waiting).rejects.toMatchObject({ code: "ESHUTTINGDOWN" });
		expect(admission.metrics.active).toBe(1);
		release();
		expect(admission.metrics.active).toBe(0);
	});
});

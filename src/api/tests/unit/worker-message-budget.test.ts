import { describe, expect, it } from "vitest";
import { assertWorkerMessageBudget } from "../../worker-owner/message-budget.js";

describe("worker message budgets", () => {
	it("charges UTF-8 strings and complete binary views before copying", () => {
		expect(() => assertWorkerMessageBudget("雪".repeat(10), 29)).toThrow("EFBIG");
		expect(() => assertWorkerMessageBudget(new Uint8Array(1024), 1023)).toThrow("EFBIG");
		expect(() => assertWorkerMessageBudget(new Uint8Array(1024), 1024)).not.toThrow();
	});
	it("bounds composite replies and accepts shared references without recursion", () => {
		const data = { stdout: "x".repeat(512), stderr: "y".repeat(512) };
		expect(() => assertWorkerMessageBudget(data, 1024)).toThrow("EFBIG");
		const cyclic: { self?: object } = {};
		cyclic.self = cyclic;
		expect(() => assertWorkerMessageBudget(cyclic, 100)).not.toThrow();
	});
	it("charges the backing bytes cloned for a tiny view without detaching its owner", () => {
		const backing = new Uint8Array(8192);
		const view = backing.subarray(0, 1);
		expect(structuredClone(view).buffer.byteLength).toBe(8192);
		expect(() => assertWorkerMessageBudget(view, 4096)).toThrow("EFBIG");
		expect(backing.byteLength).toBe(8192);
		expect(view.byteLength).toBe(1);
	});
});

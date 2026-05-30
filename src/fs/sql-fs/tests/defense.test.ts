/**
 * Unit tests for runTrustedDbAsync (defense-in-depth DB wrapper).
 *
 * just-bash 3.x freezes `Error.stackTraceLimit` (writable: false) during
 * `bash.exec`; the postgres driver assigns to it and throws. These tests
 * simulate that freeze directly (no real just-bash exec needed) and assert the
 * wrapper re-opens writability so a driver-style assignment succeeds.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runTrustedDbAsync } from "../defense.js";

describe("runTrustedDbAsync", () => {
	let original: PropertyDescriptor | undefined;

	beforeEach(() => {
		original = Object.getOwnPropertyDescriptor(Error, "stackTraceLimit");
	});

	afterEach(() => {
		// Restore the original descriptor. Guarded because a test may have left the
		// property non-configurable (defineProperty would then throw).
		try {
			if (original) Object.defineProperty(Error, "stackTraceLimit", original);
		} catch {
			Error.stackTraceLimit = original?.value as number;
		}
	});

	it("runs the callback and returns its value", async () => {
		const result = await runTrustedDbAsync(async () => 42);
		expect(result).toBe(42);
	});

	it("un-freezes a read-only Error.stackTraceLimit so the callback can assign it (just-bash 3.x)", async () => {
		// Simulate just-bash 3.x hardening: stackTraceLimit becomes non-writable.
		Object.defineProperty(Error, "stackTraceLimit", { value: 10, writable: false, configurable: true });

		let assigned = false;
		await runTrustedDbAsync(async () => {
			// Mirrors porsager's cachedError(): would throw in strict mode if still frozen.
			Error.stackTraceLimit = 4;
			assigned = true;
			Error.stackTraceLimit = 10;
		});

		expect(assigned).toBe(true);
		expect(Object.getOwnPropertyDescriptor(Error, "stackTraceLimit")?.writable).toBe(true);
	});

	it("is a no-op when stackTraceLimit is already writable (just-bash 2.x)", async () => {
		Object.defineProperty(Error, "stackTraceLimit", { value: 10, writable: true, configurable: true });

		let ran = false;
		await runTrustedDbAsync(async () => {
			ran = true;
		});

		expect(ran).toBe(true);
		const desc = Object.getOwnPropertyDescriptor(Error, "stackTraceLimit");
		expect(desc?.writable).toBe(true);
		expect(desc?.value).toBe(10);
	});
});

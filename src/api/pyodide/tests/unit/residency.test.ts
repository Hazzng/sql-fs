/**
 * Unit tests for {@link PyodideResidency} (`residency.ts`) in isolation — driven
 * by lightweight fake workers (a mutable `state` + a `dispose` spy), no real
 * Deno/Pyodide. Covers the design D4 guarantees: atomic admission never exceeds
 * the cap, the LRU never evicts a `busy`/`starting` worker, idle-kill fires after
 * `PYODIDE_IDLE_MS`, and a failed init rolls back the reserved slot.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { PyodideSandbox, WorkerState } from "../../manager.js";
import { PyodideResidency } from "../../residency.js";

interface FakeWorker {
	state: WorkerState;
	dispose: ReturnType<typeof vi.fn>;
}

function makeWorker(state: WorkerState = "idle"): FakeWorker {
	return { state, dispose: vi.fn(() => Promise.resolve()) };
}

/** Cast helper — the residency only touches `state` + `dispose`. */
function asSandbox(w: FakeWorker): PyodideSandbox {
	return w as unknown as PyodideSandbox;
}

let residency: PyodideResidency | undefined;
afterEach(() => {
	residency?.stop();
	residency = undefined;
	vi.useRealTimers();
});

describe("PyodideResidency — startup", () => {
	it("rejects a non-positive maxResident", () => {
		expect(() => new PyodideResidency({ maxResident: 0, idleMs: 1000 })).toThrow(/maxResident/);
		expect(() => new PyodideResidency({ maxResident: -1, idleMs: 1000 })).toThrow(/maxResident/);
	});
});

describe("PyodideResidency — atomic admission never exceeds the cap", () => {
	it("concurrent admissions of evictable workers keep residentCount at maxResident", async () => {
		residency = new PyodideResidency({ maxResident: 2, idleMs: 10 * 60_000 });
		const created: FakeWorker[] = [];
		const admits = Array.from({ length: 5 }, () =>
			residency!.admit(() => {
				const w = makeWorker("idle");
				created.push(w);
				return asSandbox(w);
			}),
		);
		await Promise.all(admits);

		expect(residency.residentCount).toBe(2);
		// 5 admitted, cap 2 → exactly 3 of the oldest were evicted (disposed).
		const disposed = created.filter((w) => w.dispose.mock.calls.length > 0);
		expect(disposed).toHaveLength(3);
		// The two most-recently-admitted survive, undisposed.
		expect(created.at(-1)?.dispose).not.toHaveBeenCalled();
		expect(created.at(-2)?.dispose).not.toHaveBeenCalled();
	});

	it("returns the worker the spawn factory produced", async () => {
		residency = new PyodideResidency({ maxResident: 2, idleMs: 10 * 60_000 });
		const w = makeWorker();
		const got = await residency.admit(() => asSandbox(w));
		expect(got).toBe(asSandbox(w));
		expect(residency.residentCount).toBe(1);
	});
});

describe("PyodideResidency — LRU never evicts busy/starting", () => {
	it("evicts an idle worker, sparing a busy one, when at capacity", async () => {
		residency = new PyodideResidency({ maxResident: 2, idleMs: 10 * 60_000 });
		const busy = makeWorker("idle");
		const idle = makeWorker("idle");
		await residency.admit(() => asSandbox(busy));
		await residency.admit(() => asSandbox(idle));
		busy.state = "busy"; // becomes non-evictable

		const fresh = makeWorker("idle");
		await residency.admit(() => asSandbox(fresh));

		expect(busy.dispose).not.toHaveBeenCalled(); // spared
		expect(idle.dispose).toHaveBeenCalledTimes(1); // evicted
		expect(residency.residentCount).toBe(2);
	});

	it("spares a starting worker too", async () => {
		residency = new PyodideResidency({ maxResident: 2, idleMs: 10 * 60_000 });
		const starting = makeWorker("idle");
		const idle = makeWorker("idle");
		await residency.admit(() => asSandbox(starting));
		await residency.admit(() => asSandbox(idle));
		starting.state = "starting";

		await residency.admit(() => asSandbox(makeWorker("idle")));

		expect(starting.dispose).not.toHaveBeenCalled();
		expect(idle.dispose).toHaveBeenCalledTimes(1);
	});

	it("soft over-admits (does not evict) when every resident worker is busy", async () => {
		residency = new PyodideResidency({ maxResident: 2, idleMs: 10 * 60_000 });
		const b1 = makeWorker("busy");
		const b2 = makeWorker("busy");
		// Admit while idle, then flip to busy so neither is evictable.
		await residency.admit(() => asSandbox(b1));
		await residency.admit(() => asSandbox(b2));
		b1.state = "busy";
		b2.state = "busy";

		await residency.admit(() => asSandbox(makeWorker("idle")));

		// Neither busy worker was killed; residency soft-over-admits rather than block.
		expect(b1.dispose).not.toHaveBeenCalled();
		expect(b2.dispose).not.toHaveBeenCalled();
		expect(residency.residentCount).toBe(3);
	});
});

describe("PyodideResidency — idle-kill", () => {
	it("idle-kills a resident worker after PYODIDE_IDLE_MS", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		residency = new PyodideResidency({ maxResident: 2, idleMs: 1000, sweepIntervalMs: 1000 });
		const w = makeWorker("idle");
		await residency.admit(() => asSandbox(w));
		expect(residency.residentCount).toBe(1);

		// Sweep fires at +1000ms; now - touched (1000) >= idleMs (1000) → killed.
		await vi.advanceTimersByTimeAsync(1000);

		expect(w.dispose).toHaveBeenCalledTimes(1);
		expect(residency.residentCount).toBe(0);
	});

	it("swallows a dispose() rejection in the idle-kill sweep (review #8)", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		residency = new PyodideResidency({ maxResident: 2, idleMs: 1000, sweepIntervalMs: 1000 });
		const w: FakeWorker = { state: "idle", dispose: vi.fn(() => Promise.reject(new Error("dispose boom"))) };
		await residency.admit(() => asSandbox(w));
		// The sweep must not surface an unhandled rejection when dispose rejects (an
		// unhandled rejection here would fail this test).
		await vi.advanceTimersByTimeAsync(1000);
		expect(w.dispose).toHaveBeenCalledTimes(1);
		expect(residency.residentCount).toBe(0); // still removed from the registry
	});

	it("does NOT idle-kill a busy worker even past the idle window", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		residency = new PyodideResidency({ maxResident: 2, idleMs: 1000, sweepIntervalMs: 1000 });
		const w = makeWorker("busy");
		await residency.admit(() => asSandbox(w));

		await vi.advanceTimersByTimeAsync(5000);

		expect(w.dispose).not.toHaveBeenCalled();
		expect(residency.residentCount).toBe(1);
	});

	it("touch() resets the idle clock", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		residency = new PyodideResidency({ maxResident: 2, idleMs: 2000, sweepIntervalMs: 1000 });
		const w = makeWorker("idle");
		await residency.admit(() => asSandbox(w));

		await vi.advanceTimersByTimeAsync(1000); // 1s idle — not yet killed
		expect(w.dispose).not.toHaveBeenCalled();
		residency.touch(w); // reset clock at t=1000
		await vi.advanceTimersByTimeAsync(1000); // t=2000, idle for 1s since touch — alive
		expect(w.dispose).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1000); // t=3000, idle for 2s since touch — killed
		expect(w.dispose).toHaveBeenCalledTimes(1);
	});
});

describe("PyodideResidency — failed init rolls back the reserved slot", () => {
	it("a throwing spawn leaves residentCount unchanged and rethrows", async () => {
		residency = new PyodideResidency({ maxResident: 2, idleMs: 10 * 60_000 });
		await expect(residency.admit(() => Promise.reject(new Error("init failed")))).rejects.toThrow("init failed");
		expect(residency.residentCount).toBe(0);

		// And the registry still works afterward.
		const w = makeWorker();
		await residency.admit(() => asSandbox(w));
		expect(residency.residentCount).toBe(1);
	});

	it("release() drops a worker from the registry without disposing it", async () => {
		residency = new PyodideResidency({ maxResident: 2, idleMs: 10 * 60_000 });
		const w = makeWorker();
		await residency.admit(() => asSandbox(w));
		residency.release(w as unknown as PyodideSandbox);
		expect(residency.residentCount).toBe(0);
		expect(w.dispose).not.toHaveBeenCalled(); // caller owns disposal
	});
});

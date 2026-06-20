/**
 * Unit tests for the F8 event-loop lag monitor (purely observational).
 * Covers the pure gap classifier, the structured `heartbeat_gap` emitter, and
 * the `monitorEventLoopDelay`-backed boot histogram (real busy-loop, no timers
 * faked — perf_hooks measures wall-clock).
 */

import { afterEach, describe, expect, it } from "vitest";
import {
	classifyHeartbeatGap,
	eventLoopLagSnapshot,
	recordHeartbeatGap,
	resetEventLoopMonitorForTest,
	startEventLoopMonitor,
	stopEventLoopMonitor,
} from "../../event-loop-monitor.js";

function busyLoopMs(ms: number): void {
	const start = Date.now();
	while (Date.now() - start < ms) {
		// Block the event loop synchronously — the exact "sync stall starves
		// timers" model that silently voids a Redis lease.
	}
}

describe("classifyHeartbeatGap", () => {
	it("returns ok when the gap is within the renew window", () => {
		expect(classifyHeartbeatGap(10, 80, 200)).toBe("ok");
	});
	it("returns warn when the gap exceeds renewMs but not leaseMs", () => {
		expect(classifyHeartbeatGap(120, 80, 200)).toBe("warn");
	});
	it("returns critical when the gap exceeds leaseMs", () => {
		expect(classifyHeartbeatGap(260, 80, 200)).toBe("critical");
	});
	it("treats exactly renewMs as ok (strictly greater triggers warn)", () => {
		expect(classifyHeartbeatGap(80, 80, 200)).toBe("ok");
	});
	it("treats exactly leaseMs as warn (strictly greater triggers critical)", () => {
		expect(classifyHeartbeatGap(200, 80, 200)).toBe("warn");
	});
});

describe("recordHeartbeatGap", () => {
	it("is a silent no-op when the gap is within the renew window", () => {
		const lines: string[] = [];
		const severity = recordHeartbeatGap({
			lock: "exec",
			key: "vfs:default:lock:sbx",
			expectedFireAt: 1_000,
			nowMs: 1_050,
			renewMs: 80,
			leaseMs: 200,
			log: (l) => lines.push(l),
		});
		expect(severity).toBe("ok");
		expect(lines).toEqual([]);
	});

	it("emits a warn line with the full structured payload", () => {
		const lines: string[] = [];
		const severity = recordHeartbeatGap({
			lock: "rw-writer",
			key: "vfs:default:rwlock:{sbx}:writer",
			expectedFireAt: 1_000,
			nowMs: 1_150,
			renewMs: 80,
			leaseMs: 200,
			log: (l) => lines.push(l),
		});
		expect(severity).toBe("warn");
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0]!)).toEqual({
			event: "heartbeat_gap",
			severity: "warn",
			lock: "rw-writer",
			key: "vfs:default:rwlock:{sbx}:writer",
			gapMs: 150,
			renewMs: 80,
			leaseMs: 200,
		});
	});

	it("emits a critical line when the gap exceeds the lease", () => {
		const lines: string[] = [];
		const severity = recordHeartbeatGap({
			lock: "rw-reader",
			key: "vfs:default:rwlock:{sbx}:readers",
			expectedFireAt: 1_000,
			nowMs: 1_300,
			renewMs: 80,
			leaseMs: 200,
			log: (l) => lines.push(l),
		});
		expect(severity).toBe("critical");
		const parsed = JSON.parse(lines[0]!);
		expect(parsed.severity).toBe("critical");
		expect(parsed.gapMs).toBe(300);
		expect(parsed.lock).toBe("rw-reader");
	});
});

describe("event-loop monitor lifecycle", () => {
	afterEach(() => resetEventLoopMonitorForTest());

	it("snapshot is undefined before start and defined after", () => {
		expect(eventLoopLagSnapshot()).toBeUndefined();
		startEventLoopMonitor({ sampleIntervalMs: 100_000, log: () => {} });
		const snap = eventLoopLagSnapshot();
		expect(snap).toBeDefined();
		expect(typeof snap?.maxMs).toBe("number");
		expect(typeof snap?.p99Ms).toBe("number");
	});

	it("double start and double stop are safe (idempotent)", () => {
		startEventLoopMonitor({ sampleIntervalMs: 100_000, log: () => {} });
		expect(() => startEventLoopMonitor({ log: () => {} })).not.toThrow();
		stopEventLoopMonitor();
		expect(() => stopEventLoopMonitor()).not.toThrow();
		expect(eventLoopLagSnapshot()).toBeUndefined();
	});

	it("sampler periodically logs event_loop_lag with p50/p99/max/mean fields", async () => {
		const lines: string[] = [];
		startEventLoopMonitor({ sampleIntervalMs: 40, resolutionMs: 10, log: (l) => lines.push(l) });
		try {
			await new Promise((res) => setTimeout(res, 110));
		} finally {
			stopEventLoopMonitor();
		}
		const samples = lines.map((l) => JSON.parse(l)).filter((o) => o.event === "event_loop_lag");
		expect(samples.length).toBeGreaterThan(0);
		const s = samples[0]!;
		expect(s).toMatchObject({
			event: "event_loop_lag",
			p50Ms: expect.any(Number),
			p99Ms: expect.any(Number),
			maxMs: expect.any(Number),
			meanMs: expect.any(Number),
			windowMs: 40,
		});
	});

	it("snapshot reflects an elevated max after a synchronous stall", async () => {
		startEventLoopMonitor({ sampleIntervalMs: 100_000, resolutionMs: 10, log: () => {} });
		try {
			// Warm up: monitorEventLoopDelay only attributes a stall once its internal
			// timer baseline is established (one loop tick after enable()).
			await new Promise((res) => setTimeout(res, 40));
			busyLoopMs(250);
			// Let the overdue internal tick fire and record the delay.
			await new Promise((res) => setTimeout(res, 40));
			const snap = eventLoopLagSnapshot();
			expect(snap).toBeDefined();
			// The 250 ms busy-loop must surface as ≥100 ms of measured delay (slop for
			// scheduler granularity / CI noise).
			expect(snap?.maxMs).toBeGreaterThanOrEqual(100);
		} finally {
			stopEventLoopMonitor();
		}
	});
});

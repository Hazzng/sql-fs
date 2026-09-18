/**
 * Unit tests for the F8 event-loop lag monitor (purely observational).
 * Covers the pure gap classifier, the structured `heartbeat_gap` emitter, and
 * the `monitorEventLoopDelay`-backed boot histogram (real busy-loop, no timers
 * faked — perf_hooks measures wall-clock).
 */

import { afterEach, describe, expect, it } from "vitest";
import {
	DEFAULT_STALL_THRESHOLD_MS,
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

	// An empty histogram reports mean as NaN, which JSON.stringify renders as null — the snapshot
	// is on /readyz now, so that would put a null where the type promises a number (#168).
	it("reports finite numbers from a histogram with nothing sampled yet", () => {
		startEventLoopMonitor({ sampleIntervalMs: 100_000, log: () => {} });
		const snap = eventLoopLagSnapshot();
		expect(snap).toBeDefined();
		expect(Number.isFinite(snap?.meanMs)).toBe(true);
		expect(JSON.parse(JSON.stringify(snap))).toEqual({
			p50Ms: expect.any(Number),
			p99Ms: expect.any(Number),
			p999Ms: expect.any(Number),
			maxMs: expect.any(Number),
			meanMs: expect.any(Number),
		});
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
			p999Ms: expect.any(Number),
			maxMs: expect.any(Number),
			meanMs: expect.any(Number),
			windowMs: 40,
		});
	});

	// #168: a lone multi-second stall is a few tenths of a percent of a window's readings, so p99
	// reports the idle floor and only max moves. p99.9 is the percentile that answers.
	it("reports a lone stall at p99.9 that p99 dilutes away", async () => {
		startEventLoopMonitor({ sampleIntervalMs: 100_000, resolutionMs: 5, stallThresholdMs: 100_000, log: () => {} });
		try {
			// ~100 idle readings at 5 ms, so one stall is ~1% of the window — enough for p99 to
			// swallow it (the production window holds ~400, where it is swallowed far harder).
			await new Promise((res) => setTimeout(res, 500));
			busyLoopMs(200);
			await new Promise((res) => setTimeout(res, 40));
			const snap = eventLoopLagSnapshot();
			expect(snap).toBeDefined();
			expect(snap?.p99Ms).toBeLessThan(50);
			expect(snap?.p999Ms).toBeGreaterThanOrEqual(100);
		} finally {
			stopEventLoopMonitor();
		}
	});

	it("emits event_loop_stall when a window max crosses the threshold", async () => {
		const lines: string[] = [];
		startEventLoopMonitor({ sampleIntervalMs: 60, resolutionMs: 10, stallThresholdMs: 100, log: (l) => lines.push(l) });
		try {
			// Warm up: monitorEventLoopDelay only attributes a stall once its internal timer baseline
			// is established (one loop tick after enable()).
			await new Promise((res) => setTimeout(res, 40));
			busyLoopMs(250);
			await new Promise((res) => setTimeout(res, 140));
		} finally {
			stopEventLoopMonitor();
		}
		const stalls = lines.map((l) => JSON.parse(l)).filter((o) => o.event === "event_loop_stall");
		expect(stalls.length).toBeGreaterThan(0);
		const s = stalls[0]!;
		expect(s.severity).toBe("critical");
		expect(s.thresholdMs).toBe(100);
		expect(s.windowMs).toBe(60);
		expect(s.maxMs).toBeGreaterThan(100);
	});

	// Negative guard: the line is gated on the threshold, not on "a stall happened" — the same
	// 150 ms stall that would trip a 100 ms threshold must stay silent under a high one, or the
	// signal is a per-window chorus and worthless as an alert.
	it("stays silent when a real stall stays under the threshold", async () => {
		const lines: string[] = [];
		startEventLoopMonitor({
			sampleIntervalMs: 60,
			resolutionMs: 10,
			stallThresholdMs: 100_000,
			log: (l) => lines.push(l),
		});
		try {
			await new Promise((res) => setTimeout(res, 40));
			busyLoopMs(150);
			await new Promise((res) => setTimeout(res, 140));
		} finally {
			stopEventLoopMonitor();
		}
		const parsed = lines.map((l) => JSON.parse(l));
		const lag = parsed.filter((o) => o.event === "event_loop_lag");
		// The stall really did land in the histogram — this is not a silent run.
		expect(Math.max(...lag.map((o) => o.maxMs as number))).toBeGreaterThanOrEqual(100);
		expect(parsed.filter((o) => o.event === "event_loop_stall")).toEqual([]);
	});

	// The default is the Redis client's commandTimeout — the point where a stall stops being a
	// latency problem and starts failing other tenants' in-flight commands (#168).
	it("defaults the stall threshold to the 2 s Redis command timeout", () => {
		expect(DEFAULT_STALL_THRESHOLD_MS).toBe(2_000);
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

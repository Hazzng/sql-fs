/**
 * F8: Event-loop lag observability (purely observational — no behavior change).
 *
 * The three Redis leases — the exec-lock writer lease (`distributed-lock.ts`),
 * the RW-lock writer flag (`distributed-rw-lock.ts` exclusive heartbeat), and the
 * RW-lock reader ZSET scores (shared heartbeat) — each keep themselves alive with
 * a `setTimeout`-driven heartbeat that renews well before expiry (`renewMs` <
 * `leaseMs`). They silently assume the timer fires roughly on schedule. A long
 * event-loop stall (a V8 GC pause, a pathological synchronous bash stretch, or —
 * only when `REDIS_PATH_SNAPSHOT_ENABLED=true` — the in-lock msgpack encode) fires
 * the renewal late; by then Redis has already expired the key / reaped the ZSET
 * entry, another replica can step in, and the next renew returns 0 →
 * `LockLostError`. Lock 3 (PG advisory + per-tx serialization, see DEVELOPER.md)
 * prevents any DB corruption, so this is an *observability* gap, not a correctness
 * bug: nothing measured how close the process ran to the lease floor.
 *
 * This module measures it, two ways:
 *  - {@link startEventLoopMonitor}/{@link stopEventLoopMonitor}: a
 *    `perf_hooks.monitorEventLoopDelay` histogram, sampled on an interval and
 *    logged as `event:"event_loop_lag"` (p50/p99/max ms), then reset each window.
 *  - {@link recordHeartbeatGap}: called from each heartbeat callback with the time
 *    the timer was *expected* to fire; emits `event:"heartbeat_gap"` at severity
 *    `"warn"` (gap > renewMs — a full renewal interval late) or `"critical"`
 *    (gap > leaseMs — the lease almost certainly lapsed). No-op below renewMs and
 *    safe to call when the monitor was never started (unit tests / no-Redis runs).
 */

import { type IntervalHistogram, monitorEventLoopDelay } from "node:perf_hooks";

const NS_PER_MS = 1_000_000;

/** Default interval (ms) between event-loop-lag samples. Override via `EVENT_LOOP_MONITOR_INTERVAL_MS`. */
export const DEFAULT_SAMPLE_INTERVAL_MS = 10_000;
/** Default histogram resolution (ms) — how often perf_hooks records a delay reading. */
export const DEFAULT_RESOLUTION_MS = 20;

/** Which lease a heartbeat gap belongs to, for alert routing. */
export type HeartbeatLockKind = "exec" | "rw-writer" | "rw-reader";

/** Severity of a single heartbeat gap relative to the renew/lease windows. */
export type HeartbeatGapSeverity = "ok" | "warn" | "critical";

export interface EventLoopLagSnapshot {
	readonly p50Ms: number;
	readonly p99Ms: number;
	readonly maxMs: number;
	readonly meanMs: number;
}

export interface EventLoopMonitorOptions {
	/** Sampling/log interval (ms). Each window is logged, then the histogram is reset. */
	readonly sampleIntervalMs?: number;
	/** perf_hooks histogram resolution (ms). */
	readonly resolutionMs?: number;
	/** Injectable log sink (defaults to `console.log`). Tests pass a collector. */
	readonly log?: (line: string) => void;
}

interface MonitorState {
	readonly histogram: IntervalHistogram;
	readonly timer: ReturnType<typeof setInterval>;
}

let state: MonitorState | undefined;

function toMs(ns: number): number {
	// perf_hooks reports nanoseconds; round to whole ms for log readability.
	return Math.round(ns / NS_PER_MS);
}

function readSnapshot(h: IntervalHistogram): EventLoopLagSnapshot {
	return {
		p50Ms: toMs(h.percentile(50)),
		p99Ms: toMs(h.percentile(99)),
		maxMs: toMs(h.max),
		meanMs: toMs(h.mean),
	};
}

/**
 * Start the process-wide event-loop-delay monitor. Idempotent: a second call
 * while already running is a no-op. The sampling timer is `unref()`'d so it never
 * keeps the process alive past shutdown.
 */
export function startEventLoopMonitor(opts: EventLoopMonitorOptions = {}): void {
	if (state !== undefined) return;
	const sampleIntervalMs = opts.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;
	const resolutionMs = opts.resolutionMs ?? DEFAULT_RESOLUTION_MS;
	const log = opts.log ?? ((line: string): void => console.log(line));

	const histogram = monitorEventLoopDelay({ resolution: resolutionMs });
	histogram.enable();

	const timer = setInterval(() => {
		const snapshot = readSnapshot(histogram);
		histogram.reset();
		log(JSON.stringify({ event: "event_loop_lag", ...snapshot, windowMs: sampleIntervalMs }));
	}, sampleIntervalMs);
	if (typeof timer.unref === "function") timer.unref();

	state = { histogram, timer };
}

/** Stop the monitor and disable the histogram. Idempotent. */
export function stopEventLoopMonitor(): void {
	if (state === undefined) return;
	clearInterval(state.timer);
	state.histogram.disable();
	state = undefined;
}

/**
 * Current event-loop-delay snapshot, or `undefined` when the monitor is not
 * running. Reads the live histogram WITHOUT resetting it (the sampler owns the
 * reset), so a health endpoint can poll it without perturbing the windowed log.
 */
export function eventLoopLagSnapshot(): EventLoopLagSnapshot | undefined {
	if (state === undefined) return undefined;
	return readSnapshot(state.histogram);
}

/**
 * Classify a heartbeat gap. Pure — exported for direct unit testing.
 *  - `gap > leaseMs`  → "critical" (the lease has almost certainly lapsed)
 *  - `gap > renewMs`  → "warn"     (a full renewal interval late)
 *  - otherwise        → "ok"       (within normal jitter)
 */
export function classifyHeartbeatGap(gapMs: number, renewMs: number, leaseMs: number): HeartbeatGapSeverity {
	if (gapMs > leaseMs) return "critical";
	if (gapMs > renewMs) return "warn";
	return "ok";
}

export interface HeartbeatGapInput {
	readonly lock: HeartbeatLockKind;
	readonly key: string;
	/** `Date.now()` value at which this heartbeat timer was scheduled to fire. */
	readonly expectedFireAt: number;
	readonly renewMs: number;
	readonly leaseMs: number;
	/** Observed fire time (ms). Defaults to `Date.now()`; injectable for tests. */
	readonly nowMs?: number;
	/** Injectable log sink. Defaults to `console.warn` (warn) / `console.error` (critical). */
	readonly log?: (line: string) => void;
}

/**
 * Record one heartbeat's actual-vs-expected fire gap. Emits an `event:
 * "heartbeat_gap"` structured line at "warn" or "critical" severity; below the
 * renew window it is a silent no-op (the common case — every healthy tick).
 *
 * Returns the classified severity so callers/tests can branch without re-deriving
 * it. This function never throws and never depends on {@link startEventLoopMonitor}.
 */
export function recordHeartbeatGap(input: HeartbeatGapInput): HeartbeatGapSeverity {
	const now = input.nowMs ?? Date.now();
	const gapMs = now - input.expectedFireAt;
	const severity = classifyHeartbeatGap(gapMs, input.renewMs, input.leaseMs);
	if (severity === "ok") return "ok";
	const line = JSON.stringify({
		event: "heartbeat_gap",
		severity,
		lock: input.lock,
		key: input.key,
		gapMs,
		renewMs: input.renewMs,
		leaseMs: input.leaseMs,
	});
	if (input.log !== undefined) {
		input.log(line);
	} else if (severity === "critical") {
		console.error(line);
	} else {
		console.warn(line);
	}
	return severity;
}

/** Test hook: force the monitor back to the not-started state. */
export function resetEventLoopMonitorForTest(): void {
	stopEventLoopMonitor();
}

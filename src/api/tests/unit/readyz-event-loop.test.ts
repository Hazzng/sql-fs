/**
 * GET /readyz — event-loop lag egress (#168).
 *
 * The F8 histogram had no non-test caller: it was not on a route, not on /readyz, not on any
 * metrics endpoint, and its only egress was a `console.log`. Nothing could poll how close a
 * replica was running to the 2 s Redis commandTimeout. /readyz now carries the snapshot.
 */

import { afterEach, describe, expect, it } from "vitest";
import { eventLoopLagSnapshot, resetEventLoopMonitorForTest, startEventLoopMonitor } from "../../event-loop-monitor.js";
import { app } from "../../server.js";

describe("GET /readyz event-loop lag", () => {
	afterEach(() => resetEventLoopMonitorForTest());

	it("carries the lag snapshot while the monitor is running", async () => {
		startEventLoopMonitor({ sampleIntervalMs: 100_000, log: () => {} });

		const res = await app.request("/readyz");

		expect(res.status).toBe(200);
		const body = (await res.json()) as { status: string; eventLoop?: Record<string, unknown> };
		expect(body.status).toBe("ok");
		expect(body.eventLoop).toEqual({
			p50Ms: expect.any(Number),
			p99Ms: expect.any(Number),
			p999Ms: expect.any(Number),
			maxMs: expect.any(Number),
			meanMs: expect.any(Number),
		});
	});

	// Scraping must not reset the histogram, or a probe would erase the window the sampler is about
	// to log — the reason `eventLoopLagSnapshot` reads without resetting.
	it("does not reset the histogram it reports", async () => {
		startEventLoopMonitor({ sampleIntervalMs: 100_000, log: () => {} });
		await new Promise((res) => setTimeout(res, 80));

		const body = (await (await app.request("/readyz")).json()) as { eventLoop: { maxMs: number } };

		expect(body.eventLoop.maxMs).toBeGreaterThan(0);
		expect(eventLoopLagSnapshot()?.maxMs).toBeGreaterThanOrEqual(body.eventLoop.maxMs);
	});

	// Negative guard: the field is absent — not null, not zeroed — when nothing is measuring, so a
	// scraper cannot mistake "not booted via the entry point" for "a perfectly idle loop".
	it("omits the field entirely when the monitor is not running", async () => {
		const res = await app.request("/readyz");

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: "ok" });
	});
});

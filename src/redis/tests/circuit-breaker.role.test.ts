/**
 * #167: the breaker must be scoped per Redis role, and every transition must be
 * logged. The original 114,213-request outage produced zero log lines beyond
 * request logs, which is why it was misdiagnosed as a Postgres problem.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RedisCircuitBreaker, getRedisCircuitBreaker, resetRedisCircuitBreakerForTest } from "../circuit-breaker.js";

function tripOpen(breaker: RedisCircuitBreaker, threshold = 5): void {
	for (let i = 0; i < threshold; i++) breaker.recordFailure();
}

/** Parsed JSON objects logged through console.log / console.error while the spies are installed. */
function loggedEvents(...spies: ReadonlyArray<{ mock: { calls: unknown[][] } }>): Array<Record<string, unknown>> {
	const out: Array<Record<string, unknown>> = [];
	for (const spy of spies) {
		for (const call of spy.mock.calls) {
			const first = call[0];
			if (typeof first !== "string") continue;
			try {
				out.push(JSON.parse(first) as Record<string, unknown>);
			} catch {
				// non-JSON console output is not an event
			}
		}
	}
	return out;
}

beforeEach(() => {
	resetRedisCircuitBreakerForTest();
});

afterEach(() => {
	resetRedisCircuitBreakerForTest();
	vi.restoreAllMocks();
});

describe("getRedisCircuitBreaker role scoping", () => {
	it("returns a distinct breaker per role", () => {
		expect(getRedisCircuitBreaker("data")).not.toBe(getRedisCircuitBreaker("control"));
	});

	it("defaults to the control role when none is given", () => {
		expect(getRedisCircuitBreaker()).toBe(getRedisCircuitBreaker("control"));
		expect(getRedisCircuitBreaker()).not.toBe(getRedisCircuitBreaker("data"));
	});

	it("leaves the control breaker closed when the data breaker opens", () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		tripOpen(getRedisCircuitBreaker("data"));
		expect(getRedisCircuitBreaker("data").state).toBe("open");
		expect(getRedisCircuitBreaker("control").state).toBe("closed");
		expect(getRedisCircuitBreaker("control").isOpen()).toBe(false);
	});

	it("leaves the data breaker closed when the control breaker opens", () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		tripOpen(getRedisCircuitBreaker("control"));
		expect(getRedisCircuitBreaker("control").state).toBe("open");
		expect(getRedisCircuitBreaker("data").state).toBe("closed");
		expect(getRedisCircuitBreaker("data").isOpen()).toBe(false);
	});
});

describe("RedisCircuitBreaker transition events", () => {
	it("emits redis_circuit_open with the role when it opens", () => {
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		const breaker = new RedisCircuitBreaker({ threshold: 3, openMs: 5_000, role: "data" });
		tripOpen(breaker, 3);
		expect(loggedEvents(err)).toEqual([{ event: "redis_circuit_open", role: "data", threshold: 3, openMs: 5_000 }]);
	});

	it("emits redis_circuit_closed with the role when a probe succeeds", () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		let now = 0;
		const breaker = new RedisCircuitBreaker({ threshold: 2, openMs: 100, role: "control", now: () => now });
		tripOpen(breaker, 2);
		now = 200;
		expect(breaker.isOpen()).toBe(false); // half-open probe
		breaker.recordSuccess();
		expect(breaker.state).toBe("closed");
		expect(loggedEvents(log)).toEqual([{ event: "redis_circuit_closed", role: "control" }]);
	});

	// Regression guard, not a fix-proving test: recordSuccess() runs on every
	// successful acquire, so logging unconditionally would flood the log.
	it("does not log on a success that was already closed", () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const breaker = new RedisCircuitBreaker({ threshold: 2, openMs: 100, role: "control" });
		breaker.recordSuccess();
		breaker.recordSuccess();
		expect(loggedEvents(log)).toEqual([]);
	});

	it("logs open once, not on every further failure while open", () => {
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		const breaker = new RedisCircuitBreaker({ threshold: 2, openMs: 5_000, role: "data" });
		tripOpen(breaker, 2);
		breaker.recordFailure();
		breaker.recordFailure();
		expect(loggedEvents(err).filter((e) => e.event === "redis_circuit_open")).toHaveLength(1);
	});

	it("logs open again after a failed half-open probe re-opens it", () => {
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		let now = 0;
		const breaker = new RedisCircuitBreaker({ threshold: 2, openMs: 100, role: "data", now: () => now });
		tripOpen(breaker, 2);
		now = 200;
		expect(breaker.isOpen()).toBe(false); // half-open probe
		breaker.recordFailure();
		expect(breaker.state).toBe("open");
		expect(loggedEvents(err).filter((e) => e.event === "redis_circuit_open")).toHaveLength(2);
	});
});

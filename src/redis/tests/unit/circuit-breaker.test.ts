import { describe, expect, it } from "vitest";
import { CircuitOpenError, RedisCircuitBreaker } from "../../circuit-breaker.js";

/** Controllable clock so we can drive the open → half-open cool-down deterministically. */
function fixedClock(start = 0): { now: () => number; advance: (ms: number) => void } {
	let t = start;
	return {
		now: () => t,
		advance: (ms: number) => {
			t += ms;
		},
	};
}

describe("RedisCircuitBreaker", () => {
	it("starts closed", () => {
		const b = new RedisCircuitBreaker();
		expect(b.state).toBe("closed");
		expect(b.isOpen()).toBe(false);
	});

	it("opens after exactly `threshold` consecutive failures", () => {
		const b = new RedisCircuitBreaker({ threshold: 5, openMs: 5_000 });
		for (let i = 0; i < 4; i++) b.recordFailure();
		expect(b.state).toBe("closed");
		expect(b.isOpen()).toBe(false);
		b.recordFailure();
		expect(b.state).toBe("open");
		expect(b.isOpen()).toBe(true);
	});

	it("a success resets the consecutive-failure run", () => {
		const b = new RedisCircuitBreaker({ threshold: 3, openMs: 5_000 });
		b.recordFailure();
		b.recordFailure();
		b.recordSuccess();
		b.recordFailure();
		b.recordFailure();
		// Only 2 in a row after the reset — still closed.
		expect(b.state).toBe("closed");
	});

	it("assertClosed throws CircuitOpenError once open", () => {
		const b = new RedisCircuitBreaker({ threshold: 1, openMs: 5_000 });
		expect(() => b.assertClosed()).not.toThrow();
		b.recordFailure();
		expect(() => b.assertClosed()).toThrow(CircuitOpenError);
		expect(() => b.assertClosed()).toThrow(/circuit breaker is open/i);
	});

	it("transitions open → half-open after openMs and lets ONE probe through", () => {
		const clock = fixedClock();
		const b = new RedisCircuitBreaker({ threshold: 1, openMs: 5_000, now: clock.now });
		b.recordFailure();
		expect(b.isOpen()).toBe(true);

		clock.advance(5_000);
		// First probe is allowed through (isOpen false), state goes half-open.
		expect(b.isOpen()).toBe(false);
		expect(b.state).toBe("half_open");
		// Concurrent callers still fast-fail while the probe is in flight.
		expect(b.isOpen()).toBe(true);
	});

	it("a successful probe closes the breaker", () => {
		const clock = fixedClock();
		const b = new RedisCircuitBreaker({ threshold: 1, openMs: 5_000, now: clock.now });
		b.recordFailure();
		clock.advance(5_000);
		expect(b.isOpen()).toBe(false); // probe allowed
		b.recordSuccess();
		expect(b.state).toBe("closed");
		expect(b.isOpen()).toBe(false);
	});

	it("a failed probe re-opens the breaker for another openMs", () => {
		const clock = fixedClock();
		const b = new RedisCircuitBreaker({ threshold: 1, openMs: 5_000, now: clock.now });
		b.recordFailure();
		clock.advance(5_000);
		expect(b.isOpen()).toBe(false); // probe allowed
		b.recordFailure(); // probe failed
		expect(b.state).toBe("open");
		expect(b.isOpen()).toBe(true);
		// Still open before the new cool-down elapses.
		clock.advance(4_999);
		expect(b.isOpen()).toBe(true);
		clock.advance(1);
		expect(b.isOpen()).toBe(false); // next probe allowed
	});

	it("uses default threshold of 5 when constructed with no options", () => {
		const b = new RedisCircuitBreaker();
		for (let i = 0; i < 4; i++) b.recordFailure();
		expect(b.state).toBe("closed");
		b.recordFailure();
		expect(b.state).toBe("open");
	});
});

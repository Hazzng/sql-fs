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
		expect(b.tryAcquire()).toBe(false);

		clock.advance(5_000);
		// First probe is allowed through, state goes half-open.
		expect(b.tryAcquire()).toBe(true);
		expect(b.state).toBe("half_open");
		// Concurrent callers still fast-fail while the probe is in flight.
		expect(b.tryAcquire()).toBe(false);
	});

	it("a successful probe closes the breaker", () => {
		const clock = fixedClock();
		const b = new RedisCircuitBreaker({ threshold: 1, openMs: 5_000, now: clock.now });
		b.recordFailure();
		clock.advance(5_000);
		expect(b.tryAcquire()).toBe(true); // probe allowed
		b.recordSuccess();
		expect(b.state).toBe("closed");
		expect(b.isOpen()).toBe(false);
	});

	it("a failed probe re-opens the breaker for another openMs", () => {
		const clock = fixedClock();
		const b = new RedisCircuitBreaker({ threshold: 1, openMs: 5_000, now: clock.now });
		b.recordFailure();
		clock.advance(5_000);
		expect(b.tryAcquire()).toBe(true); // probe allowed
		b.recordFailure(); // probe failed
		expect(b.state).toBe("open");
		expect(b.tryAcquire()).toBe(false);
		// Still open before the new cool-down elapses.
		clock.advance(4_999);
		expect(b.tryAcquire()).toBe(false);
		clock.advance(1);
		expect(b.tryAcquire()).toBe(true); // next probe allowed
	});

	// #167 M7: `isOpen()` used to hand out the half-open probe, so a caller that
	// asked and then decided not to touch Redis wedged the breaker forever.
	it("isOpen() is pure: asking does not consume the half-open probe", () => {
		const clock = fixedClock();
		const b = new RedisCircuitBreaker({ threshold: 1, openMs: 5_000, now: clock.now });
		b.recordFailure();
		clock.advance(5_000);
		expect(b.isOpen()).toBe(false);
		expect(b.isOpen()).toBe(false);
		expect(b.state).toBe("open"); // still open — no transition was made
		expect(b.tryAcquire()).toBe(true); // the probe is still there for a real caller
		expect(b.state).toBe("half_open");
	});

	it("isOpen() reports an in-flight half-open probe as open", () => {
		const clock = fixedClock();
		const b = new RedisCircuitBreaker({ threshold: 1, openMs: 5_000, now: clock.now });
		b.recordFailure();
		clock.advance(5_000);
		expect(b.tryAcquire()).toBe(true);
		expect(b.isOpen()).toBe(true);
	});

	it("uses default threshold of 5 when constructed with no options", () => {
		const b = new RedisCircuitBreaker();
		for (let i = 0; i < 4; i++) b.recordFailure();
		expect(b.state).toBe("closed");
		b.recordFailure();
		expect(b.state).toBe("open");
	});
});

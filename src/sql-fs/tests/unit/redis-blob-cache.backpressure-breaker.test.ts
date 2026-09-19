/** #167: data-plane breaker short-circuit for `RedisBlobCache`. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { RedisCircuitBreaker } from "../../../redis/circuit-breaker.js";
import { RedisBlobCache } from "../../redis-blob-cache.js";
import { StallingRedis, sha } from "./redis-blob-cache.backpressure-helpers.js";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("RedisBlobCache data-plane breaker", () => {
	it("skips Redis entirely on get while the breaker is open", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const breaker = new RedisCircuitBreaker({ threshold: 1, openMs: 60_000, role: "data" });
		breaker.recordFailure();
		const redis = new StallingRedis();
		const cache = new RedisBlobCache(redis.client, "t1", { breaker });
		expect(await cache.get(sha(1))).toBeNull();
		expect(redis.getKeys).toEqual([]);
	});

	it("skips Redis entirely on set while the breaker is open", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const breaker = new RedisCircuitBreaker({ threshold: 1, openMs: 60_000, role: "data" });
		breaker.recordFailure();
		const redis = new StallingRedis();
		const cache = new RedisBlobCache(redis.client, "t1", { breaker });
		await cache.set(sha(1), new Uint8Array(8));
		expect(redis.started).toEqual([]);
	});

	it("opens the breaker after enough consecutive get failures", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const breaker = new RedisCircuitBreaker({ threshold: 2, openMs: 60_000, role: "data" });
		const redis = new StallingRedis();
		redis.failGet = true;
		const cache = new RedisBlobCache(redis.client, "t1", { breaker });
		await cache.get(sha(1));
		await cache.get(sha(2));
		expect(breaker.state).toBe("open");
	});

	// #167 M7: the capacity checks used to sit BELOW the breaker check, and
	// `isOpen()` claimed the half-open probe. A capacity drop then returned
	// without recording success or failure, so the probe was never handed back and
	// the data breaker fast-failed for the rest of the process lifetime.
	it("does not consume the half-open probe when the write is dropped for capacity", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		let now = 0;
		const breaker = new RedisCircuitBreaker({ threshold: 1, openMs: 100, role: "data", now: () => now });
		breaker.recordFailure(); // → open
		const redis = new StallingRedis();
		const cache = new RedisBlobCache(redis.client, "t1", { maxInFlight: 1, breaker });
		now = 200; // cool-down elapsed: a probe is available

		const first = cache.set(sha(1), new Uint8Array(8)); // takes the probe, stalls in flight
		await cache.set(sha(2), new Uint8Array(8)); // over maxInFlight → dropped
		expect(cache.stats.dropped).toBe(1);

		redis.releaseAll();
		await first; // the probe settles → recordSuccess → breaker closed
		expect(breaker.state).toBe("closed");

		const third = cache.set(sha(3), new Uint8Array(8));
		expect(redis.started).toHaveLength(2); // the post-drop write reached Redis
		redis.releaseAll();
		await third;
	});

	// #167 M7 (same shape, second site): `mdel` never records success or failure,
	// so it must read the breaker purely and never take the probe.
	it("mdel does not consume the half-open probe", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		let now = 0;
		const breaker = new RedisCircuitBreaker({ threshold: 1, openMs: 100, role: "data", now: () => now });
		breaker.recordFailure(); // → open
		const redis = new StallingRedis();
		const cache = new RedisBlobCache(redis.client, "t1", { breaker });

		await cache.mdel([sha(1)]);
		expect(redis.unlinked).toEqual([]); // inside the open window → skipped

		now = 200; // cool-down elapsed: a probe is available
		await cache.mdel([sha(2)]);
		expect(redis.unlinked).toHaveLength(1); // best-effort delete proceeds
		expect(breaker.state).toBe("open"); // but it did NOT take the probe

		expect(await cache.get(sha(3))).toBeNull();
		expect(redis.getKeys).toHaveLength(1); // the probe went to a caller that settles it
		expect(breaker.state).toBe("closed");
	});

	// #167: a backfill admitted while the breaker was closed can still be in
	// flight when the breaker opens. Its late success says nothing about the
	// present, and closing on it puts the whole replica back onto a Redis that
	// nothing has re-tested.
	it("a backfill that completes after the breaker opened does not re-close it", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const breaker = new RedisCircuitBreaker({ threshold: 1, openMs: 60_000, role: "data" });
		const redis = new StallingRedis();
		const cache = new RedisBlobCache(redis.client, "t1", { breaker });
		const inFlight = cache.set(sha(1), new Uint8Array(8)); // admitted while closed
		breaker.recordFailure(); // a concurrent data-plane call fails → breaker opens
		expect(breaker.state).toBe("open");

		redis.releaseAll();
		await inFlight; // the straggler succeeds
		expect(breaker.state).toBe("open");
		expect(await cache.get(sha(2))).toBeNull();
		expect(redis.getKeys).toEqual([]); // still fast-failing to Postgres
	});

	// Regression guard, not a fix-proving test. Rejected fix for #167: making a
	// capacity drop record a breaker failure. The backfill queue saturates under
	// ordinary high-throughput writes (measured: 411 drops in a run with zero
	// 5xx), so drops are backpressure, not evidence that Redis is unreachable.
	it("does not record a breaker failure when a write is dropped for capacity", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const breaker = new RedisCircuitBreaker({ threshold: 1, openMs: 60_000, role: "data" });
		const redis = new StallingRedis();
		const cache = new RedisBlobCache(redis.client, "t1", { maxInFlight: 1, breaker });
		const first = cache.set(sha(1), new Uint8Array(8));
		for (let i = 0; i < 10; i++) await cache.set(sha(2), new Uint8Array(8));
		expect(cache.stats.dropped).toBe(10);
		expect(breaker.state).toBe("closed");
		redis.releaseAll();
		await first;
	});

	// Regression guard, not a fix-proving test: the breaker is optional, and a
	// cache constructed without one must behave exactly as it did before #167.
	it("leaves Redis reachable when no breaker is supplied", async () => {
		const redis = new StallingRedis();
		const cache = new RedisBlobCache(redis.client, "t1");
		expect(await cache.get(sha(1))).toBeNull();
		expect(redis.getKeys).toEqual([`vfs:t1:blob:${Buffer.from(sha(1)).toString("hex")}`]);
	});
});

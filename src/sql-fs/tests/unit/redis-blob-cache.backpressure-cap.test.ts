/**
 * #167: `RedisBlobCache.set` is called fire-and-forget from the Postgres dialect
 * with no cap, so a stalled Redis grew an unbounded queue of multi-MiB writes.
 * These tests pin the bounded in-flight semaphore.
 */

import type { Redis } from "ioredis";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RedisBlobCache } from "../../redis-blob-cache.js";
import { StallingRedis, sha } from "./redis-blob-cache.backpressure-helpers.js";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("RedisBlobCache.set in-flight cap", () => {
	it("drops writes past the in-flight count cap instead of queueing them", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const redis = new StallingRedis();
		const cache = new RedisBlobCache(redis.client, "t1", { maxInFlight: 2 });
		const pending = [cache.set(sha(1), new Uint8Array(8)), cache.set(sha(2), new Uint8Array(8))];
		await cache.set(sha(3), new Uint8Array(8)); // over the cap → dropped, resolves immediately
		expect(redis.started).toHaveLength(2);
		expect(cache.stats.dropped).toBe(1);
		redis.releaseAll();
		await Promise.all(pending);
		expect(cache.stats.inFlight).toBe(0);
	});

	it("drops writes past the in-flight byte cap instead of queueing them", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const redis = new StallingRedis();
		const cache = new RedisBlobCache(redis.client, "t1", { maxInFlight: 100, maxInFlightBytes: 1000 });
		const pending = cache.set(sha(1), new Uint8Array(900));
		await cache.set(sha(2), new Uint8Array(200)); // 900 + 200 > 1000 → dropped
		expect(redis.started).toHaveLength(1);
		expect(cache.stats.dropped).toBe(1);
		redis.releaseAll();
		await pending;
	});

	it("accepts a write again once an earlier one completes", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const redis = new StallingRedis();
		const cache = new RedisBlobCache(redis.client, "t1", { maxInFlight: 1 });
		const first = cache.set(sha(1), new Uint8Array(8));
		await cache.set(sha(2), new Uint8Array(8)); // dropped
		redis.releaseAll();
		await first;
		expect(cache.stats.inFlight).toBe(0);
		const second = cache.set(sha(3), new Uint8Array(8));
		expect(redis.started).toEqual([
			`vfs:t1:blob:${Buffer.from(sha(1)).toString("hex")}`,
			`vfs:t1:blob:${Buffer.from(sha(3)).toString("hex")}`,
		]);
		redis.releaseAll();
		await second;
	});

	it("logs redis_blob_set_dropped with tenantId and the running drop count", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const redis = new StallingRedis();
		const cache = new RedisBlobCache(redis.client, "t1", { maxInFlight: 1 });
		const first = cache.set(sha(1), new Uint8Array(8));
		await cache.set(sha(2), new Uint8Array(8));
		expect(warn).toHaveBeenCalledTimes(1);
		expect(JSON.parse(warn.mock.calls[0]?.[0] as string)).toEqual({
			event: "redis_blob_set_dropped",
			tenantId: "t1",
			reason: "max_in_flight",
			dropped: 1,
			inFlight: 1,
			inFlightBytes: 8,
		});
		redis.releaseAll();
		await first;
	});

	it("releases the in-flight slot when the write throws", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const throwing = {
			async set(): Promise<never> {
				throw new Error("redis set failed");
			},
		} as unknown as Redis;
		const cache = new RedisBlobCache(throwing, "t1", { maxInFlight: 1 });
		await cache.set(sha(1), new Uint8Array(8));
		expect(cache.stats).toEqual({ inFlight: 0, inFlightBytes: 0, dropped: 0 });
	});
});

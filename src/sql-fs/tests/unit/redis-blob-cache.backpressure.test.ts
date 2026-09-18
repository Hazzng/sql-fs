/**
 * #167: `RedisBlobCache.set` is called fire-and-forget from the Postgres dialect
 * with no cap, so a stalled Redis grew an unbounded queue of multi-MiB writes.
 * These tests pin the bounded in-flight semaphore and the data-plane breaker
 * short-circuit.
 */

import type { Redis } from "ioredis";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RedisCircuitBreaker } from "../../../redis/circuit-breaker.js";
import { RedisBlobCache } from "../../redis-blob-cache.js";

/** Redis whose `set` never settles until released, so writes stay in flight. */
class StallingRedis {
	readonly started: string[] = [];
	readonly getKeys: string[] = [];
	readonly unlinked: string[] = [];
	#release: Array<() => void> = [];
	failGet = false;

	async set(key: string): Promise<"OK"> {
		this.started.push(key);
		await new Promise<void>((resolve) => this.#release.push(resolve));
		return "OK";
	}

	async getBuffer(key: string): Promise<Buffer | null> {
		this.getKeys.push(key);
		if (this.failGet) throw new Error("redis get failed");
		return null;
	}

	async mgetBuffer(...keys: string[]): Promise<Array<Buffer | null>> {
		this.getKeys.push(...keys);
		if (this.failGet) throw new Error("redis mget failed");
		return keys.map(() => null);
	}

	async unlink(...keys: string[]): Promise<number> {
		this.unlinked.push(...keys);
		return keys.length;
	}

	releaseAll(): void {
		for (const r of this.#release) r();
		this.#release = [];
	}

	get client(): Redis {
		return this as unknown as Redis;
	}
}

const sha = (byte: number): Uint8Array => new Uint8Array(32).fill(byte);

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

	it("logs redis_blob_set_dropped with the running drop count", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const redis = new StallingRedis();
		const cache = new RedisBlobCache(redis.client, "t1", { maxInFlight: 1 });
		const first = cache.set(sha(1), new Uint8Array(8));
		await cache.set(sha(2), new Uint8Array(8));
		expect(warn).toHaveBeenCalledTimes(1);
		expect(JSON.parse(warn.mock.calls[0]?.[0] as string)).toEqual({
			event: "redis_blob_set_dropped",
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

	// Regression guard, not a fix-proving test: the breaker is optional, and a
	// cache constructed without one must behave exactly as it did before #167.
	it("leaves Redis reachable when no breaker is supplied", async () => {
		const redis = new StallingRedis();
		const cache = new RedisBlobCache(redis.client, "t1");
		expect(await cache.get(sha(1))).toBeNull();
		expect(redis.getKeys).toEqual([`vfs:t1:blob:${Buffer.from(sha(1)).toString("hex")}`]);
	});
});

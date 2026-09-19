// #167 M6: `blobCacheFactory` builds one RedisBlobCache per TENANT over the one
// shared data connection, so instance-local counters let T tenants put T x the
// cap on a single socket. The budget belongs to the connection.
import { afterEach, describe, expect, it, vi } from "vitest";
import { RedisBlobCache } from "../../redis-blob-cache.js";
import { StallingRedis, sha } from "./redis-blob-cache.backpressure-helpers.js";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("RedisBlobCache backfill cap across tenants", () => {
	it("shares the in-flight count cap between caches on the same client", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const redis = new StallingRedis();
		const tenantA = new RedisBlobCache(redis.client, "a", { maxInFlight: 2 });
		const tenantB = new RedisBlobCache(redis.client, "b", { maxInFlight: 2 });
		const pending = [tenantA.set(sha(1), new Uint8Array(8)), tenantA.set(sha(2), new Uint8Array(8))];
		await tenantB.set(sha(3), new Uint8Array(8)); // a different tenant, same socket → dropped
		expect(redis.started).toHaveLength(2);
		expect(tenantB.stats.dropped).toBe(1);
		redis.releaseAll();
		await Promise.all(pending);
	});

	it("shares the in-flight byte cap between caches on the same client", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const redis = new StallingRedis();
		const tenantA = new RedisBlobCache(redis.client, "a", { maxInFlight: 100, maxInFlightBytes: 1000 });
		const tenantB = new RedisBlobCache(redis.client, "b", { maxInFlight: 100, maxInFlightBytes: 1000 });
		const pending = tenantA.set(sha(1), new Uint8Array(900));
		await tenantB.set(sha(2), new Uint8Array(200)); // 900 + 200 > 1000 → dropped
		expect(redis.started).toHaveLength(1);
		expect(tenantB.stats.dropped).toBe(1);
		redis.releaseAll();
		await pending;
	});

	it("keeps caches on DIFFERENT clients independent", async () => {
		const redisA = new StallingRedis();
		const redisB = new StallingRedis();
		const tenantA = new RedisBlobCache(redisA.client, "a", { maxInFlight: 1 });
		const tenantB = new RedisBlobCache(redisB.client, "b", { maxInFlight: 1 });
		const pending = [tenantA.set(sha(1), new Uint8Array(8)), tenantB.set(sha(2), new Uint8Array(8))];
		expect(redisA.started).toHaveLength(1);
		expect(redisB.started).toHaveLength(1);
		redisA.releaseAll();
		redisB.releaseAll();
		await Promise.all(pending);
	});

	// The shared counters are only one budget if every tenant checks the same
	// cap: a larger per-instance limit would otherwise admit writes past the cap
	// the other tenants enforce. Production builds every tenant cache from one
	// shared options object, so pinning the limits per connection keeps
	// production identical and conflicting limits fail fast as programmer error.
	it("throws when a second cache on the same client passes a different maxInFlight", () => {
		const redis = new StallingRedis();
		new RedisBlobCache(redis.client, "a", { maxInFlight: 2 });
		expect(() => new RedisBlobCache(redis.client, "b", { maxInFlight: 3 })).toThrow(/conflicting backfill limits/);
	});

	it("throws when a second cache on the same client passes different maxInFlightBytes", () => {
		const redis = new StallingRedis();
		new RedisBlobCache(redis.client, "a", { maxInFlightBytes: 1000 });
		expect(() => new RedisBlobCache(redis.client, "b", { maxInFlightBytes: 2000 })).toThrow(
			/conflicting backfill limits/,
		);
	});

	it("accepts a second cache on the same client with identical limits", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const redis = new StallingRedis();
		const tenantA = new RedisBlobCache(redis.client, "a", { maxInFlight: 1 });
		const tenantB = new RedisBlobCache(redis.client, "b", { maxInFlight: 1 });
		const pending = tenantA.set(sha(1), new Uint8Array(8));
		await tenantB.set(sha(2), new Uint8Array(8)); // same cap, same socket → still dropped
		expect(redis.started).toHaveLength(1);
		expect(tenantB.stats.dropped).toBe(1);
		redis.releaseAll();
		await pending;
	});

	// The drop-log throttle is connection-wide: a T-tenant storm must not emit
	// T logs per interval, and the event carries the shared total plus the
	// tenant that triggered that log line so it stays greppable.
	it("logs a multi-tenant drop storm once per interval with the shared total", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		let now = 1_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const redis = new StallingRedis();
		const tenantA = new RedisBlobCache(redis.client, "a", { maxInFlight: 1 });
		const tenantB = new RedisBlobCache(redis.client, "b", { maxInFlight: 1 });
		const pending = tenantA.set(sha(1), new Uint8Array(8)); // occupies the one slot
		await tenantA.set(sha(2), new Uint8Array(8)); // drop 1 → logs
		await tenantB.set(sha(3), new Uint8Array(8)); // drop 2, same interval → throttled
		expect(warn).toHaveBeenCalledTimes(1);
		expect(JSON.parse(warn.mock.calls[0]?.[0] as string)).toEqual({
			event: "redis_blob_set_dropped",
			tenantId: "a",
			reason: "max_in_flight",
			dropped: 1,
			inFlight: 1,
			inFlightBytes: 8,
		});
		expect(tenantA.stats.dropped).toBe(1);
		expect(tenantB.stats.dropped).toBe(1);
		now += 6_000; // past the 5s throttle
		await tenantB.set(sha(4), new Uint8Array(8)); // drop 3 → logs the shared total
		expect(warn).toHaveBeenCalledTimes(2);
		expect(JSON.parse(warn.mock.calls[1]?.[0] as string)).toEqual({
			event: "redis_blob_set_dropped",
			tenantId: "b",
			reason: "max_in_flight",
			dropped: 3,
			inFlight: 1,
			inFlightBytes: 8,
		});
		expect(tenantB.stats.dropped).toBe(2);
		redis.releaseAll();
		await pending;
	});
});

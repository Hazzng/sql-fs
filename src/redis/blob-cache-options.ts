import type { RedisBlobCacheOptions } from "../sql-fs/redis-blob-cache.js";
import { getRedisCircuitBreaker } from "./circuit-breaker.js";
import { parseNonNegativeInt, parsePositiveInt } from "./config.js";

export function loadRedisBlobCacheOptions(): RedisBlobCacheOptions {
	return {
		ttlMs: parseNonNegativeInt("REDIS_BLOB_CACHE_TTL_MS", 24 * 60 * 60 * 1000),
		maxBytes: parseNonNegativeInt("REDIS_BLOB_MAX_BYTES", 8 * 1024 * 1024),
		maxInFlight: parsePositiveInt("REDIS_BLOB_SET_MAX_IN_FLIGHT", 32),
		maxInFlightBytes: parsePositiveInt("REDIS_BLOB_SET_MAX_IN_FLIGHT_BYTES", 32 * 1024 * 1024),
		breaker: getRedisCircuitBreaker("data"),
	};
}

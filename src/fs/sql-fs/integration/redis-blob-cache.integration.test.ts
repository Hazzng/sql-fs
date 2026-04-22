/**
 * Integration tests for the Redis-backed blob cache wired into PostgresDialect.
 *
 * Skipped when DATABASE_URL or REDIS_URL is not set so CI without a Redis
 * instance still passes.
 */

import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresDialect } from "../dialects/postgres.js";
import { RedisBlobCache } from "../redis-blob-cache.js";

const SKIP = !process.env.DATABASE_URL || !process.env.REDIS_URL;

describe.skipIf(SKIP)("PostgresDialect + RedisBlobCache", () => {
	const redis = new Redis(process.env.REDIS_URL!, { lazyConnect: true, maxRetriesPerRequest: 1 });
	const cache = new RedisBlobCache(redis);
	const dialect = new PostgresDialect(process.env.DATABASE_URL!, cache);
	const insertedSha256s: Uint8Array[] = [];

	beforeAll(async () => {
		await redis.connect();
		await dialect.connect();
	});

	afterAll(async () => {
		// Drop the PG rows we inserted and their cached entries.
		for (const sha256 of insertedSha256s) {
			await dialect.transaction(async (tx) => {
				await tx`DELETE FROM blobs WHERE sha256 = ${sha256}`;
			});
			await redis.del(RedisBlobCache.key(sha256));
		}
		await dialect.disconnect();
		await redis.quit();
	});

	it("upsertBlob populates Redis with the correct bytes", async () => {
		const sha256 = new Uint8Array(32).fill(0xa1);
		const data = new TextEncoder().encode("cached hello");
		insertedSha256s.push(sha256);

		await dialect.transaction(async (tx) => {
			await dialect.upsertBlob(tx, sha256, data);
		});

		const cached = await redis.getBuffer(RedisBlobCache.key(sha256));
		expect(cached).not.toBeNull();
		expect(Uint8Array.from(cached as Buffer)).toEqual(data);
	});

	it("getBlob backfills Redis after a cache miss", async () => {
		const sha256 = new Uint8Array(32).fill(0xa2);
		const data = new TextEncoder().encode("backfill me");
		insertedSha256s.push(sha256);

		// Seed PG only, then drop the Redis entry to force a miss.
		await dialect.transaction(async (tx) => {
			await dialect.upsertBlob(tx, sha256, data);
		});
		await redis.del(RedisBlobCache.key(sha256));
		expect(await redis.getBuffer(RedisBlobCache.key(sha256))).toBeNull();

		const result = await dialect.transaction(async (tx) => dialect.getBlob(tx, sha256));
		expect(result).not.toBeNull();
		expect(result).toEqual(data);

		const cached = await redis.getBuffer(RedisBlobCache.key(sha256));
		expect(cached).not.toBeNull();
		expect(Uint8Array.from(cached as Buffer)).toEqual(data);
	});

	it("does not cache blobs larger than maxBytes", async () => {
		const smallCache = new RedisBlobCache(redis, { maxBytes: 4 });
		const smallDialect = new PostgresDialect(process.env.DATABASE_URL!, smallCache);
		await smallDialect.connect();
		try {
			const sha256 = new Uint8Array(32).fill(0xa3);
			const data = new Uint8Array([1, 2, 3, 4, 5, 6]);
			insertedSha256s.push(sha256);

			await smallDialect.transaction(async (tx) => {
				await smallDialect.upsertBlob(tx, sha256, data);
			});

			const cached = await redis.getBuffer(RedisBlobCache.key(sha256));
			expect(cached).toBeNull();

			// But PG still has it and getBlob returns from PG (and won't cache it).
			const result = await smallDialect.transaction(async (tx) => smallDialect.getBlob(tx, sha256));
			expect(result).toEqual(data);
			expect(await redis.getBuffer(RedisBlobCache.key(sha256))).toBeNull();
		} finally {
			await smallDialect.disconnect();
		}
	});

	it("getBlob falls back to PG when the cache client errors", async () => {
		// Build a brittle Redis client pointed at an unreachable host to force errors.
		const badRedis = new Redis({
			host: "127.0.0.1",
			port: 1, // unused port → connection refused
			lazyConnect: true,
			maxRetriesPerRequest: 0,
			retryStrategy: () => null,
			connectTimeout: 200,
		});
		badRedis.on("error", () => {
			/* swallow — we expect failure */
		});
		const brittleCache = new RedisBlobCache(badRedis);
		const brittleDialect = new PostgresDialect(process.env.DATABASE_URL!, brittleCache);
		await brittleDialect.connect();
		try {
			const sha256 = new Uint8Array(32).fill(0xa4);
			const data = new TextEncoder().encode("pg fallback");
			insertedSha256s.push(sha256);

			// Upsert the blob via the good cache so PG has the row.
			await dialect.transaction(async (tx) => {
				await dialect.upsertBlob(tx, sha256, data);
			});

			// Now read through the brittle cache — it should fall back to PG without throwing.
			const result = await brittleDialect.transaction(async (tx) => brittleDialect.getBlob(tx, sha256));
			expect(result).toEqual(data);
		} finally {
			await brittleDialect.disconnect();
			badRedis.disconnect();
		}
	});
});

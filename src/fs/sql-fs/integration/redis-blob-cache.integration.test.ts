/**
 * Integration tests for the Redis-backed blob cache wired into PostgresDialect.
 *
 * Skipped when DATABASE_URL or REDIS_URL is not set so CI without a Redis
 * instance still passes.
 */

import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PostgresDialect } from "../dialects/postgres.js";
import { RedisBlobCache } from "../redis-blob-cache.js";

const SKIP = !process.env.DATABASE_URL || !process.env.REDIS_URL;

const DEFAULT_TENANT = "default";

function blobKey(sha256: Uint8Array, tenantId = DEFAULT_TENANT): string {
	return `vfs:${tenantId}:blob:${Buffer.from(sha256).toString("hex")}`;
}

/**
 * Poll Redis for a blob-cache key until it materializes. Cache writes are
 * fire-and-forget inside the dialect (so the PG advisory lock releases
 * immediately on commit), so tests cannot assume the SET has completed by the
 * time `dialect.transaction(...)` resolves.
 */
async function waitForCachedBlob(redis: Redis, sha256: Uint8Array, tenantId = DEFAULT_TENANT): Promise<Buffer> {
	return await vi.waitFor(
		async () => {
			const buf = await redis.getBuffer(blobKey(sha256, tenantId));
			if (buf === null) throw new Error("cache key not yet populated");
			return buf;
		},
		{ timeout: 2_000, interval: 20 },
	);
}

describe.skipIf(SKIP)("PostgresDialect + RedisBlobCache", () => {
	const redis = new Redis(process.env.REDIS_URL!, { lazyConnect: true, maxRetriesPerRequest: 1 });
	const cache = new RedisBlobCache(redis, DEFAULT_TENANT);
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
			await redis.del(blobKey(sha256));
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

		const cached = await waitForCachedBlob(redis, sha256);
		expect(Uint8Array.from(cached)).toEqual(data);
	});

	it("getBlob backfills Redis after a cache miss", async () => {
		const sha256 = new Uint8Array(32).fill(0xa2);
		const data = new TextEncoder().encode("backfill me");
		insertedSha256s.push(sha256);

		// Seed PG only, then drop the Redis entry to force a miss.
		await dialect.transaction(async (tx) => {
			await dialect.upsertBlob(tx, sha256, data);
		});
		// Wait for the write-through cache to populate from the seed upsert
		// before deleting it, otherwise a late-arriving fire-and-forget SET
		// could repopulate the key and mask the miss we want to test.
		await waitForCachedBlob(redis, sha256);
		await redis.del(blobKey(sha256));
		expect(await redis.getBuffer(blobKey(sha256))).toBeNull();

		const result = await dialect.transaction(async (tx) => dialect.getBlob(tx, sha256));
		expect(result).not.toBeNull();
		expect(result).toEqual(data);

		const cached = await waitForCachedBlob(redis, sha256);
		expect(Uint8Array.from(cached)).toEqual(data);
	});

	it("does not cache blobs larger than maxBytes", async () => {
		const smallCache = new RedisBlobCache(redis, DEFAULT_TENANT, { maxBytes: 4 });
		const smallDialect = new PostgresDialect(process.env.DATABASE_URL!, smallCache);
		await smallDialect.connect();
		try {
			const sha256 = new Uint8Array(32).fill(0xa3);
			const data = new Uint8Array([1, 2, 3, 4, 5, 6]);
			insertedSha256s.push(sha256);

			await smallDialect.transaction(async (tx) => {
				await smallDialect.upsertBlob(tx, sha256, data);
			});

			const cached = await redis.getBuffer(blobKey(sha256));
			expect(cached).toBeNull();

			// But PG still has it and getBlob returns from PG (and won't cache it).
			const result = await smallDialect.transaction(async (tx) => smallDialect.getBlob(tx, sha256));
			expect(result).toEqual(data);
			expect(await redis.getBuffer(blobKey(sha256))).toBeNull();
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
		const brittleCache = new RedisBlobCache(badRedis, DEFAULT_TENANT);
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

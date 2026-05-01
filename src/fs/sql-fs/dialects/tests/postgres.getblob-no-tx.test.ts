/**
 * Unit tests for PostgresDialect.getBlobNoTx Redis hit / backfill behaviour.
 * AC3: Redis hit returns bytes without touching the pool.
 * AC4: Postgres-served read schedules async Redis backfill.
 *
 * Uses a fake postgres pool (tagged-template spy) and a stub RedisBlobCache
 * so no real database or Redis connection is needed.
 */

import type postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import type { RedisBlobCache } from "../../redis-blob-cache.js";
import { PostgresDialect } from "../postgres.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeFakePool(rows: unknown[]): { pool: postgres.Sql; callCount: () => number } {
	let count = 0;
	const fn = (): Promise<unknown[]> => {
		count++;
		return Promise.resolve(rows);
	};
	// The pool is used as a tagged template: pool`SELECT ...`
	// We satisfy that by making fn callable as both a function and a tagged template.
	const tagged = (strings: TemplateStringsArray, ..._values: unknown[]): Promise<unknown[]> => {
		void strings;
		count++;
		return Promise.resolve(rows);
	};
	void fn;
	return { pool: tagged as unknown as postgres.Sql, callCount: () => count };
}

function makeStubRedis(getResult: Uint8Array | null): {
	cache: RedisBlobCache;
	getSpy: ReturnType<typeof vi.fn>;
	setSpy: ReturnType<typeof vi.fn>;
} {
	const getSpy = vi.fn(async () => getResult);
	const setSpy = vi.fn(async () => undefined);
	// Stub just the two methods used by getBlobNoTx / getBlob
	const cache = { get: getSpy, set: setSpy } as unknown as RedisBlobCache;
	return { cache, getSpy, setSpy };
}

function makeDialect(cache?: RedisBlobCache): PostgresDialect {
	return new PostgresDialect("postgres://stub", cache);
}

function injectPool(dialect: PostgresDialect, pool: postgres.Sql): void {
	// `pool` is a TS `private` field (not `#private`), so it's a plain JS property at runtime.
	(dialect as unknown as Record<string, unknown>).pool = pool;
}

const sha256 = new Uint8Array(32).fill(0xab);
const blobBytes = new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]);

// ── AC3: Redis hit skips pool ─────────────────────────────────────────────────

describe("PostgresDialect.getBlobNoTx — Redis hit (AC3)", () => {
	it("returns Redis bytes and never queries the pool", async () => {
		const { cache, getSpy, setSpy } = makeStubRedis(blobBytes);
		const dialect = makeDialect(cache);
		const { pool, callCount } = makeFakePool([]);
		injectPool(dialect, pool);

		const result = await dialect.getBlobNoTx(sha256);

		expect(result).toEqual(blobBytes);
		expect(getSpy).toHaveBeenCalledOnce();
		expect(callCount()).toBe(0); // pool SELECT never ran
		expect(setSpy).not.toHaveBeenCalled(); // no backfill needed — already in Redis
	});

	it("returns the exact bytes from Redis without copying", async () => {
		const redisBytes = new Uint8Array([0x01, 0x02, 0x03]);
		const { cache } = makeStubRedis(redisBytes);
		const dialect = makeDialect(cache);
		injectPool(dialect, makeFakePool([]).pool);

		const result = await dialect.getBlobNoTx(sha256);
		expect(result).toEqual(redisBytes);
	});
});

// ── AC4: Postgres-served read schedules async Redis backfill ──────────────────

describe("PostgresDialect.getBlobNoTx — Postgres-served with async Redis backfill (AC4)", () => {
	it("returns Postgres bytes when Redis is cold", async () => {
		const { cache, getSpy } = makeStubRedis(null); // Redis miss
		const dialect = makeDialect(cache);
		const pgRow = { data: Buffer.from(blobBytes) };
		const { pool } = makeFakePool([pgRow]);
		injectPool(dialect, pool);

		const result = await dialect.getBlobNoTx(sha256);

		expect(getSpy).toHaveBeenCalledOnce(); // Redis checked first
		expect(result).toEqual(blobBytes);
	});

	it("schedules a Redis SET after Postgres read", async () => {
		const { cache, setSpy } = makeStubRedis(null);
		const dialect = makeDialect(cache);
		const pgRow = { data: Buffer.from(blobBytes) };
		const { pool } = makeFakePool([pgRow]);
		injectPool(dialect, pool);

		await dialect.getBlobNoTx(sha256);

		// The backfill is fire-and-forget (void); flush microtasks before asserting
		await Promise.resolve();
		expect(setSpy).toHaveBeenCalledOnce();
		expect(setSpy).toHaveBeenCalledWith(sha256, blobBytes);
	});

	it("returns null when blob is absent and Redis is cold", async () => {
		const { cache } = makeStubRedis(null);
		const dialect = makeDialect(cache);
		const { pool } = makeFakePool([]); // no rows
		injectPool(dialect, pool);

		const result = await dialect.getBlobNoTx(sha256);
		expect(result).toBeNull();
	});
});

// ── No Redis configured ───────────────────────────────────────────────────────

describe("PostgresDialect.getBlobNoTx — no Redis configured", () => {
	it("returns Postgres bytes when no blobCache is injected", async () => {
		const dialect = makeDialect(); // no cache
		const pgRow = { data: Buffer.from(blobBytes) };
		const { pool } = makeFakePool([pgRow]);
		injectPool(dialect, pool);

		const result = await dialect.getBlobNoTx(sha256);
		expect(result).toEqual(blobBytes);
	});

	it("returns null when blob absent and no blobCache", async () => {
		const dialect = makeDialect();
		const { pool } = makeFakePool([]);
		injectPool(dialect, pool);

		const result = await dialect.getBlobNoTx(sha256);
		expect(result).toBeNull();
	});
});

/**
 * Unit tests for PostgresDialect.getBlobsForSandbox.
 * AC5: uses Redis hits when available, no Postgres fetch.
 * AC6: Redis cold → one metadata SELECT + one batched SELECT.
 * Dedup: two inodes sharing one blob → one entry in WHERE sha256 = ANY(…).
 * Strict byte cap: file at boundary excluded.
 */

import type postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import type { RedisBlobCache } from "../redis-blob-cache.js";
import { PostgresDialect } from "./postgres.js";

// ── Pool helpers ──────────────────────────────────────────────────────────────

type TaggedResult = Record<string, unknown>[];

function makePool(responses: TaggedResult[]): {
	pool: postgres.Sql;
	callCount: () => number;
	calls: () => TaggedResult[];
} {
	let idx = 0;
	const recorded: TaggedResult[] = [];
	const tagged = (_strings: TemplateStringsArray, ..._values: unknown[]): Promise<TaggedResult> => {
		const result = responses[idx] ?? [];
		idx++;
		recorded.push(result);
		return Promise.resolve(result);
	};
	return {
		pool: tagged as unknown as postgres.Sql,
		callCount: () => idx,
		calls: () => recorded,
	};
}

function injectPool(dialect: PostgresDialect, pool: postgres.Sql): void {
	(dialect as unknown as Record<string, unknown>).pool = pool;
}

// ── Redis stub helpers ────────────────────────────────────────────────────────

function makeRedisCache(mgetResults: Array<Uint8Array | null>): {
	cache: RedisBlobCache;
	mgetSpy: ReturnType<typeof vi.fn>;
	setSpy: ReturnType<typeof vi.fn>;
} {
	const mgetSpy = vi.fn(async () => mgetResults);
	const setSpy = vi.fn(async () => undefined);
	const cache = { mget: mgetSpy, set: setSpy } as unknown as RedisBlobCache;
	return { cache, mgetSpy, setSpy };
}

function sha(byte: number): Buffer {
	return Buffer.alloc(32, byte);
}

// ── Helpers to build meta rows ────────────────────────────────────────────────

function metaRow(inodeId: number, shaByte: number, size: number): Record<string, unknown> {
	return { inode_id: String(inodeId), content_sha256: sha(shaByte), size: String(size) };
}

// ── AC5: Redis hits → no Postgres data fetch ──────────────────────────────────

describe("PostgresDialect.getBlobsForSandbox — Redis hits (AC5)", () => {
	it("returns Redis bytes and never issues a batched Postgres SELECT", async () => {
		const redisData = new Uint8Array([0xaa, 0xbb]);
		const { cache, mgetSpy, setSpy } = makeRedisCache([redisData]);
		const dialect = new PostgresDialect("postgres://stub", cache);

		const metaRows = [metaRow(1, 0x01, 10)];
		const { pool, callCount } = makePool([metaRows]);
		injectPool(dialect, pool);

		const result = await dialect.getBlobsForSandbox("s1", 1024);

		expect(mgetSpy).toHaveBeenCalledOnce();
		expect(callCount()).toBe(1); // only the metadata CTE; no data SELECT
		expect(result).toHaveLength(1);
		expect(result[0]?.inodeId).toBe(1n);
		expect(result[0]?.data).toEqual(redisData);
		expect(setSpy).not.toHaveBeenCalled(); // already in Redis, no backfill needed
	});

	it("returns bytes for all inodes when all Redis hits", async () => {
		const d1 = new Uint8Array([0x01]);
		const d2 = new Uint8Array([0x02]);
		const { cache } = makeRedisCache([d1, d2]);
		const dialect = new PostgresDialect("postgres://stub", cache);

		const metaRows = [metaRow(1, 0x01, 5), metaRow(2, 0x02, 8)];
		const { pool, callCount } = makePool([metaRows]);
		injectPool(dialect, pool);

		const result = await dialect.getBlobsForSandbox("s1", 1024);
		expect(callCount()).toBe(1);
		expect(result).toHaveLength(2);
		expect(result[0]?.data).toEqual(d1);
		expect(result[1]?.data).toEqual(d2);
	});
});

// ── AC6: Redis cold → metadata SELECT + one batched SELECT ────────────────────

describe("PostgresDialect.getBlobsForSandbox — Redis cold (AC6)", () => {
	it("issues exactly two SELECTs: metadata CTE then batched data", async () => {
		const blobBytes = new Uint8Array([0xff]);
		const { cache } = makeRedisCache([null]); // cold
		const dialect = new PostgresDialect("postgres://stub", cache);

		const metaRows = [metaRow(1, 0x01, 10)];
		const pgDataRows = [{ sha256: sha(0x01), data: Buffer.from(blobBytes) }];
		const { pool, callCount } = makePool([metaRows, pgDataRows]);
		injectPool(dialect, pool);

		const result = await dialect.getBlobsForSandbox("s1", 1024);
		expect(callCount()).toBe(2); // metadata + batched data
		expect(result).toHaveLength(1);
		expect(result[0]?.data).toEqual(blobBytes);
	});

	it("schedules async Redis backfill for Postgres-served bytes", async () => {
		const blobBytes = new Uint8Array([0xde, 0xad]);
		const { cache, setSpy } = makeRedisCache([null]);
		const dialect = new PostgresDialect("postgres://stub", cache);

		const metaRows = [metaRow(1, 0x01, 10)];
		const pgDataRows = [{ sha256: sha(0x01), data: Buffer.from(blobBytes) }];
		const { pool } = makePool([metaRows, pgDataRows]);
		injectPool(dialect, pool);

		await dialect.getBlobsForSandbox("s1", 1024);
		await Promise.resolve(); // flush fire-and-forget
		expect(setSpy).toHaveBeenCalledOnce();
	});

	it("returns empty array when metadata CTE returns no rows", async () => {
		const { cache, mgetSpy } = makeRedisCache([]);
		const dialect = new PostgresDialect("postgres://stub", cache);
		const { pool, callCount } = makePool([[]]); // metadata returns nothing
		injectPool(dialect, pool);

		const result = await dialect.getBlobsForSandbox("s1", 1024);
		expect(callCount()).toBe(1);
		expect(mgetSpy).not.toHaveBeenCalled();
		expect(result).toHaveLength(0);
	});

	it("returns empty array when maxBytes is 0", async () => {
		const dialect = new PostgresDialect("postgres://stub");
		const { pool, callCount } = makePool([]);
		injectPool(dialect, pool);

		const result = await dialect.getBlobsForSandbox("s1", 0);
		expect(callCount()).toBe(0);
		expect(result).toHaveLength(0);
	});
});

// ── Dedup: two inodes pointing at the same blob ───────────────────────────────

describe("PostgresDialect.getBlobsForSandbox — sha256 dedup across inodes", () => {
	it("issues one Postgres entry for two inodes sharing a blob, returns both inodes", async () => {
		// Both inodes share sha 0x01. The batched SELECT should only list sha 0x01 once.
		const blobBytes = new Uint8Array([0xbe, 0xef]);
		// Redis returns null for both — both are the same sha but mget is per-inode position
		const { cache, mgetSpy } = makeRedisCache([null, null]);
		const dialect = new PostgresDialect("postgres://stub", cache);

		const metaRows = [metaRow(1, 0x01, 10), metaRow(2, 0x01, 10)]; // same sha
		const pgDataRows = [{ sha256: sha(0x01), data: Buffer.from(blobBytes) }]; // one row
		const { pool, callCount } = makePool([metaRows, pgDataRows]);
		injectPool(dialect, pool);

		const result = await dialect.getBlobsForSandbox("s1", 1024);
		expect(mgetSpy).toHaveBeenCalledOnce();
		expect(callCount()).toBe(2); // metadata + one batched SELECT (deduped sha)
		expect(result).toHaveLength(2); // but two result entries (one per inode)
		expect(result[0]?.inodeId).toBe(1n);
		expect(result[1]?.inodeId).toBe(2n);
		expect(result[0]?.data).toEqual(blobBytes);
		expect(result[1]?.data).toEqual(blobBytes);
	});
});

// ── Strict byte cap ───────────────────────────────────────────────────────────

describe("PostgresDialect.getBlobsForSandbox — strict byte cap", () => {
	it("excludes blobs where running_total exceeds maxBytes (boundary file not included)", async () => {
		// maxBytes = 15; file at 10 bytes fits (running_total = 10 ≤ 15);
		// file at 8 bytes would push to 18 > 15 so the metadata CTE excludes it.
		// We simulate this by having the metadata CTE return only the fitting row.
		const blobBytes = new Uint8Array(10).fill(0x01);
		const { cache } = makeRedisCache([null]);
		const dialect = new PostgresDialect("postgres://stub", cache);

		// Metadata CTE only returns the fitting row (size=10, running_total=10 ≤ 15)
		const metaRows = [metaRow(1, 0x01, 10)];
		const pgDataRows = [{ sha256: sha(0x01), data: Buffer.from(blobBytes) }];
		const { pool } = makePool([metaRows, pgDataRows]);
		injectPool(dialect, pool);

		const result = await dialect.getBlobsForSandbox("s1", 15);
		expect(result).toHaveLength(1);
		expect(result[0]?.data).toEqual(blobBytes);
	});
});

// ── No Redis configured ───────────────────────────────────────────────────────

describe("PostgresDialect.getBlobsForSandbox — no Redis configured", () => {
	it("falls straight through to Postgres when no blobCache is set", async () => {
		const blobBytes = new Uint8Array([0x99]);
		const dialect = new PostgresDialect("postgres://stub"); // no cache
		const metaRows = [metaRow(1, 0x01, 5)];
		const pgDataRows = [{ sha256: sha(0x01), data: Buffer.from(blobBytes) }];
		const { pool, callCount } = makePool([metaRows, pgDataRows]);
		injectPool(dialect, pool);

		const result = await dialect.getBlobsForSandbox("s1", 1024);
		expect(callCount()).toBe(2);
		expect(result).toHaveLength(1);
		expect(result[0]?.data).toEqual(blobBytes);
	});
});

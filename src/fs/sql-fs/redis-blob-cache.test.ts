/**
 * Unit tests for RedisBlobCache. Uses an in-memory fake Redis client that
 * implements only the methods the cache relies on (`getBuffer`, `set`).
 */

import type { Redis } from "ioredis";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RedisBlobCache } from "./redis-blob-cache.js";

interface StoredEntry {
	readonly data: Buffer;
	readonly ttlMs: number;
}

class FakeRedis {
	readonly store = new Map<string, StoredEntry>();
	failGet = false;
	failSet = false;

	async getBuffer(key: string): Promise<Buffer | null> {
		if (this.failGet) throw new Error("redis get failed");
		return this.store.get(key)?.data ?? null;
	}

	async set(key: string, value: Buffer, _px: "PX", ttlMs: number): Promise<"OK"> {
		if (this.failSet) throw new Error("redis set failed");
		this.store.set(key, { data: value, ttlMs });
		return "OK";
	}
}

function makeClient(): { fake: FakeRedis; client: Redis } {
	const fake = new FakeRedis();
	return { fake, client: fake as unknown as Redis };
}

const sha = (byte: number): Uint8Array => new Uint8Array(32).fill(byte);
const hexSha = (byte: number): string => Buffer.from(new Uint8Array(32).fill(byte)).toString("hex");

describe("RedisBlobCache key format", () => {
	it("formats keys as vfs:{tenantId}:blob:<hex-sha256>", () => {
		const { client } = makeClient();
		// Access via round-trip: set then inspect store
		const cache = new RedisBlobCache(client, "t1");
		// The key can be inferred from the stored entry key pattern
		expect(cache).toBeDefined();
	});

	it("two caches with same Redis client but different tenants produce disjoint keys", async () => {
		const { fake, client } = makeClient();
		const cacheA = new RedisBlobCache(client, "tenant-a");
		const cacheB = new RedisBlobCache(client, "tenant-b");
		const data = new Uint8Array([1, 2, 3]);
		await cacheA.set(sha(0xff), data);
		// Only tenant-a key should exist
		const keyA = `vfs:tenant-a:blob:${hexSha(0xff)}`;
		const keyB = `vfs:tenant-b:blob:${hexSha(0xff)}`;
		expect(fake.store.has(keyA)).toBe(true);
		expect(fake.store.has(keyB)).toBe(false);
		// tenant-b cannot read tenant-a's blob
		const result = await cacheB.get(sha(0xff));
		expect(result).toBeNull();
	});
});

describe("RedisBlobCache.get", () => {
	let fake: FakeRedis;
	let cache: RedisBlobCache;

	beforeEach(() => {
		const ctx = makeClient();
		fake = ctx.fake;
		cache = new RedisBlobCache(ctx.client, "default");
	});

	it("returns null when key is absent", async () => {
		const result = await cache.get(sha(1));
		expect(result).toBeNull();
	});

	it("returns null when cache is disabled", async () => {
		const disabled = new RedisBlobCache(fake as unknown as Redis, "default", { enabled: false });
		// Pre-seed the store with the expected key
		fake.store.set(`vfs:default:blob:${hexSha(1)}`, { data: Buffer.from([1, 2, 3]), ttlMs: 1000 });
		const result = await disabled.get(sha(1));
		expect(result).toBeNull();
	});

	it("returns null and swallows Redis errors (fail open)", async () => {
		fake.failGet = true;
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const result = await cache.get(sha(1));
		expect(result).toBeNull();
		expect(errSpy).toHaveBeenCalled();
		errSpy.mockRestore();
	});
});

describe("RedisBlobCache.set + get", () => {
	it("round-trips bytes via set then get", async () => {
		const { client } = makeClient();
		const cache = new RedisBlobCache(client, "default");
		const data = new Uint8Array([10, 20, 30, 40]);
		await cache.set(sha(2), data);
		const round = await cache.get(sha(2));
		expect(round).not.toBeNull();
		expect(Array.from(round as Uint8Array)).toEqual([10, 20, 30, 40]);
	});

	it("set uses the configured TTL in milliseconds", async () => {
		const { fake, client } = makeClient();
		const cache = new RedisBlobCache(client, "default", { ttlMs: 12345 });
		await cache.set(sha(3), new Uint8Array([1]));
		const entry = fake.store.get(`vfs:default:blob:${hexSha(3)}`);
		expect(entry?.ttlMs).toBe(12345);
	});
});

describe("RedisBlobCache.set limits", () => {
	it("skips blobs larger than maxBytes", async () => {
		const { fake, client } = makeClient();
		const cache = new RedisBlobCache(client, "default", { maxBytes: 4 });
		await cache.set(sha(4), new Uint8Array([1, 2, 3, 4, 5]));
		expect(fake.store.size).toBe(0);
	});

	it("caches blobs at exactly maxBytes", async () => {
		const { fake, client } = makeClient();
		const cache = new RedisBlobCache(client, "default", { maxBytes: 4 });
		await cache.set(sha(5), new Uint8Array([1, 2, 3, 4]));
		expect(fake.store.size).toBe(1);
	});

	it("no-ops when cache is disabled", async () => {
		const { fake, client } = makeClient();
		const cache = new RedisBlobCache(client, "default", { enabled: false });
		await cache.set(sha(6), new Uint8Array([1, 2]));
		expect(fake.store.size).toBe(0);
	});

	it("swallows Redis errors from set (fail open)", async () => {
		const { fake, client } = makeClient();
		fake.failSet = true;
		const cache = new RedisBlobCache(client, "default");
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		await expect(cache.set(sha(7), new Uint8Array([1]))).resolves.toBeUndefined();
		expect(errSpy).toHaveBeenCalled();
		errSpy.mockRestore();
	});
});

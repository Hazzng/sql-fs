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

describe("RedisBlobCache.key", () => {
	it("formats keys as vfs:blob:<hex-sha256>", () => {
		const key = RedisBlobCache.key(new Uint8Array([0xab, 0xcd]));
		expect(key).toBe("vfs:blob:abcd");
	});
});

describe("RedisBlobCache.get", () => {
	let fake: FakeRedis;
	let cache: RedisBlobCache;

	beforeEach(() => {
		const ctx = makeClient();
		fake = ctx.fake;
		cache = new RedisBlobCache(ctx.client);
	});

	it("returns null when key is absent", async () => {
		const result = await cache.get(sha(1));
		expect(result).toBeNull();
	});

	it("returns null when cache is disabled", async () => {
		const disabled = new RedisBlobCache(fake as unknown as Redis, { enabled: false });
		fake.store.set(RedisBlobCache.key(sha(1)), { data: Buffer.from([1, 2, 3]), ttlMs: 1000 });
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
		const cache = new RedisBlobCache(client);
		const data = new Uint8Array([10, 20, 30, 40]);
		await cache.set(sha(2), data);
		const round = await cache.get(sha(2));
		expect(round).not.toBeNull();
		expect(Array.from(round as Uint8Array)).toEqual([10, 20, 30, 40]);
	});

	it("set uses the configured TTL in milliseconds", async () => {
		const { fake, client } = makeClient();
		const cache = new RedisBlobCache(client, { ttlMs: 12345 });
		await cache.set(sha(3), new Uint8Array([1]));
		const entry = fake.store.get(RedisBlobCache.key(sha(3)));
		expect(entry?.ttlMs).toBe(12345);
	});
});

describe("RedisBlobCache.set limits", () => {
	it("skips blobs larger than maxBytes", async () => {
		const { fake, client } = makeClient();
		const cache = new RedisBlobCache(client, { maxBytes: 4 });
		await cache.set(sha(4), new Uint8Array([1, 2, 3, 4, 5]));
		expect(fake.store.size).toBe(0);
	});

	it("caches blobs at exactly maxBytes", async () => {
		const { fake, client } = makeClient();
		const cache = new RedisBlobCache(client, { maxBytes: 4 });
		await cache.set(sha(5), new Uint8Array([1, 2, 3, 4]));
		expect(fake.store.size).toBe(1);
	});

	it("no-ops when cache is disabled", async () => {
		const { fake, client } = makeClient();
		const cache = new RedisBlobCache(client, { enabled: false });
		await cache.set(sha(6), new Uint8Array([1, 2]));
		expect(fake.store.size).toBe(0);
	});

	it("swallows Redis errors from set (fail open)", async () => {
		const { fake, client } = makeClient();
		fake.failSet = true;
		const cache = new RedisBlobCache(client);
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		await expect(cache.set(sha(7), new Uint8Array([1]))).resolves.toBeUndefined();
		expect(errSpy).toHaveBeenCalled();
		errSpy.mockRestore();
	});
});

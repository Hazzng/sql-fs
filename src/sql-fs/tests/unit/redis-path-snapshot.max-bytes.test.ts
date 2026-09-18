/**
 * RedisPathSnapshot — the REDIS_PATH_SNAPSHOT_MAX_BYTES ceiling. A sandbox
 * whose encoded snapshot is oversized (a large package install) publishes
 * nothing and falls back to a DB reload instead.
 */

import type { Redis } from "ioredis";
import { describe, expect, it, vi } from "vitest";
import { RedisPathSnapshot } from "../../redis-path-snapshot.js";
import { INODE_KIND, type PathCacheEntry } from "../../types.js";

function makeFakeRedis(): { redis: Redis; set: ReturnType<typeof vi.fn> } {
	const set = vi.fn(async () => "OK");
	const getBuffer = vi.fn(async () => null);
	return { redis: { set, getBuffer, del: vi.fn() } as unknown as Redis, set };
}

function makeCache(entries: number): Map<string, PathCacheEntry> {
	const cache = new Map<string, PathCacheEntry>();
	for (let i = 0; i < entries; i++) {
		cache.set(`/site-packages/pkg/module_${i}.py`, {
			inodeId: BigInt(i + 1),
			kind: INODE_KIND.FILE,
			mode: 0o644,
			size: 100,
			mtime: new Date(1_700_000_000_000),
			contentSha256: new Uint8Array(32).fill(0x11),
			symlinkTarget: null,
		});
	}
	return cache;
}

describe("RedisPathSnapshot.write — max bytes", () => {
	it("skips the publish when the encoded snapshot exceeds maxBytes", async () => {
		const { redis, set } = makeFakeRedis();
		const snapshot = new RedisPathSnapshot(redis, { maxBytes: 256 });

		await snapshot.write("default", "sb-1", 7, makeCache(50));

		expect(set).not.toHaveBeenCalled();
	});

	it("publishes when the encoded snapshot fits", async () => {
		const { redis, set } = makeFakeRedis();
		const snapshot = new RedisPathSnapshot(redis, { maxBytes: 1024 * 1024 });

		await snapshot.write("default", "sb-1", 7, makeCache(50));

		expect(set).toHaveBeenCalledTimes(1);
	});

	it("defaults to a 16 MB ceiling", async () => {
		const { redis, set } = makeFakeRedis();
		const snapshot = new RedisPathSnapshot(redis);

		await snapshot.write("default", "sb-1", 7, makeCache(1000));

		expect(set).toHaveBeenCalledTimes(1);
	});
});

/**
 * Unit tests for RedisPathSnapshot. Stubs the ioredis surface so no real
 * Redis is required.
 */

import { decode, encode } from "@msgpack/msgpack";
import type { Redis } from "ioredis";
import { describe, expect, it, vi } from "vitest";
import { RedisPathSnapshot } from "../../redis-path-snapshot.js";
import { INODE_KIND, type PathCacheEntry } from "../../types.js";

interface FakeStore {
	data: Map<string, Buffer>;
}

function makeFakeRedis(store: FakeStore): Redis {
	const set = vi.fn(async (key: string, value: Buffer | string) => {
		const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
		store.data.set(key, buf);
		return "OK";
	});
	const getBuffer = vi.fn(async (key: string) => store.data.get(key) ?? null);
	const del = vi.fn(async (key: string) => {
		const existed = store.data.delete(key);
		return existed ? 1 : 0;
	});
	return { set, getBuffer, del } as unknown as Redis;
}

function mkFile(path: string, id: bigint, opts: Partial<PathCacheEntry> = {}): [string, PathCacheEntry] {
	return [
		path,
		{
			inodeId: id,
			kind: INODE_KIND.FILE,
			mode: 0o644,
			size: 10,
			mtime: new Date(1_700_000_000_000),
			contentSha256: new Uint8Array(32).fill(0xab),
			symlinkTarget: null,
			...opts,
		},
	];
}

describe("RedisPathSnapshot", () => {
	it("key() namespaces under vfs:{tenantId}:snap:{sandboxId}", () => {
		expect(RedisPathSnapshot.key("tenant-a", "sb-123")).toBe("vfs:tenant-a:snap:sb-123");
		expect(RedisPathSnapshot.key("default", "sb-123")).toBe("vfs:default:snap:sb-123");
	});

	it("same sandboxId across tenants produces disjoint keys", () => {
		const keyA = RedisPathSnapshot.key("tenant-a", "sb-1");
		const keyB = RedisPathSnapshot.key("tenant-b", "sb-1");
		expect(keyA).not.toBe(keyB);
		expect(keyA).toBe("vfs:tenant-a:snap:sb-1");
		expect(keyB).toBe("vfs:tenant-b:snap:sb-1");
	});

	it("round-trips files, directories, and symlinks", async () => {
		const store: FakeStore = { data: new Map() };
		const snap = new RedisPathSnapshot(makeFakeRedis(store));
		const original = new Map<string, PathCacheEntry>([
			mkFile("/a.txt", 1n),
			[
				"/dir",
				{
					inodeId: 2n,
					kind: INODE_KIND.DIRECTORY,
					mode: 0o755,
					size: 0,
					mtime: new Date(1_700_000_000_000),
					contentSha256: null,
					symlinkTarget: null,
				},
			],
			[
				"/link",
				{
					inodeId: 3n,
					kind: INODE_KIND.SYMLINK,
					mode: 0o777,
					size: 5,
					mtime: new Date(1_700_000_000_000),
					contentSha256: null,
					symlinkTarget: "/a.txt",
				},
			],
		]);

		await snap.write("default", "sb-1", 7, original);
		const got = await snap.read("default", "sb-1");

		expect(got).not.toBeNull();
		expect(got!.version).toBe(7);
		expect(got!.entries.size).toBe(3);
		for (const [path, entry] of original) {
			const round = got!.entries.get(path);
			expect(round).toBeDefined();
			expect(round!.inodeId).toBe(entry.inodeId);
			expect(round!.kind).toBe(entry.kind);
			expect(round!.mode).toBe(entry.mode);
			expect(round!.size).toBe(entry.size);
			expect(round!.mtime.getTime()).toBe(entry.mtime.getTime());
			expect(round!.symlinkTarget).toBe(entry.symlinkTarget);
			if (entry.contentSha256 === null) {
				expect(round!.contentSha256).toBeNull();
			} else {
				expect(round!.contentSha256).toEqual(entry.contentSha256);
			}
		}
	});

	it("tenant-a snapshot is not visible to tenant-b for the same sandboxId", async () => {
		const store: FakeStore = { data: new Map() };
		const snap = new RedisPathSnapshot(makeFakeRedis(store));
		const m = new Map<string, PathCacheEntry>([mkFile("/secret.txt", 1n)]);

		await snap.write("tenant-a", "sb-shared", 1, m);

		// tenant-b should not see tenant-a's snapshot
		const gotB = await snap.read("tenant-b", "sb-shared");
		expect(gotB).toBeNull();

		// tenant-a should still read its own snapshot
		const gotA = await snap.read("tenant-a", "sb-shared");
		expect(gotA).not.toBeNull();
		expect(gotA!.entries.size).toBe(1);
	});

	it("preserves bigint inode IDs larger than Number.MAX_SAFE_INTEGER", async () => {
		const store: FakeStore = { data: new Map() };
		const snap = new RedisPathSnapshot(makeFakeRedis(store));
		const bigId = (1n << 62n) + 123n; // safely > 2^53
		const m = new Map<string, PathCacheEntry>([mkFile("/big", bigId)]);
		await snap.write("default", "sb-1", 1, m);
		const got = await snap.read("default", "sb-1");
		expect(got!.entries.get("/big")!.inodeId).toBe(bigId);
	});

	it("handles 2^63 - 1 inode IDs", async () => {
		const store: FakeStore = { data: new Map() };
		const snap = new RedisPathSnapshot(makeFakeRedis(store));
		const id = (1n << 63n) - 1n;
		const m = new Map<string, PathCacheEntry>([mkFile("/max", id)]);
		await snap.write("default", "sb-1", 1, m);
		const got = await snap.read("default", "sb-1");
		expect(got!.entries.get("/max")!.inodeId).toBe(id);
	});

	it("read() returns null for a missing key", async () => {
		const store: FakeStore = { data: new Map() };
		const snap = new RedisPathSnapshot(makeFakeRedis(store));
		expect(await snap.read("default", "nope")).toBeNull();
	});

	it("read() returns null on decode failure", async () => {
		const store: FakeStore = { data: new Map() };
		store.data.set("vfs:default:snap:sb-x", Buffer.from([0xff, 0xff, 0xff, 0xff]));
		const snap = new RedisPathSnapshot(makeFakeRedis(store));
		expect(await snap.read("default", "sb-x")).toBeNull();
	});

	it("read() rejects snapshots from a different schema version", async () => {
		const store: FakeStore = { data: new Map() };
		// Hand-craft a valid msgpack blob with schemaVersion=999
		const bogus = Buffer.from(encode({ schemaVersion: 999, version: 1, entries: [] }));
		store.data.set("vfs:default:snap:sb-old", bogus);
		const snap = new RedisPathSnapshot(makeFakeRedis(store));
		expect(await snap.read("default", "sb-old")).toBeNull();
	});

	it("embeds the current schemaVersion in write output", async () => {
		const store: FakeStore = { data: new Map() };
		const snap = new RedisPathSnapshot(makeFakeRedis(store));
		await snap.write("default", "sb-1", 0, new Map());
		const raw = store.data.get("vfs:default:snap:sb-1");
		expect(raw).toBeDefined();
		const decoded = decode(raw!) as { schemaVersion: number };
		expect(decoded.schemaVersion).toBe(1);
	});

	it("delete() removes the key", async () => {
		const store: FakeStore = { data: new Map() };
		store.data.set("vfs:default:snap:sb-1", Buffer.from(encode({ schemaVersion: 1, version: 0, entries: [] })));
		const snap = new RedisPathSnapshot(makeFakeRedis(store));
		await snap.delete("default", "sb-1");
		expect(store.data.has("vfs:default:snap:sb-1")).toBe(false);
	});

	it("write() swallows Redis errors (fail open)", async () => {
		const brittle: Redis = {
			set: vi.fn(async () => {
				throw new Error("redis down");
			}),
			getBuffer: vi.fn(),
			del: vi.fn(),
		} as unknown as Redis;
		const snap = new RedisPathSnapshot(brittle);
		await expect(snap.write("default", "sb-1", 1, new Map())).resolves.toBeUndefined();
	});

	it("read() swallows Redis errors and returns null", async () => {
		const brittle: Redis = {
			set: vi.fn(),
			getBuffer: vi.fn(async () => {
				throw new Error("redis down");
			}),
			del: vi.fn(),
		} as unknown as Redis;
		const snap = new RedisPathSnapshot(brittle);
		expect(await snap.read("default", "sb-1")).toBeNull();
	});

	it("delete() swallows Redis errors", async () => {
		const brittle: Redis = {
			set: vi.fn(),
			getBuffer: vi.fn(),
			del: vi.fn(async () => {
				throw new Error("redis down");
			}),
		} as unknown as Redis;
		const snap = new RedisPathSnapshot(brittle);
		await expect(snap.delete("default", "sb-1")).resolves.toBeUndefined();
	});
});

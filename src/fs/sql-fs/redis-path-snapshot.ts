/**
 * Redis path-snapshot cache (Phase E).
 *
 * Persists the full pathCache for a sandbox as a msgpack-encoded blob keyed
 * `vfs:snap:{sandboxId}`, with the sandbox version counter embedded so readers
 * can reject stale snapshots via strict-equality check against `vfs:ver:{X}`.
 *
 * All Redis failures fail open: `read` returns `null`, `write`/`delete` return
 * quietly. Callers fall back to `loadAllPaths`.
 */

import { decode, encode } from "@msgpack/msgpack";
import type { Redis } from "ioredis";
import type { PathCacheEntry } from "./types.js";

/**
 * Bump when the on-the-wire layout of `Snapshot` or `EncodedEntry` changes.
 * Old snapshots with a mismatched version are treated as a miss (Edge Case §8).
 */
const SNAPSHOT_SCHEMA_VERSION = 1;

/**
 * Compact per-entry shape: single-letter keys keep the encoded blob small.
 * - `p`: absolute path
 * - `i`: inode id as decimal string (bigint does not survive msgpack cleanly in all modes)
 * - `k`: inode kind (1=file, 2=dir, 3=symlink)
 * - `m`: mode bits
 * - `s`: size in bytes
 * - `t`: mtime ms-since-epoch
 * - `c`: sha256 (Uint8Array) or null
 * - `l`: symlink target or null
 */
interface EncodedEntry {
	readonly p: string;
	readonly i: string;
	readonly k: number;
	readonly m: number;
	readonly s: number;
	readonly t: number;
	readonly c: Uint8Array | null;
	readonly l: string | null;
}

interface Snapshot {
	readonly schemaVersion: number;
	readonly version: number;
	readonly entries: readonly EncodedEntry[];
}

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1h

export interface RedisPathSnapshotOptions {
	readonly ttlMs?: number;
}

export class RedisPathSnapshot {
	readonly #client: Redis;
	readonly #ttlMs: number;

	constructor(client: Redis, opts: RedisPathSnapshotOptions = {}) {
		this.#client = client;
		this.#ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
	}

	static key(tenantId: string, sandboxId: string): string {
		return `vfs:${tenantId}:snap:${sandboxId}`;
	}

	async write(
		tenantId: string,
		sandboxId: string,
		version: number,
		pathCache: Map<string, PathCacheEntry>,
	): Promise<void> {
		const entries: EncodedEntry[] = [];
		for (const [path, e] of pathCache) {
			entries.push({
				p: path,
				i: String(e.inodeId),
				k: e.kind,
				m: e.mode,
				s: e.size,
				t: e.mtime.getTime(),
				c: e.contentSha256,
				l: e.symlinkTarget,
			});
		}
		const snap: Snapshot = { schemaVersion: SNAPSHOT_SCHEMA_VERSION, version, entries };
		try {
			const bytes = Buffer.from(encode(snap));
			await this.#client.set(RedisPathSnapshot.key(tenantId, sandboxId), bytes, "PX", this.#ttlMs);
		} catch (err) {
			console.error(JSON.stringify({ event: "snapshot_write_error", sandboxId, error: (err as Error).message }));
		}
	}

	async read(
		tenantId: string,
		sandboxId: string,
	): Promise<{ version: number; entries: Map<string, PathCacheEntry> } | null> {
		try {
			const buf = await this.#client.getBuffer(RedisPathSnapshot.key(tenantId, sandboxId));
			if (!buf) return null;
			const snap = decode(buf) as Snapshot;
			if (!snap || snap.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) return null;
			const entries = new Map<string, PathCacheEntry>();
			for (const e of snap.entries) {
				// msgpack may decode bin fields as Node `Buffer`; normalize to a
				// plain `Uint8Array` so callers see a consistent shape.
				const sha = e.c === null ? null : new Uint8Array(e.c.buffer, e.c.byteOffset, e.c.byteLength);
				entries.set(e.p, {
					inodeId: BigInt(e.i),
					kind: e.k as PathCacheEntry["kind"],
					mode: e.m,
					size: e.s,
					mtime: new Date(e.t),
					contentSha256: sha,
					symlinkTarget: e.l,
				});
			}
			return { version: snap.version, entries };
		} catch (err) {
			console.error(JSON.stringify({ event: "snapshot_read_error", sandboxId, error: (err as Error).message }));
			return null;
		}
	}

	async delete(tenantId: string, sandboxId: string): Promise<void> {
		try {
			await this.#client.del(RedisPathSnapshot.key(tenantId, sandboxId));
		} catch {
			// best-effort; key ages out via TTL
		}
	}
}

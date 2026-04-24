/**
 * Content-addressable blob cache backed by Redis.
 *
 * Blobs are keyed by tenant + sha256 (`vfs:{tenantId}:blob:<hex>`), so the cache is
 * isolated per tenant and safe across sandboxes within a tenant; a sha256 collision would mean bit-identical data.
 * All Redis failures fail open: the caller falls back to Postgres.
 */

import type { Redis } from "ioredis";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024; // 8 MB

export interface RedisBlobCacheOptions {
	readonly ttlMs?: number;
	readonly maxBytes?: number;
	readonly enabled?: boolean;
}

export class RedisBlobCache {
	readonly #client: Redis;
	readonly #tenantId: string;
	readonly #ttlMs: number;
	readonly #maxBytes: number;
	readonly #enabled: boolean;

	constructor(client: Redis, tenantId: string, opts: RedisBlobCacheOptions = {}) {
		this.#client = client;
		this.#tenantId = tenantId;
		this.#ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
		this.#maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
		this.#enabled = opts.enabled ?? true;
	}

	#key(sha256: Uint8Array): string {
		return `vfs:${this.#tenantId}:blob:${Buffer.from(sha256).toString("hex")}`;
	}

	async get(sha256: Uint8Array): Promise<Uint8Array | null> {
		if (!this.#enabled) return null;
		try {
			const buf = await this.#client.getBuffer(this.#key(sha256));
			return buf ? new Uint8Array(buf) : null;
		} catch (err) {
			console.error(JSON.stringify({ event: "redis_blob_get_error", error: (err as Error).message }));
			return null; // fail open
		}
	}

	async set(sha256: Uint8Array, data: Uint8Array): Promise<void> {
		if (!this.#enabled) return;
		if (data.byteLength > this.#maxBytes) return;
		try {
			await this.#client.set(this.#key(sha256), Buffer.from(data), "PX", this.#ttlMs);
		} catch (err) {
			console.error(JSON.stringify({ event: "redis_blob_set_error", error: (err as Error).message }));
		}
	}
}

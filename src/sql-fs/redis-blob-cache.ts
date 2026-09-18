/**
 * Content-addressable blob cache backed by Redis.
 *
 * Blobs are keyed by tenant + sha256 (`vfs:{tenantId}:blob:<hex>`), so the cache is
 * isolated per tenant and safe across sandboxes within a tenant; a sha256 collision would mean bit-identical data.
 * All Redis failures fail open: the caller falls back to Postgres.
 */

import type { Redis } from "ioredis";
import type { RedisCircuitBreaker } from "../redis/circuit-breaker.js";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024; // 8 MB
/** #167: cap concurrent backfill writes so a stalled Redis cannot grow an unbounded queue. */
const DEFAULT_MAX_IN_FLIGHT = 32;
const DEFAULT_MAX_IN_FLIGHT_BYTES = 32 * 1024 * 1024; // 32 MB
/** Drops are logged at most this often, with the running total, so a storm cannot flood the log. */
const DROP_LOG_INTERVAL_MS = 5_000;

export interface RedisBlobCacheOptions {
	readonly ttlMs?: number;
	readonly maxBytes?: number;
	readonly enabled?: boolean;
	/** Max concurrent `set` writes before further writes are dropped. */
	readonly maxInFlight?: number;
	/** Max total bytes of concurrent `set` writes before further writes are dropped. */
	readonly maxInFlightBytes?: number;
	/** Data-plane breaker (#167): when open, Redis is skipped entirely and the caller falls back to Postgres. */
	readonly breaker?: RedisCircuitBreaker;
}

export class RedisBlobCache {
	readonly #client: Redis;
	readonly #tenantId: string;
	readonly #ttlMs: number;
	readonly #maxBytes: number;
	readonly #enabled: boolean;
	readonly #maxInFlight: number;
	readonly #maxInFlightBytes: number;
	readonly #breaker: RedisCircuitBreaker | undefined;
	#inFlight = 0;
	#inFlightBytes = 0;
	#dropped = 0;
	#lastDropLogAt = 0;

	constructor(client: Redis, tenantId: string, opts: RedisBlobCacheOptions = {}) {
		this.#client = client;
		this.#tenantId = tenantId;
		this.#ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
		this.#maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
		this.#enabled = opts.enabled ?? true;
		this.#maxInFlight = opts.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
		this.#maxInFlightBytes = opts.maxInFlightBytes ?? DEFAULT_MAX_IN_FLIGHT_BYTES;
		this.#breaker = opts.breaker;
	}

	/** Current backfill occupancy, for tests and observability. */
	get stats(): { readonly inFlight: number; readonly inFlightBytes: number; readonly dropped: number } {
		return { inFlight: this.#inFlight, inFlightBytes: this.#inFlightBytes, dropped: this.#dropped };
	}

	/** True when the data-plane breaker says Redis is unreachable — skip I/O and fall back to Postgres. */
	#circuitOpen(): boolean {
		return this.#breaker?.isOpen() === true;
	}

	#recordDrop(reason: string): void {
		this.#dropped += 1;
		const now = Date.now();
		if (now - this.#lastDropLogAt < DROP_LOG_INTERVAL_MS) return;
		this.#lastDropLogAt = now;
		console.warn(
			JSON.stringify({
				event: "redis_blob_set_dropped",
				reason,
				dropped: this.#dropped,
				inFlight: this.#inFlight,
				inFlightBytes: this.#inFlightBytes,
			}),
		);
	}

	#key(sha256: Uint8Array): string {
		return `vfs:${this.#tenantId}:blob:${Buffer.from(sha256).toString("hex")}`;
	}

	async get(sha256: Uint8Array): Promise<Uint8Array | null> {
		if (!this.#enabled) return null;
		if (this.#circuitOpen()) return null;
		try {
			const buf = await this.#client.getBuffer(this.#key(sha256));
			this.#breaker?.recordSuccess();
			return buf ? new Uint8Array(buf) : null;
		} catch (err) {
			this.#breaker?.recordFailure();
			console.error(JSON.stringify({ event: "redis_blob_get_error", error: (err as Error).message }));
			return null; // fail open
		}
	}

	/**
	 * Bulk variant of `get`. Returns one entry per input sha256 in the same
	 * order; `null` for a miss. Fail-open: any Redis error returns all-null.
	 */
	async mget(sha256s: ReadonlyArray<Uint8Array>): Promise<Array<Uint8Array | null>> {
		if (!this.#enabled || sha256s.length === 0) return sha256s.map(() => null);
		if (this.#circuitOpen()) return sha256s.map(() => null);
		// Chunk MGET to bound a single round-trip's keyspace and response size.
		// A 50k-blob warm sandbox would otherwise issue one MGET that requires
		// Redis to assemble the entire response array before returning, spiking
		// memory on both client and server.
		const CHUNK = 1024;
		const out: Array<Uint8Array | null> = new Array(sha256s.length);
		try {
			const mgetBuffer = (
				this.#client as unknown as { mgetBuffer(...keys: string[]): Promise<Array<Buffer | null>> }
			).mgetBuffer.bind(this.#client);
			for (let i = 0; i < sha256s.length; i += CHUNK) {
				const slice = sha256s.slice(i, i + CHUNK);
				const keys = slice.map((s) => this.#key(s));
				const bufs = await mgetBuffer(...keys);
				for (let j = 0; j < bufs.length; j++) {
					const b = bufs[j];
					out[i + j] = b ? new Uint8Array(b) : null;
				}
			}
			this.#breaker?.recordSuccess();
			return out;
		} catch (err) {
			this.#breaker?.recordFailure();
			console.error(JSON.stringify({ event: "redis_blob_mget_error", error: (err as Error).message }));
			return sha256s.map(() => null); // fail open
		}
	}

	/**
	 * Backfill one blob. Callers invoke this fire-and-forget, so #167 bounds it
	 * here: over the in-flight count or byte cap the write is DROPPED, not
	 * queued. The cache is fail-open by contract, so a dropped backfill costs
	 * one later Postgres read — an unbounded queue against a stalled Redis costs
	 * the replica.
	 */
	async set(sha256: Uint8Array, data: Uint8Array): Promise<void> {
		if (!this.#enabled) return;
		if (data.byteLength > this.#maxBytes) return;
		if (this.#circuitOpen()) return;
		if (this.#inFlight >= this.#maxInFlight) {
			this.#recordDrop("max_in_flight");
			return;
		}
		if (this.#inFlightBytes + data.byteLength > this.#maxInFlightBytes) {
			this.#recordDrop("max_in_flight_bytes");
			return;
		}
		this.#inFlight += 1;
		this.#inFlightBytes += data.byteLength;
		try {
			await this.#client.set(this.#key(sha256), Buffer.from(data), "PX", this.#ttlMs);
			this.#breaker?.recordSuccess();
		} catch (err) {
			this.#breaker?.recordFailure();
			console.error(JSON.stringify({ event: "redis_blob_set_error", error: (err as Error).message }));
		} finally {
			this.#inFlight -= 1;
			this.#inFlightBytes -= data.byteLength;
		}
	}

	/**
	 * Bulk-delete cache entries for the given sha256s (e.g. after blob GC).
	 * Chunked like `mget`; uses UNLINK (non-blocking reclaim). Fail-open: a Redis
	 * error is logged and swallowed — stale entries are harmless (no inode
	 * references them) and expire by TTL.
	 */
	async mdel(sha256s: ReadonlyArray<Uint8Array>): Promise<void> {
		if (!this.#enabled || sha256s.length === 0) return;
		if (this.#circuitOpen()) return;
		const CHUNK = 1024;
		try {
			for (let i = 0; i < sha256s.length; i += CHUNK) {
				const keys = sha256s.slice(i, i + CHUNK).map((s) => this.#key(s));
				await this.#client.unlink(...keys);
			}
		} catch (err) {
			console.error(JSON.stringify({ event: "redis_blob_mdel_error", error: (err as Error).message }));
		}
	}
}

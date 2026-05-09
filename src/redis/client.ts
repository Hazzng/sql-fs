/**
 * Shared Redis client singleton.
 *
 * `getRedisClient()` lazily constructs a single `ioredis` instance from the
 * `REDIS_URL` environment variable. If `REDIS_URL` is unset, returns `undefined`
 * so callers can gracefully fall back to Postgres-only operation.
 */

import { Redis, type RedisOptions } from "ioredis";

let client: Redis | undefined;
let initialized = false;

export interface RedisConfig {
	readonly url: string;
	readonly options?: RedisOptions;
}

/**
 * Returns the process-wide Redis client, or `undefined` when `REDIS_URL` is
 * unset. The client is created on first call and reused for the lifetime of
 * the process.
 */
export function getRedisClient(): Redis | undefined {
	if (initialized) return client;
	initialized = true;
	const url = process.env.REDIS_URL;
	if (!url) {
		console.log(JSON.stringify({ event: "redis_disabled", reason: "REDIS_URL not set" }));
		return undefined;
	}
	client = new Redis(url, {
		lazyConnect: false,
		maxRetriesPerRequest: 3,
		enableReadyCheck: true,
		retryStrategy: (times) => Math.min(1000 * 2 ** times, 30_000),
	});
	client.on("error", (err) => {
		console.error(JSON.stringify({ event: "redis_error", error: err.message }));
	});
	client.on("connect", () => {
		console.log(JSON.stringify({ event: "redis_connect" }));
	});
	return client;
}

/**
 * Gracefully close the shared Redis client. Issues `quit()` (drains pending
 * commands), and falls back to `disconnect()` on timeout or failure so a
 * misbehaving Redis cannot block process shutdown.
 *
 * Safe to call multiple times. After the first successful close, subsequent
 * calls are no-ops. Once closed, `getRedisClient()` will not reinitialize.
 */
export async function closeRedisClient(timeoutMs = 5_000): Promise<void> {
	const c = client;
	if (c === undefined) {
		// Mark as initialized so future getRedisClient() calls don't construct a new client during shutdown.
		initialized = true;
		return;
	}
	client = undefined;
	try {
		await Promise.race([
			c.quit(),
			new Promise<void>((_, reject) => setTimeout(() => reject(new Error("redis_quit_timeout")), timeoutMs)),
		]);
	} catch (err) {
		console.error(JSON.stringify({ event: "redis_quit_error", error: (err as Error).message }));
		try {
			c.disconnect();
		} catch {
			// best-effort
		}
	}
}

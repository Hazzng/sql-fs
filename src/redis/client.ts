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

export async function disconnectRedis(): Promise<void> {
	if (client) {
		await client.quit();
		client = undefined;
		initialized = false;
	}
}

/** Test-only: resets the singleton state so a fresh client can be constructed. */
export function __resetRedisForTests(): void {
	client = undefined;
	initialized = false;
}

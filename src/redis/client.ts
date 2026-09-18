/**
 * Role-split Redis clients.
 *
 * #167: one ioredis connection carried everything — blob cache, path snapshot,
 * locks, version counter and session state. ioredis pipelines commands over a
 * single socket, so a queue of multi-MiB blob `SET`s head-of-line blocks the
 * latency-critical `INCR`/`EVAL` behind them; at 260 in-flight 2 MiB writes an
 * `INCR` on the shared connection timed out at 2043 ms while the same command
 * on a separate connection answered in 44 ms. Each timeout then drove the lock
 * acquire breaker, which fast-failed every request on the replica.
 *
 * So the data plane (blob cache, path snapshot) gets its own connection and the
 * control plane (locks, version counter, session state) keeps the original one.
 * `REDIS_DATA_URL` defaults to `REDIS_URL`: the split is by connection, not by
 * server, so existing single-Redis deployments get the isolation for free.
 */

import { Redis, type RedisOptions } from "ioredis";

/**
 * Which class of traffic a client carries. `control` is latency-critical and
 * correctness-bearing (a timeout there fails a request); `data` is best-effort
 * cache traffic that always falls back to Postgres.
 */
export type RedisRole = "control" | "data";

export const REDIS_ROLES: readonly RedisRole[] = ["control", "data"];

const clients: Map<RedisRole, Redis> = new Map();
const initialized: Set<RedisRole> = new Set();

export interface RedisConfig {
	readonly url: string;
	readonly options?: RedisOptions;
}

/** Env var holding the connection string for a role. Data falls back to `REDIS_URL`. */
function urlFor(role: RedisRole): string | undefined {
	if (role === "control") return process.env.REDIS_URL;
	return process.env.REDIS_DATA_URL || process.env.REDIS_URL;
}

/**
 * Returns the Redis client for `role`, or `undefined` when no URL is configured
 * for it. Clients are created on first call and reused for the lifetime of the
 * process. Roles never share a socket, even when they resolve to the same URL —
 * that separation is the whole point (#167).
 */
export function getRedisClient(role: RedisRole = "control"): Redis | undefined {
	if (initialized.has(role)) return clients.get(role);
	initialized.add(role);
	const url = urlFor(role);
	if (!url) {
		console.log(JSON.stringify({ event: "redis_disabled", role, reason: "REDIS_URL not set" }));
		return undefined;
	}
	const client = new Redis(url, {
		lazyConnect: false,
		maxRetriesPerRequest: 3,
		enableReadyCheck: true,
		// F5: bound every command so a sustained Redis outage rejects promptly
		// instead of queueing on the offline queue / blocking through reconnect
		// backoff (up to ~30 s). This is what lets the acquire-path error budget
		// advance within a few seconds and the circuit breaker open.
		commandTimeout: 2_000,
		retryStrategy: (times) => Math.min(1000 * 2 ** times, 30_000),
		connectionName: `sql-fs-${role}`,
	});
	clients.set(role, client);
	client.on("error", (err) => {
		console.error(JSON.stringify({ event: "redis_error", role, error: err.message }));
	});
	client.on("connect", () => {
		console.log(JSON.stringify({ event: "redis_connect", role }));
	});
	return client;
}

/**
 * Gracefully close every role's Redis client. Issues `quit()` (drains pending
 * commands), and falls back to `disconnect()` on timeout or failure so a
 * misbehaving Redis cannot block process shutdown.
 *
 * Safe to call multiple times. After the first successful close, subsequent
 * calls are no-ops. Once closed, `getRedisClient()` will not reinitialize.
 */
export async function closeRedisClient(timeoutMs = 5_000): Promise<void> {
	// Mark every role initialized so a late getRedisClient() during shutdown
	// cannot construct a fresh connection.
	for (const role of REDIS_ROLES) initialized.add(role);
	const open = [...clients.entries()];
	clients.clear();
	await Promise.all(
		open.map(async ([role, c]) => {
			try {
				await Promise.race([
					c.quit(),
					new Promise<void>((_, reject) => setTimeout(() => reject(new Error("redis_quit_timeout")), timeoutMs)),
				]);
			} catch (err) {
				console.error(JSON.stringify({ event: "redis_quit_error", role, error: (err as Error).message }));
				try {
					c.disconnect();
				} catch {
					// best-effort
				}
			}
		}),
	);
}

/**
 * Redis-backed distributed mutex (Phase C).
 *
 * Acquires a lock via `SET key token NX PX leaseMs`, renews the lease with a
 * Lua-based compare-and-extend script on an interval, and releases it via a
 * Lua compare-and-delete so only the holder can release. Callers get
 * LockAcquireTimeoutError if acquisition exceeds the deadline, and
 * LockLostError if the heartbeat detects that ownership was lost.
 */

import crypto from "node:crypto";
import type { Redis } from "ioredis";

const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
	return redis.call("del", KEYS[1])
else
	return 0
end`;

const RENEW_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
	return redis.call("pexpire", KEYS[1], ARGV[2])
else
	return 0
end`;

export interface DistributedLockOptions {
	readonly leaseMs: number;
	readonly renewMs: number;
	readonly acquireTimeoutMs: number;
	readonly acquireRetryMs: number;
}

const DEFAULTS: DistributedLockOptions = {
	leaseMs: 60_000,
	renewMs: 20_000,
	acquireTimeoutMs: 300_000,
	acquireRetryMs: 50,
};

/** Fails fast on configs that would break mutex invariants (e.g. renewMs >= leaseMs lets the lease expire before renewal). */
function assertLockOptions(opts: DistributedLockOptions): void {
	if (opts.leaseMs <= 0) {
		throw new Error(`DistributedLockOptions.leaseMs must be > 0 (got ${opts.leaseMs})`);
	}
	if (opts.renewMs <= 0) {
		throw new Error(`DistributedLockOptions.renewMs must be > 0 (got ${opts.renewMs})`);
	}
	if (opts.renewMs >= opts.leaseMs) {
		throw new Error(
			`DistributedLockOptions.renewMs (${opts.renewMs}) must be strictly less than leaseMs (${opts.leaseMs}): otherwise the lease can expire before the first heartbeat fires and another caller can acquire the lock concurrently.`,
		);
	}
	if (opts.acquireTimeoutMs < 0) {
		throw new Error(`DistributedLockOptions.acquireTimeoutMs must be >= 0 (got ${opts.acquireTimeoutMs})`);
	}
	if (opts.acquireRetryMs <= 0) {
		throw new Error(`DistributedLockOptions.acquireRetryMs must be > 0 (got ${opts.acquireRetryMs})`);
	}
}

export class LockAcquireTimeoutError extends Error {
	readonly code = "ELOCKTIMEOUT";
	constructor(key: string) {
		super(`ELOCKTIMEOUT: could not acquire lock ${key} within timeout`);
		this.name = "LockAcquireTimeoutError";
	}
}

export class LockLostError extends Error {
	readonly code = "ELOCKLOST";
	constructor(key: string) {
		super(`ELOCKLOST: lock ${key} was lost during operation (lease expired or heartbeat failed)`);
		this.name = "LockLostError";
	}
}

/**
 * Runs `fn` while holding the distributed lock identified by `key`.
 *
 * - Throws `LockAcquireTimeoutError` when the acquire loop exceeds
 *   `acquireTimeoutMs` without obtaining the lock.
 * - Throws `LockLostError` when the heartbeat discovers the lease is no
 *   longer owned by this caller (Redis returned non-1 or threw).
 *
 * The lock is always released in a `finally` branch; release errors are
 * logged but not rethrown (the lease will expire on its own).
 */
export async function withDistributedLock<T>(
	redis: Redis,
	key: string,
	fn: () => Promise<T>,
	opts: Partial<DistributedLockOptions> = {},
): Promise<T> {
	const merged: DistributedLockOptions = { ...DEFAULTS, ...opts };
	assertLockOptions(merged);
	const { leaseMs, renewMs, acquireTimeoutMs, acquireRetryMs } = merged;
	const token = crypto.randomUUID();
	const deadline = Date.now() + acquireTimeoutMs;

	// ── Acquire ──
	// Redis errors (connection refused, timeouts, etc.) are treated like a
	// busy lock: we retry until the acquire deadline, then surface
	// LockAcquireTimeoutError. This keeps the caller-visible contract
	// consistent whether the contention is real or infrastructural — routes
	// translate ELOCKTIMEOUT into 503 Service Unavailable and let the client
	// retry. Without this, a Redis outage would leak a 500 with whatever the
	// driver happened to throw.
	while (true) {
		let acquired = false;
		try {
			const ok = await redis.set(key, token, "PX", leaseMs, "NX");
			acquired = ok === "OK";
		} catch {
			acquired = false;
		}
		if (acquired) break;
		if (Date.now() >= deadline) throw new LockAcquireTimeoutError(key);
		await new Promise((r) => setTimeout(r, acquireRetryMs));
	}

	// ── Heartbeat ──
	// Non-overlapping renewal: schedule the next renewal only after the
	// previous Redis call settles. `setInterval(async ...)` would let slow
	// Redis commands stack — every `renewMs` we'd queue another EVAL even if
	// the previous one hasn't returned yet, eventually overwhelming the
	// connection. Sequential scheduling keeps at most one renewal in flight
	// and bounds command latency naturally.
	let lost = false;
	let stopped = false;
	let renewTimer: ReturnType<typeof setTimeout> | undefined;
	const scheduleRenew = (): void => {
		if (stopped) return;
		renewTimer = setTimeout(async () => {
			if (stopped) return;
			// Cap renewal command wait so a stalled Redis can't block release.
			// We use a generous bound (renewMs) — any longer and the lease has
			// already expired anyway.
			try {
				const renewPromise = redis.eval(RENEW_SCRIPT, 1, key, token, String(leaseMs));
				const timeoutPromise = new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error("renew_timeout")), renewMs),
				);
				const res = await Promise.race([renewPromise, timeoutPromise]);
				if (res !== 1) lost = true;
			} catch {
				lost = true;
			}
			// Once the lock is lost (or a renew has timed out), stop scheduling
			// further renewals. Otherwise on a hung Redis we'd keep enqueuing
			// EVAL commands every renewMs that pile up in the ioredis send queue
			// while their predecessors are still in-flight.
			if (!stopped && !lost) scheduleRenew();
		}, renewMs);
	};
	scheduleRenew();

	// ── Critical section ──
	try {
		const result = await fn();
		if (lost) throw new LockLostError(key);
		return result;
	} finally {
		stopped = true;
		if (renewTimer !== undefined) clearTimeout(renewTimer);
		try {
			await redis.eval(RELEASE_SCRIPT, 1, key, token);
		} catch (err) {
			console.error(
				JSON.stringify({
					event: "lock_release_error",
					key,
					error: (err as Error).message,
				}),
			);
		}
	}
}

export function execLockKey(tenantId: string, sandboxId: string): string {
	return `vfs:${tenantId}:lock:${sandboxId}`;
}

/**
 * Redis-backed distributed readers-writer lock.
 *
 * Mirrors the in-process RWLock semantics across replicas:
 *  - Shared (reader) acquisitions coexist freely across replicas.
 *  - Exclusive (writer) acquisition blocks all new readers and all other writers.
 *  - Writer-priority: once a writer sets the flag, new readers spin until it clears.
 *  - Reader entries carry a TTL score in a ZSET; a crashed reader cannot deadlock
 *    a writer because expired entries are reaped on every poll.
 */

import crypto from "node:crypto";
import type { Redis } from "ioredis";
import {
	AcquireErrorBudget,
	DEFAULT_ACQUIRE_ERROR_BUDGET_MS,
	type RedisCircuitBreaker,
	getRedisCircuitBreaker,
} from "../redis/circuit-breaker.js";
export { LockAcquireTimeoutError, LockLostError } from "./distributed-lock.js";
import { LockAcquireTimeoutError, LockLostError, jitteredDelayMs } from "./distributed-lock.js";
import { recordHeartbeatGap } from "./event-loop-monitor.js";

// ── Lua scripts ──────────────────────────────────────────────────────────────

/**
 * Atomic shared acquire. Reaps expired readers, refuses if writer flag is set,
 * otherwise registers the reader token in the ZSET.
 *
 * KEYS[1]=writer  KEYS[2]=readers
 * ARGV[1]=token  ARGV[2]=now_ms  ARGV[3]=expire_at_ms
 * Returns 1 on success, 0 when writer flag is present.
 */
const ACQUIRE_SHARED_SCRIPT = `
redis.call("ZREMRANGEBYSCORE", KEYS[2], "-inf", ARGV[2])
if redis.call("EXISTS", KEYS[1]) == 1 then return 0 end
redis.call("ZADD", KEYS[2], ARGV[3], ARGV[1])
return 1`;

/**
 * Remove reader token from ZSET.
 * KEYS[1]=readers  ARGV[1]=token
 */
const RELEASE_SHARED_SCRIPT = `
return redis.call("ZREM", KEYS[1], ARGV[1])`;

/**
 * Bump reader ZSET score iff token still present (no zombie revival).
 * KEYS[1]=readers  ARGV[1]=token  ARGV[2]=expire_at_ms
 * Returns 1 if renewed, 0 if token already gone.
 */
const RENEW_SHARED_SCRIPT = `
if redis.call("ZSCORE", KEYS[1], ARGV[1]) then
  redis.call("ZADD", KEYS[1], ARGV[2], ARGV[1])
  return 1
end
return 0`;

/**
 * Set writer flag NX. Gates new shared acquires immediately.
 * KEYS[1]=writer  ARGV[1]=token  ARGV[2]=lease_ms
 * Returns "OK" on success, nil when another writer holds.
 */
const ACQUIRE_EXCLUSIVE_FLAG_SCRIPT = `
return redis.call("SET", KEYS[1], ARGV[1], "PX", ARGV[2], "NX")`;

/**
 * Verify flag is still ours and count live readers (reaping expired first).
 * KEYS[1]=writer  KEYS[2]=readers  ARGV[1]=token  ARGV[2]=now_ms
 * Returns -1 if flag lost, otherwise live reader count (0 = drained).
 */
const CHECK_READERS_DRAINED_SCRIPT = `
if redis.call("GET", KEYS[1]) ~= ARGV[1] then return -1 end
redis.call("ZREMRANGEBYSCORE", KEYS[2], "-inf", ARGV[2])
return redis.call("ZCARD", KEYS[2])`;

/** Token-checked renew for the writer flag. */
const RENEW_EXCLUSIVE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
else
  return 0
end`;

/** Token-checked release for the writer flag. */
const RELEASE_EXCLUSIVE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end`;

// ── Public types ─────────────────────────────────────────────────────────────

export type RWLockMode = "shared" | "exclusive";

export interface DistributedRWLockOptions {
	readonly leaseMs: number;
	readonly renewMs: number;
	readonly acquireTimeoutMs: number;
	readonly acquireRetryMs: number;
	readonly readerLeaseMs: number;
	/**
	 * F5: short budget (ms) for *thrown* (connection-class) acquire errors,
	 * separate from `acquireTimeoutMs`. Contention spins on the full window; a
	 * Redis outage fast-fails once thrown errors persist past this budget (and
	 * the process-wide breaker opens after enough consecutive failures).
	 */
	readonly errorBudgetMs: number;
}

const DEFAULTS: DistributedRWLockOptions = {
	leaseMs: 60_000,
	renewMs: 20_000,
	acquireTimeoutMs: 300_000,
	acquireRetryMs: 50,
	readerLeaseMs: 60_000,
	errorBudgetMs: DEFAULT_ACQUIRE_ERROR_BUDGET_MS,
};

export interface RWLockKeys {
	readonly writer: string;
	readonly readers: string;
}

export function rwLockKeys(tenantId: string, sandboxId: string): RWLockKeys {
	// The `{${sandboxId}}` braces are a Redis Cluster hash tag: every key that
	// shares the same `{…}` substring hashes to the same slot, so the two-key
	// EVAL scripts (writer + readers) below remain valid under Cluster routing.
	return {
		writer: `vfs:${tenantId}:rwlock:{${sandboxId}}:writer`,
		readers: `vfs:${tenantId}:rwlock:{${sandboxId}}:readers`,
	};
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function assertOptions(opts: DistributedRWLockOptions): void {
	if (opts.leaseMs <= 0) throw new Error(`DistributedRWLockOptions.leaseMs must be > 0 (got ${opts.leaseMs})`);
	if (opts.renewMs <= 0) throw new Error(`DistributedRWLockOptions.renewMs must be > 0 (got ${opts.renewMs})`);
	if (opts.renewMs >= opts.leaseMs)
		throw new Error(
			`DistributedRWLockOptions.renewMs (${opts.renewMs}) must be strictly less than leaseMs (${opts.leaseMs})`,
		);
	if (opts.acquireTimeoutMs < 0)
		throw new Error(`DistributedRWLockOptions.acquireTimeoutMs must be >= 0 (got ${opts.acquireTimeoutMs})`);
	if (opts.acquireRetryMs <= 0)
		throw new Error(`DistributedRWLockOptions.acquireRetryMs must be > 0 (got ${opts.acquireRetryMs})`);
	if (opts.readerLeaseMs <= 0)
		throw new Error(`DistributedRWLockOptions.readerLeaseMs must be > 0 (got ${opts.readerLeaseMs})`);
	if (opts.errorBudgetMs < 0)
		throw new Error(`DistributedRWLockOptions.errorBudgetMs must be >= 0 (got ${opts.errorBudgetMs})`);
	if (opts.renewMs >= opts.readerLeaseMs)
		throw new Error(
			`DistributedRWLockOptions.renewMs (${opts.renewMs}) must be strictly less than readerLeaseMs (${opts.readerLeaseMs}); otherwise a live reader's ZSET entry can be reaped between heartbeats and a writer could enter while the read is still in flight`,
		);
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

// ── Shared acquire path ───────────────────────────────────────────────────────

async function acquireShared(
	redis: Redis,
	keys: RWLockKeys,
	token: string,
	opts: DistributedRWLockOptions,
): Promise<void> {
	const { acquireTimeoutMs, acquireRetryMs, readerLeaseMs, errorBudgetMs } = opts;
	const deadline = Date.now() + acquireTimeoutMs;
	// F5: see distributed-lock.ts — contention spins to `deadline`; thrown errors
	// advance `errorBudget` and drive the process-wide breaker so a Redis outage
	// fast-fails instead of hanging for the full window.
	const breaker = getRedisCircuitBreaker();
	const errorBudget = new AcquireErrorBudget(errorBudgetMs);

	while (true) {
		if (breaker.isOpen()) throw new LockAcquireTimeoutError(keys.readers);
		const now = Date.now();
		const expireAt = now + readerLeaseMs;
		let acquired = false;
		try {
			const res = await redis.eval(
				ACQUIRE_SHARED_SCRIPT,
				2,
				keys.writer,
				keys.readers,
				token,
				String(now),
				String(expireAt),
			);
			acquired = res === 1;
			breaker.recordSuccess();
			errorBudget.reset();
		} catch {
			breaker.recordFailure();
			if (errorBudget.recordError()) throw new LockAcquireTimeoutError(keys.readers);
		}
		if (acquired) return;
		if (Date.now() >= deadline) throw new LockAcquireTimeoutError(keys.readers);
		// F9d: jittered sleep to de-synchronize cross-replica pollers.
		await sleep(jitteredDelayMs(acquireRetryMs));
	}
}

function startSharedHeartbeat(
	redis: Redis,
	keys: RWLockKeys,
	token: string,
	opts: DistributedRWLockOptions,
	onLost: () => void,
): () => void {
	const { renewMs, readerLeaseMs } = opts;
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	// Audit H4: a single transient renew timeout/error must NOT drop the reader's
	// ZSET entry (which would let a writer enter mid-read). Track expiry; only
	// call onLost on a definitive loss or once the reader lease has expired.
	let leaseExpiresAt = Date.now() + readerLeaseMs;
	const renewRetryMs = Math.max(50, Math.floor(renewMs / 4));

	const schedule = (delayMs: number): void => {
		if (stopped) return;
		// F8: a stall that delays this tick past the reader lease lets a writer
		// enter mid-read; measure the gap (readerLeaseMs is the reader's "lease").
		const expectedFireAt = Date.now() + delayMs;
		timer = setTimeout(async () => {
			if (stopped) return;
			recordHeartbeatGap({ lock: "rw-reader", key: keys.readers, expectedFireAt, renewMs, leaseMs: readerLeaseMs });
			let outcome: "renewed" | "ownership_lost" | "transient";
			let raceTimeout: ReturnType<typeof setTimeout> | undefined; // L1: clear on settle
			try {
				const expireAt = Date.now() + readerLeaseMs;
				const renewPromise = redis.eval(RENEW_SHARED_SCRIPT, 1, keys.readers, token, String(expireAt));
				const timeoutPromise = new Promise<never>((_, reject) => {
					raceTimeout = setTimeout(() => reject(new Error("renew_timeout")), renewMs);
				});
				const res = await Promise.race([renewPromise, timeoutPromise]);
				outcome = res === 1 ? "renewed" : "ownership_lost";
			} catch {
				outcome = "transient";
			} finally {
				if (raceTimeout !== undefined) clearTimeout(raceTimeout);
			}
			if (stopped) return;
			if (outcome === "renewed") {
				leaseExpiresAt = Date.now() + readerLeaseMs;
				schedule(renewMs);
			} else if (outcome === "ownership_lost" || Date.now() >= leaseExpiresAt) {
				onLost();
			} else {
				schedule(renewRetryMs);
			}
		}, delayMs);
	};

	schedule(renewMs);
	return () => {
		stopped = true;
		if (timer !== undefined) clearTimeout(timer);
	};
}

// ── Exclusive acquire path ────────────────────────────────────────────────────

async function acquireExclusive(
	redis: Redis,
	keys: RWLockKeys,
	token: string,
	opts: DistributedRWLockOptions,
	breaker: RedisCircuitBreaker,
	errorBudget: AcquireErrorBudget,
): Promise<void> {
	const { leaseMs, acquireTimeoutMs, acquireRetryMs } = opts;
	const deadline = Date.now() + acquireTimeoutMs;

	// Phase A — set writer flag (blocks new readers immediately).
	// F5: contention (flag held by another writer → non-OK) spins to `deadline`;
	// thrown connection-class errors advance the shared `errorBudget` and the
	// breaker so a Redis outage fast-fails instead of hanging for the full window.
	while (true) {
		if (breaker.isOpen()) throw new LockAcquireTimeoutError(keys.writer);
		let flagAcquired = false;
		try {
			const res = await redis.eval(ACQUIRE_EXCLUSIVE_FLAG_SCRIPT, 1, keys.writer, token, String(leaseMs));
			flagAcquired = res === "OK";
			breaker.recordSuccess();
			errorBudget.reset();
		} catch {
			breaker.recordFailure();
			if (errorBudget.recordError()) throw new LockAcquireTimeoutError(keys.writer);
		}
		if (flagAcquired) break;
		if (Date.now() >= deadline) throw new LockAcquireTimeoutError(keys.writer);
		// F9d: jittered sleep to de-synchronize cross-replica pollers.
		await sleep(jitteredDelayMs(acquireRetryMs));
	}
}

async function waitReadersDrained(
	redis: Redis,
	keys: RWLockKeys,
	token: string,
	opts: DistributedRWLockOptions,
	deadline: number,
	breaker: RedisCircuitBreaker,
	errorBudget: AcquireErrorBudget,
): Promise<void> {
	const { acquireRetryMs } = opts;
	// F5: second conflation site — runs after the writer flag is set. A live
	// reader (count > 0) is genuine contention and spins to `deadline`; a thrown
	// Redis error advances the shared error budget and breaker so a mid-acquire
	// outage fast-fails rather than hanging until the 300 s deadline.
	while (true) {
		if (breaker.isOpen()) throw new LockAcquireTimeoutError(keys.writer);
		const now = Date.now();
		let count: number;
		try {
			const res = await redis.eval(CHECK_READERS_DRAINED_SCRIPT, 2, keys.writer, keys.readers, token, String(now));
			count = res as number;
			breaker.recordSuccess();
			errorBudget.reset();
		} catch {
			breaker.recordFailure();
			if (errorBudget.recordError()) throw new LockAcquireTimeoutError(keys.writer);
			// Treat Redis error like readers still present; will surface timeout if deadline exceeded
			count = 1;
		}
		if (count === -1) throw new LockLostError(keys.writer);
		if (count === 0) return;
		if (Date.now() >= deadline) throw new LockAcquireTimeoutError(keys.writer);
		// F9d: jittered sleep to de-synchronize cross-replica pollers.
		await sleep(jitteredDelayMs(acquireRetryMs));
	}
}

function startExclusiveHeartbeat(
	redis: Redis,
	keys: RWLockKeys,
	token: string,
	opts: DistributedRWLockOptions,
	onLost: () => void,
): () => void {
	const { renewMs, leaseMs } = opts;
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	// Audit H4: a single transient renew timeout/error must NOT relinquish a
	// still-valid lease. Track the actual expiry (updated only on success) and
	// only call onLost on a definitive ownership loss or once the lease expires.
	let leaseExpiresAt = Date.now() + leaseMs;
	const renewRetryMs = Math.max(50, Math.floor(renewMs / 4));

	const schedule = (delayMs: number): void => {
		if (stopped) return;
		// F8: a stall that delays this tick past the writer lease lets a peer
		// replica acquire the flag while we believe we still hold it; measure it.
		const expectedFireAt = Date.now() + delayMs;
		timer = setTimeout(async () => {
			if (stopped) return;
			recordHeartbeatGap({ lock: "rw-writer", key: keys.writer, expectedFireAt, renewMs, leaseMs });
			let outcome: "renewed" | "ownership_lost" | "transient";
			let raceTimeout: ReturnType<typeof setTimeout> | undefined; // L1: clear on settle
			try {
				const renewPromise = redis.eval(RENEW_EXCLUSIVE_SCRIPT, 1, keys.writer, token, String(leaseMs));
				const timeoutPromise = new Promise<never>((_, reject) => {
					raceTimeout = setTimeout(() => reject(new Error("renew_timeout")), renewMs);
				});
				const res = await Promise.race([renewPromise, timeoutPromise]);
				outcome = res === 1 ? "renewed" : "ownership_lost";
			} catch {
				outcome = "transient";
			} finally {
				if (raceTimeout !== undefined) clearTimeout(raceTimeout);
			}
			if (stopped) return;
			if (outcome === "renewed") {
				leaseExpiresAt = Date.now() + leaseMs;
				schedule(renewMs);
			} else if (outcome === "ownership_lost" || Date.now() >= leaseExpiresAt) {
				onLost();
			} else {
				schedule(renewRetryMs);
			}
		}, delayMs);
	};

	schedule(renewMs);
	return () => {
		stopped = true;
		if (timer !== undefined) clearTimeout(timer);
	};
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Runs `fn` while holding a distributed readers-writer lock.
 *
 * - `mode='shared'`: multiple callers (across replicas) may hold concurrently.
 *   Blocked while a writer flag is set.
 * - `mode='exclusive'`: sets writer flag (halting new readers), then waits for
 *   all live readers to drain before entering the critical section.
 *
 * `fn` receives a `lostSignal` (`AbortSignal`) that aborts on a DEFINITIVE
 * ownership loss (token mismatch or lease expiry) — NOT on a transient renew
 * blip (the heartbeat already distinguishes them). Callers should plumb this
 * into long-running work so a lapsed lease aborts it BEFORE it commits, rather
 * than committing and then surfacing a `LockLostError` for a write that durably
 * happened (F2-L1).
 *
 * Throws `LockAcquireTimeoutError` if acquisition exceeds `acquireTimeoutMs`.
 * Throws `LockLostError` if the heartbeat detects ownership was lost.
 */
export async function withDistributedRWLock<T>(
	redis: Redis,
	keys: RWLockKeys,
	mode: RWLockMode,
	fn: (lostSignal: AbortSignal) => Promise<T>,
	opts: Partial<DistributedRWLockOptions> = {},
): Promise<T> {
	const merged: DistributedRWLockOptions = { ...DEFAULTS, ...opts };
	assertOptions(merged);
	const token = crypto.randomUUID();

	if (mode === "shared") {
		return runShared(redis, keys, token, merged, fn);
	}
	return runExclusive(redis, keys, token, merged, fn);
}

async function runShared<T>(
	redis: Redis,
	keys: RWLockKeys,
	token: string,
	opts: DistributedRWLockOptions,
	fn: (lostSignal: AbortSignal) => Promise<T>,
): Promise<T> {
	await acquireShared(redis, keys, token, opts);

	let lost = false;
	// F2-L1: abort in-flight work the instant ownership is DEFINITIVELY lost so it
	// rolls back BEFORE committing, instead of running to completion and then
	// surfacing LockLostError for a write that already happened.
	const lostController = new AbortController();
	const stopHeartbeat = startSharedHeartbeat(redis, keys, token, opts, () => {
		lost = true;
		if (!lostController.signal.aborted) lostController.abort(new LockLostError(keys.readers));
	});

	try {
		let result: T;
		try {
			result = await fn(lostController.signal);
		} catch (err) {
			// If ownership was definitively lost, `fn` likely threw an AbortError
			// from the lost-signal abort. Surface the canonical, retryable
			// LockLostError instead so the client sees a single coherent code and
			// treats it as "not committed" (the abort fired before any commit).
			if (lost) throw new LockLostError(keys.readers);
			throw err;
		}
		if (lost) throw new LockLostError(keys.readers);
		return result;
	} finally {
		stopHeartbeat();
		try {
			await redis.eval(RELEASE_SHARED_SCRIPT, 1, keys.readers, token);
		} catch (err) {
			console.error(
				JSON.stringify({ event: "rw_lock_reader_release_error", key: keys.readers, error: (err as Error).message }),
			);
		}
	}
}

async function runExclusive<T>(
	redis: Redis,
	keys: RWLockKeys,
	token: string,
	opts: DistributedRWLockOptions,
	fn: (lostSignal: AbortSignal) => Promise<T>,
): Promise<T> {
	const deadline = Date.now() + opts.acquireTimeoutMs;

	// One breaker (process-wide) and one error budget shared across both acquire
	// phases (set-flag + wait-readers-drained) so a mid-acquire outage doesn't get
	// a fresh budget at the second phase.
	const breaker = getRedisCircuitBreaker();
	const errorBudget = new AcquireErrorBudget(opts.errorBudgetMs);

	await acquireExclusive(redis, keys, token, opts, breaker, errorBudget);

	// Start heartbeat immediately after acquiring flag so it doesn't expire
	// while we wait for readers to drain.
	let lost = false;
	// F2-L1: abort in-flight work the instant ownership is DEFINITIVELY lost so it
	// rolls back BEFORE committing, instead of running to completion and then
	// surfacing LockLostError for a write that already committed + INCR'd.
	const lostController = new AbortController();
	const stopHeartbeat = startExclusiveHeartbeat(redis, keys, token, opts, () => {
		lost = true;
		if (!lostController.signal.aborted) lostController.abort(new LockLostError(keys.writer));
	});

	try {
		await waitReadersDrained(redis, keys, token, opts, deadline, breaker, errorBudget);
		if (lost) throw new LockLostError(keys.writer);

		let result: T;
		try {
			result = await fn(lostController.signal);
		} catch (err) {
			// If ownership was definitively lost, `fn` likely threw an AbortError
			// from the lost-signal abort. Surface the canonical, retryable
			// LockLostError instead so the client sees a single coherent code and
			// treats it as "not committed" (the abort fired before any commit).
			if (lost) throw new LockLostError(keys.writer);
			throw err;
		}
		if (lost) throw new LockLostError(keys.writer);
		return result;
	} finally {
		stopHeartbeat();
		try {
			await redis.eval(RELEASE_EXCLUSIVE_SCRIPT, 1, keys.writer, token);
		} catch (err) {
			console.error(
				JSON.stringify({ event: "rw_lock_writer_release_error", key: keys.writer, error: (err as Error).message }),
			);
		}
	}
}

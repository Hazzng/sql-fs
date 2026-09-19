/**
 * Boot-time exec-lock configuration (issue #173).
 *
 * Parses the `REDIS_EXEC_LOCK_*` / `REDIS_RWLOCK_READER_LEASE_MS` env vars and
 * enforces the one invariant that relates them: the acquire window must outlast
 * the lease it waits on. Validated here, at startup, so a misconfigured
 * deployment refuses to boot rather than surfacing as unexplained 503s on the
 * first contended exec.
 */

import { parseNonNegativeInt, parsePositiveInt } from "../redis/config.js";
import type { DistributedRWLockOptions } from "./distributed-rw-lock.js";

export type ExecLockOptions = Pick<
	DistributedRWLockOptions,
	"leaseMs" | "renewMs" | "acquireTimeoutMs" | "acquireRetryMs" | "readerLeaseMs"
>;

/**
 * Lease (60 s) + ~15 s reap margin. Long enough to ride out a crashed holder's
 * lease expiry, short enough to answer inside typical ingress timeouts
 * (commonly 60-240 s) — the previous 300 s sat above them, so the connection
 * was severed and the 503 never reached the client. A caller that genuinely
 * needs to queue behind a full-length exec retries on the 503; that is what
 * `ELOCKTIMEOUT -> 503 retryable` is for.
 */
export const DEFAULT_ACQUIRE_TIMEOUT_MS = 75_000;

/**
 * A crashed holder's key is only reaped when its lease expires, so an acquire
 * window at or below the lease converts every crashed-holder wait into a 503
 * instead of the automatic recovery the lease exists to provide.
 */
export function assertAcquireTimeoutAboveLeases(opts: ExecLockOptions): void {
	if (opts.acquireTimeoutMs <= opts.leaseMs) {
		throw Object.assign(
			new Error(
				`REDIS_EXEC_LOCK_ACQUIRE_TIMEOUT_MS (${opts.acquireTimeoutMs}) must be strictly greater than REDIS_EXEC_LOCK_LEASE_MS (${opts.leaseMs}): a crashed holder's lock is only reaped when its lease expires, so a shorter acquire window makes crashed-holder recovery impossible and returns 503 instead.`,
			),
			{ code: "ERR_ACQUIRE_TIMEOUT_INVARIANT" },
		);
	}
	if (opts.acquireTimeoutMs <= opts.readerLeaseMs) {
		throw Object.assign(
			new Error(
				`REDIS_EXEC_LOCK_ACQUIRE_TIMEOUT_MS (${opts.acquireTimeoutMs}) must be strictly greater than REDIS_RWLOCK_READER_LEASE_MS (${opts.readerLeaseMs}): a crashed reader's ZSET entry is only reaped when its lease expires, so a shorter acquire window makes a waiting writer give up before the stale reader can be reaped.`,
			),
			{ code: "ERR_ACQUIRE_TIMEOUT_INVARIANT" },
		);
	}
}

/** Reads the exec-lock env vars and validates them; throws on a config that breaks the invariant above. */
export function loadExecLockOptions(): ExecLockOptions {
	const opts: ExecLockOptions = {
		// A zero lease/renewal interval passes the acquire-timeout invariant
		// above but is rejected by the lock validators at request time, so
		// fail fast here instead of booting a deployment whose first
		// contended exec 503s. acquireTimeoutMs stays non-negative: 0 is
		// already refused below with the invariant message.
		leaseMs: parsePositiveInt("REDIS_EXEC_LOCK_LEASE_MS", 60_000),
		renewMs: parsePositiveInt("REDIS_EXEC_LOCK_RENEW_MS", 20_000),
		acquireTimeoutMs: parseNonNegativeInt("REDIS_EXEC_LOCK_ACQUIRE_TIMEOUT_MS", DEFAULT_ACQUIRE_TIMEOUT_MS),
		// F9d: tunable acquire poll interval (jittered to [retryMs/2, retryMs]).
		acquireRetryMs: parsePositiveInt("REDIS_EXEC_LOCK_ACQUIRE_RETRY_MS", 50),
		readerLeaseMs: parsePositiveInt("REDIS_RWLOCK_READER_LEASE_MS", 60_000),
	};
	assertAcquireTimeoutAboveLeases(opts);
	return opts;
}

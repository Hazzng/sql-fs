/**
 * Script-tx scope for the write routes, with the F2-L1 lock-loss check the exec path already makes.
 */

import { LockLostError } from "../distributed-lock.js";
import type { Session } from "../session-manager.js";

/**
 * Run `fn` inside the session's script-tx scope, refusing to commit when the distributed exec lock
 * was definitively lost while it ran.
 *
 * `SessionScopedFs.run` commits as soon as `fn` returns, and `withDistributedLock` only raises
 * `LockLostError` afterwards — but ELOCKLOST is documented and mapped as retryable precisely
 * because nothing committed (`mapFsErrorToStatus`), and `execWithRuntimeThrottle` keeps that
 * promise by aborting its own scope (F2-L1). A route that commits anyway hands the client a 503
 * saying "not written" about a write that is durable, and lets that write race the replica which
 * took over the expired lease. Throwing here rolls the scope back instead.
 *
 * The check is only as timely as the signal: `lockLostSignal` fires from the lock's heartbeat, so
 * detection lags an actual loss by up to one renew interval (`REDIS_EXEC_LOCK_RENEW_MS`, 20s). A
 * request that starts and finishes inside that window commits without ever seeing that the lease
 * was gone — and a replica that took the lease over can have read stale state and overwritten the
 * result. Multi-replica testing reproduced exactly that: a 14s overlap under default settings,
 * both replicas exiting 0, one committed write silently destroyed. `pg_advisory_xact_lock`
 * serializes the transactions but cannot fence a read the winner already took.
 *
 * Closing it needs the commit fenced in the database on an epoch the takeover replica invalidates
 * — the deferred F2-L2 (#131), not something a signal check on this side can do. The exec path
 * carries the same window.
 *
 * Backends without script-tx (in-memory) have no scope to roll back, so `fn` runs directly.
 */
export async function runInScriptTx<T>(session: Session, fn: () => Promise<T>): Promise<T> {
	const scriptTx = session.scriptTx;
	if (scriptTx === undefined) return fn();
	return scriptTx.run(async () => {
		const result = await fn();
		// Keyed off the dedicated lost-signal, not a composed abort: a plain timeout still commits.
		if (session.lockLostSignal?.aborted === true) {
			throw new LockLostError("write aborted: distributed exec lock lost mid-request");
		}
		return result;
	});
}

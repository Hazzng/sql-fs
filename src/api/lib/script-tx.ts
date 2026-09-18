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
 * A lease lost during the COMMIT round-trip itself still commits and is still reported as
 * retryable, so the client may double-apply on retry: closing that needs the commit fenced in the
 * database on an epoch the takeover replica invalidates, which is the deferred F2-L2 (#131) and is
 * not something a signal check on this side of the round-trip can do. The exec path carries the
 * same window.
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

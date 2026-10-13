import { LockLostError } from "../distributed-lock.js";
import { sessionLeaseSignal } from "../session-lease-context.js";
import { ownerLeaseLost } from "../worker-owner/cancellation.js";

export function assertScriptLeaseHeld(message: string): void {
	if (sessionLeaseSignal()?.aborted === true || ownerLeaseLost()) {
		throw new LockLostError(message);
	}
}

import { ownerLeaseLost } from "../../execution/owner-cancellation.js";
import { LockLostError } from "../distributed-lock.js";
import { sessionLeaseSignal } from "../session-lease-context.js";

export function assertScriptLeaseHeld(message: string): void {
	if (sessionLeaseSignal()?.aborted === true || ownerLeaseLost()) {
		throw new LockLostError(message);
	}
}

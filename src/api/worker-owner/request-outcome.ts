import { preservesAmbiguousOutcome } from "../errors.js";
import { mayApply, OutcomeUnknownError, type OwnerCommand, type OwnerCommandKind } from "./protocol.js";

export function workerFailureCode(error: unknown): string | undefined {
	return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
		? error.code
		: undefined;
}

export class RequestOutcome {
	private mayHaveEffects = false;
	private creatingAttachDispatched = false;
	private execDispatched = false;
	private committedFsWrite = false;
	private scopeOpen = false;

	dispatched<K extends OwnerCommandKind>(command: OwnerCommand<K>): void {
		if (mayApply(command)) this.mayHaveEffects = true;
		if (command.kind === "attach" && mayApply(command)) this.creatingAttachDispatched = true;
		if (command.kind === "exec") this.execDispatched = true;
	}

	acknowledged<K extends OwnerCommandKind>(command: OwnerCommand<K>, hasReadOnlyContext: boolean): void {
		if (command.kind === "beginScope") this.scopeOpen = true;
		if (command.kind === "endScope" || command.kind === "abortScope") this.scopeOpen = false;
		if (mayApply(command) && command.kind !== "exec" && !this.scopeOpen && !hasReadOnlyContext) {
			this.committedFsWrite = true;
		}
	}

	transportFailure(error: unknown): unknown {
		return this.mayHaveEffects && workerFailureCode(error) === "EWORKER_UNAVAILABLE"
			? new OutcomeUnknownError()
			: error;
	}

	leaseLoss(error?: unknown): Error | undefined {
		if (!this.execDispatched && !this.committedFsWrite && !this.creatingAttachDispatched) return undefined;
		return error instanceof Error && preservesAmbiguousOutcome(error) ? error : new OutcomeUnknownError();
	}

	runtimeFailure(error: unknown): unknown {
		// A buffered exec can commit its journal and then fail while reconciling
		// the worker's cache (for example, ECOHERENCE after endScope). The reply
		// proves the worker is alive, but not that the script had no effects.
		if (workerFailureCode(error) === "ECOHERENCE" && this.execDispatched) {
			return new OutcomeUnknownError(
				"EEXEC_OUTCOME_UNKNOWN: exec may have committed before coherence recovery failed; inspect sandbox state before proceeding; do not automatically replay the execution",
			);
		}
		return workerFailureCode(error) === "ERUNTIME_BUSY" && (this.execDispatched || this.committedFsWrite)
			? new OutcomeUnknownError(
					"EEXEC_OUTCOME_UNKNOWN: an earlier operation in this request may have applied; do not replay the request",
				)
			: error;
	}
}

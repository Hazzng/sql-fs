import { mayApply, OutcomeUnknownError, type OwnerCommand, type OwnerReply } from "./protocol.js";

export function assertWorkerMessageBudget(value: unknown, maxBytes: number, additionalBytes = 0): void {
	let bytes = additionalBytes;
	const seen = new Set<object>();
	const exceed = (): never => {
		throw Object.assign(new Error("EFBIG: worker message exceeds its byte budget"), { code: "EFBIG" });
	};
	const charge = (count: number): void => {
		bytes += count;
		if (bytes > maxBytes) exceed();
	};
	if (!Number.isSafeInteger(additionalBytes) || additionalBytes < 0 || additionalBytes > maxBytes) exceed();
	const visit = (item: unknown, depth: number): void => {
		if (depth > 64) exceed();
		if (typeof item === "string") {
			charge(Buffer.byteLength(item));
			return;
		}
		if (item === null || typeof item !== "object") {
			charge(16);
			return;
		}
		if (seen.has(item)) return;
		seen.add(item);
		if (ArrayBuffer.isView(item)) {
			if (!seen.has(item.buffer)) {
				seen.add(item.buffer);
				charge(item.buffer.byteLength);
			}
			return;
		}
		if (item instanceof ArrayBuffer || item instanceof SharedArrayBuffer) {
			charge(item.byteLength);
			return;
		}
		charge(16);
		for (const key in item) {
			if (!Object.hasOwn(item, key)) continue;
			charge(Buffer.byteLength(key) + 8);
			visit((item as Record<string, unknown>)[key], depth + 1);
		}
	};
	visit(value, 0);
}

export function budgetWorkerReply(reply: OwnerReply, command: OwnerCommand, maxBytes: number): OwnerReply {
	try {
		assertWorkerMessageBudget(reply, maxBytes);
		return reply;
	} catch {
		const failure =
			mayApply(command) || (!reply.ok && reply.error.code === "EEXEC_OUTCOME_UNKNOWN")
				? new OutcomeUnknownError(
						"EEXEC_OUTCOME_UNKNOWN: worker reply exceeds its byte budget; do not replay the request",
					)
				: Object.assign(new Error("EFBIG: worker reply exceeds its byte budget"), { code: "EFBIG" });
		const bounded: OwnerReply = {
			id: reply.id,
			generation: reply.generation,
			metadata: reply.metadata,
			readOnlyViolated: reply.readOnlyViolated,
			memory: reply.memory,
			ok: false,
			error: { name: failure.name, message: failure.message, code: failure.code },
		};
		try {
			assertWorkerMessageBudget(bounded, maxBytes);
			return bounded;
		} catch {
			const unknown = new OutcomeUnknownError();
			const retired: OwnerReply = {
				...bounded,
				metadata: undefined,
				error: { name: unknown.name, message: unknown.message, code: unknown.code },
			};
			assertWorkerMessageBudget(retired, maxBytes);
			return retired;
		}
	}
}

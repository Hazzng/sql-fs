import { AsyncLocalStorage } from "node:async_hooks";

export const sessionLeaseContext = new AsyncLocalStorage<{ readonly lostSignal?: AbortSignal }>();

export function sessionLeaseSignal(): AbortSignal | undefined {
	return sessionLeaseContext.getStore()?.lostSignal;
}

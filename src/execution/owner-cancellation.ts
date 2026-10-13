import { AsyncLocalStorage } from "node:async_hooks";

export const ownerCancellation = new AsyncLocalStorage<Int32Array>();

export function ownerLeaseLost(): boolean {
	const words = ownerCancellation.getStore();
	return words !== undefined && Atomics.load(words, 1) !== 0;
}

import { AsyncLocalStorage } from "node:async_hooks";

export interface WorkerRequestContext {
	readonly bytes: number;
	readonly signal?: AbortSignal;
}

export const workerRequestContext = new AsyncLocalStorage<WorkerRequestContext>();

import type { RuntimeOptions } from "../session-runtime/engine.js";

export interface RuntimeAdmissionOptions {
	readonly maxConcurrentPython?: number;
	readonly maxConcurrentJs?: number;
}

interface SemaphoreWaiter {
	readonly resolve: () => void;
	readonly reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout> | undefined;
	onAbort: (() => void) | undefined;
	readonly signal: AbortSignal | undefined;
	settled: boolean;
}

interface Semaphore {
	readonly limit: number;
	readonly maxWaiters: number;
	readonly waitTimeoutMs: number;
	inFlight: number;
	readonly waiters: SemaphoreWaiter[];
}

export class RuntimeBackpressureError extends Error {
	readonly code = "ERUNTIME_BUSY";
	constructor(runtime: string) {
		super(`ERUNTIME_BUSY: ${runtime} runtime queue is full or wait timed out`);
		this.name = "RuntimeBackpressureError";
	}
}

export class RuntimeAdmission {
	private readonly pythonSem: Semaphore;
	private readonly jsSem: Semaphore;

	constructor({ maxConcurrentPython, maxConcurrentJs }: RuntimeAdmissionOptions) {
		const maxPyWaiters = Number(process.env.MAX_PYTHON_QUEUE ?? "100");
		const maxJsWaiters = Number(process.env.MAX_JS_QUEUE ?? "100");
		const pyTimeout = Number(process.env.PYTHON_QUEUE_TIMEOUT_MS ?? "60000");
		const jsTimeout = Number(process.env.JS_QUEUE_TIMEOUT_MS ?? "60000");
		this.pythonSem = {
			limit: maxConcurrentPython ?? Number(process.env.MAX_CONCURRENT_PYTHON ?? "5"),
			maxWaiters: maxPyWaiters,
			waitTimeoutMs: pyTimeout,
			inFlight: 0,
			waiters: [],
		};
		this.jsSem = {
			limit: maxConcurrentJs ?? Number(process.env.MAX_CONCURRENT_JS ?? "5"),
			maxWaiters: maxJsWaiters,
			waitTimeoutMs: jsTimeout,
			inFlight: 0,
			waiters: [],
		};
	}

	get metrics(): { pythonActive: number; pythonQueued: number; javascriptActive: number; javascriptQueued: number } {
		return {
			pythonActive: this.pythonSem.inFlight,
			pythonQueued: this.pythonSem.waiters.length,
			javascriptActive: this.jsSem.inFlight,
			javascriptQueued: this.jsSem.waiters.length,
		};
	}

	shutdown(): void {
		for (const sem of [this.pythonSem, this.jsSem]) {
			while (sem.waiters.length > 0) {
				const waiter = sem.waiters.shift();
				if (waiter === undefined) break;
				waiter.reject(new RuntimeBackpressureError("shutting_down"));
			}
		}
	}

	private acquireSlot(sem: Semaphore, signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) {
			return Promise.reject(Object.assign(new Error("ABORTED"), { code: "ABORTED", name: "AbortError" }));
		}
		if (sem.inFlight < sem.limit) {
			sem.inFlight++;
			return Promise.resolve();
		}
		if (sem.waiters.length >= sem.maxWaiters) {
			return Promise.reject(new RuntimeBackpressureError("queue_full"));
		}
		return new Promise<void>((resolve, reject) => {
			const waiter: SemaphoreWaiter = {
				resolve: () => {
					if (waiter.settled) return;
					waiter.settled = true;
					if (waiter.timer !== undefined) clearTimeout(waiter.timer);
					if (waiter.onAbort !== undefined && waiter.signal !== undefined) {
						waiter.signal.removeEventListener("abort", waiter.onAbort);
					}
					resolve();
				},
				reject: (err: Error) => {
					if (waiter.settled) return;
					waiter.settled = true;
					if (waiter.timer !== undefined) clearTimeout(waiter.timer);
					if (waiter.onAbort !== undefined && waiter.signal !== undefined) {
						waiter.signal.removeEventListener("abort", waiter.onAbort);
					}
					const idx = sem.waiters.indexOf(waiter);
					if (idx >= 0) sem.waiters.splice(idx, 1);
					reject(err);
				},
				timer: undefined,
				onAbort: undefined,
				signal,
				settled: false,
			};
			waiter.timer = setTimeout(() => waiter.reject(new RuntimeBackpressureError("wait_timeout")), sem.waitTimeoutMs);
			if (signal !== undefined) {
				const onAbort = (): void =>
					waiter.reject(Object.assign(new Error("ABORTED"), { code: "ABORTED", name: "AbortError" }));
				waiter.onAbort = onAbort;
				signal.addEventListener("abort", onAbort, { once: true });
			}
			sem.waiters.push(waiter);
		});
	}

	private releaseSlot(sem: Semaphore): void {
		while (sem.waiters.length > 0) {
			const next = sem.waiters.shift();
			if (next === undefined) break;
			if (next.settled) continue;
			next.resolve();
			return;
		}
		sem.inFlight--;
	}

	async run<T>(runtimeOptions: RuntimeOptions, signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
		const usesPython = runtimeOptions.python;
		const usesJs = runtimeOptions.javascript;
		if (!usesPython && !usesJs) return fn();
		if (usesPython) await this.acquireSlot(this.pythonSem, signal);
		if (usesJs) {
			try {
				await this.acquireSlot(this.jsSem, signal);
			} catch (e) {
				if (usesPython) this.releaseSlot(this.pythonSem);
				throw e;
			}
		}

		try {
			return await fn();
		} finally {
			if (usesJs) this.releaseSlot(this.jsSem);
			if (usesPython) this.releaseSlot(this.pythonSem);
		}
	}
}

/**
 * Async readers-writer lock with writer-priority.
 *
 * Contract:
 *  - Multiple readers can hold the lock simultaneously (shared mode).
 *  - At most one writer can hold the lock at a time (exclusive mode).
 *  - While a writer holds the lock, no readers run.
 *  - Writer-priority: when an exclusive waiter is queued, new shared
 *    acquisitions wait behind it. This prevents reader starvation of the
 *    (rare) writers that mutate the sandbox.
 *  - Aborting via `signal` cancels a pending acquisition; it never affects an
 *    already-held lock. Aborted waiters surface `Error('ABORTED')` with
 *    `code: "ABORTED"` and `name: "AbortError"`.
 *
 * Drop-in compatible with the `runExclusive` shape used by `async-mutex`:
 * existing call sites that previously held a `Mutex` may use this lock with
 * no changes.
 */

type LockMode = "shared" | "exclusive";

interface Waiter {
	readonly mode: LockMode;
	resolve: () => void;
	reject: (err: Error) => void;
	readonly signal: AbortSignal | undefined;
	onAbort: (() => void) | undefined;
	settled: boolean;
}

function makeAbortError(): Error {
	return Object.assign(new Error("ABORTED"), { code: "ABORTED", name: "AbortError" });
}

export class RWLock {
	#readers = 0;
	#writerActive = false;
	readonly #queue: Waiter[] = [];

	/** Active reader count (for diagnostics/tests). */
	get activeReaders(): number {
		return this.#readers;
	}

	/** True iff a writer currently holds the lock. */
	get writerHeld(): boolean {
		return this.#writerActive;
	}

	/** Pending acquisitions that have not yet been granted. */
	get pendingCount(): number {
		let n = 0;
		for (const w of this.#queue) if (!w.settled) n++;
		return n;
	}

	async runShared<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		await this.#acquire("shared", signal);
		try {
			return await fn();
		} finally {
			this.#releaseShared();
		}
	}

	async runExclusive<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		await this.#acquire("exclusive", signal);
		try {
			return await fn();
		} finally {
			this.#releaseExclusive();
		}
	}

	#acquire(mode: LockMode, signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) return Promise.reject(makeAbortError());

		if (mode === "shared") {
			// Writer-priority: a queued writer blocks new readers, even if the
			// lock is currently free or held in shared mode.
			if (!this.#writerActive && !this.#hasQueuedWriter()) {
				this.#readers++;
				return Promise.resolve();
			}
		} else {
			if (!this.#writerActive && this.#readers === 0) {
				this.#writerActive = true;
				return Promise.resolve();
			}
		}
		return this.#enqueue(mode, signal);
	}

	#enqueue(mode: LockMode, signal: AbortSignal | undefined): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const waiter: Waiter = {
				mode,
				resolve: () => {},
				reject: () => {},
				signal,
				onAbort: undefined,
				settled: false,
			};
			waiter.resolve = (): void => {
				if (waiter.settled) return;
				waiter.settled = true;
				if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
					waiter.signal.removeEventListener("abort", waiter.onAbort);
				}
				resolve();
			};
			waiter.reject = (err: Error): void => {
				if (waiter.settled) return;
				waiter.settled = true;
				if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
					waiter.signal.removeEventListener("abort", waiter.onAbort);
				}
				const idx = this.#queue.indexOf(waiter);
				if (idx >= 0) this.#queue.splice(idx, 1);
				reject(err);
			};
			if (signal !== undefined) {
				const onAbort = (): void => waiter.reject(makeAbortError());
				waiter.onAbort = onAbort;
				signal.addEventListener("abort", onAbort, { once: true });
			}
			this.#queue.push(waiter);
		});
	}

	#releaseShared(): void {
		if (this.#readers === 0) {
			throw new Error("RWLock: releaseShared called with no active readers");
		}
		this.#readers--;
		if (this.#readers === 0) this.#dispatch();
	}

	#releaseExclusive(): void {
		if (!this.#writerActive) {
			throw new Error("RWLock: releaseExclusive called with no active writer");
		}
		this.#writerActive = false;
		this.#dispatch();
	}

	#dispatch(): void {
		// Discard any settled waiters at the head (aborted while queued).
		while (this.#queue.length > 0 && this.#queue[0]!.settled) this.#queue.shift();
		if (this.#queue.length === 0) return;
		if (this.#writerActive) return;

		const head = this.#queue[0]!;
		if (head.mode === "exclusive") {
			if (this.#readers > 0) return;
			this.#queue.shift();
			this.#writerActive = true;
			head.resolve();
			return;
		}

		// Wake every consecutive shared waiter until we hit a writer or empty
		// the queue. This batches a parallel-reader handoff into a single
		// dispatch pass.
		while (this.#queue.length > 0) {
			const next = this.#queue[0]!;
			if (next.settled) {
				this.#queue.shift();
				continue;
			}
			if (next.mode !== "shared") break;
			this.#queue.shift();
			this.#readers++;
			next.resolve();
		}
	}

	#hasQueuedWriter(): boolean {
		for (const w of this.#queue) {
			if (w.settled) continue;
			if (w.mode === "exclusive") return true;
		}
		return false;
	}
}

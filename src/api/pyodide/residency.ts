/**
 * PyodideResidency — global LRU registry that bounds the number of resident
 * (subprocess-owning) {@link PyodideSandbox} managers at `MAX_RESIDENT_PYODIDE`,
 * **independent of `SESSION_IDLE_MS`** (design D4). Without this, every active
 * pyodide session would keep a warm ~2 GB Deno child alive until the (long)
 * session idle timeout, and N active sessions would accumulate N children.
 *
 * Two distinct bounds work together (design §5):
 *   - the exec **semaphore** (`MAX_CONCURRENT_PYODIDE`) caps *in-flight execs*;
 *   - this **residency** caps *resident subprocesses* and idle-kills them after a
 *     shorter `PYODIDE_IDLE_MS`.
 * The startup invariant `MAX_RESIDENT_PYODIDE >= MAX_CONCURRENT_PYODIDE` (enforced
 * by the SessionManager) guarantees a busy worker never needs to be evicted.
 *
 * Atomic admission: a single `async-mutex` wraps *select an eviction victim →
 * construct the manager → register* as one critical section, so concurrent
 * admissions cannot both observe a free slot and exceed the cap. The `spawn`
 * thunk is CHEAP — it only constructs a `PyodideSandbox` (no Deno child, no
 * Pyodide load). The multi-second Deno spawn + package init happens LAZILY in
 * `PyodideSandbox.run()`, OUTSIDE this mutex (lazy post-semaphore admission), so
 * the critical section never serializes cold starts. **`starting` and `busy`
 * workers are never evictable.**
 *
 * Eviction / idle-kill disposes a worker (terminal — its Deno child is SIGKILLed).
 * The owning session SURVIVES: it observes `worker.disposed` on its next exec and
 * re-admits a fresh manager through {@link admit} (cold-starting a new child),
 * which is what makes residency independent of the session lifetime.
 */

import { Mutex } from "async-mutex";
import type { PyodideSandbox, WorkerState } from "./manager.js";

/** Default cap on resident pyodide subprocesses (design D4). */
export const MAX_RESIDENT_PYODIDE_DEFAULT = 2;
/** Default idle window before a resident subprocess is idle-killed (ms). */
export const PYODIDE_IDLE_MS_DEFAULT = 120_000;

/**
 * The subset of {@link PyodideSandbox} the residency depends on. Keeping it narrow
 * lets unit tests drive admission/eviction with a lightweight fake worker.
 */
export interface ResidentWorker {
	readonly state: WorkerState;
	dispose(): Promise<void>;
}

export interface PyodideResidencyOptions {
	readonly maxResident: number;
	readonly idleMs: number;
	/**
	 * Idle-kill sweep cadence (ms). Defaults to a fraction of `idleMs` (bounded to
	 * [1s, 30s]). Set explicitly in tests for deterministic timing.
	 */
	readonly sweepIntervalMs?: number;
}

export class PyodideResidency {
	readonly #maxResident: number;
	readonly #idleMs: number;
	readonly #mutex = new Mutex();
	/** Resident workers → last-touched epoch ms (set on admit, refreshed by {@link touch}). */
	readonly #residents = new Map<ResidentWorker, number>();
	#sweepTimer: ReturnType<typeof setInterval> | undefined;

	constructor(opts: PyodideResidencyOptions) {
		if (!Number.isInteger(opts.maxResident) || opts.maxResident < 1) {
			throw Object.assign(new Error(`EINVAL: maxResident must be a positive integer (got ${opts.maxResident})`), {
				code: "EINVAL",
			});
		}
		this.#maxResident = opts.maxResident;
		this.#idleMs = opts.idleMs;
		if (Number.isFinite(opts.idleMs) && opts.idleMs > 0) {
			const sweepMs = opts.sweepIntervalMs ?? Math.max(1_000, Math.min(opts.idleMs, 30_000));
			this.#sweepTimer = setInterval(() => this.#sweep(), sweepMs);
			// Never block process exit on the sweep.
			if (typeof this.#sweepTimer.unref === "function") this.#sweepTimer.unref();
		}
	}

	/** Current resident count (observability / tests). */
	get residentCount(): number {
		return this.#residents.size;
	}

	get maxResident(): number {
		return this.#maxResident;
	}

	/**
	 * Atomic admission. Inside the admission mutex: if at capacity, select an idle
	 * LRU victim and evict it; then run the caller's `spawn` (a CHEAP `PyodideSandbox`
	 * construction — NOT the Deno child / Pyodide load, which happen lazily in
	 * `run()` outside this mutex) and register the new worker. If `spawn` throws, the
	 * slot is rolled back — the worker is never registered — and the error is
	 * rethrown. Returns the admitted worker.
	 */
	async admit(spawn: () => PyodideSandbox | Promise<PyodideSandbox>): Promise<PyodideSandbox> {
		return this.#mutex.runExclusive(async () => {
			if (this.#residents.size >= this.#maxResident) {
				const victim = this.#selectVictim();
				if (victim !== undefined) {
					this.#residents.delete(victim);
					try {
						await victim.dispose();
					} catch {
						// best-effort — the victim's child is being torn down
					}
				}
				// else: every resident worker is starting/busy (never evictable). This is
				// unreachable in practice: the SessionManager calls admit() ONLY while
				// holding a pyodide semaphore slot AND before the admitting exec is busy,
				// so the number of busy workers is <= MAX_CONCURRENT - 1 < MAX_RESIDENT —
				// hence an idle/cold eviction victim always exists at capacity. We still
				// proceed (soft over-admit by one) rather than block admission as a
				// belt-and-braces fallback; the next sweep/admit reclaims the surplus
				// once a worker goes idle.
			}
			// `spawn` only CONSTRUCTS the manager (cheap); the Deno child + Pyodide load
			// happen lazily in run(), outside this mutex. Registering ONLY on success
			// rolls the slot back if construction throws (the worker is never added).
			const worker = await spawn();
			this.#residents.set(worker, Date.now());
			return worker;
		});
	}

	/** Refresh a worker's idle clock. Call after each completed run. No-op if not resident. */
	touch(worker: ResidentWorker): void {
		if (this.#residents.has(worker)) this.#residents.set(worker, Date.now());
	}

	/**
	 * Drop a worker from the registry (session teardown / failed-create rollback).
	 * Idempotent; does NOT dispose — the caller owns disposal.
	 */
	release(worker: ResidentWorker): void {
		this.#residents.delete(worker);
	}

	/** Stop the idle-kill sweep timer. Call on shutdown. Idempotent. */
	stop(): void {
		if (this.#sweepTimer !== undefined) {
			clearInterval(this.#sweepTimer);
			this.#sweepTimer = undefined;
		}
	}

	/** LRU victim among EVICTABLE (non-starting/busy) workers; undefined if none. */
	#selectVictim(): ResidentWorker | undefined {
		let victim: ResidentWorker | undefined;
		let oldest = Number.POSITIVE_INFINITY;
		for (const [worker, touched] of this.#residents) {
			if (!this.#evictable(worker)) continue;
			if (touched < oldest) {
				oldest = touched;
				victim = worker;
			}
		}
		return victim;
	}

	/**
	 * `starting`/`busy` are NEVER evictable (design D4 — a worker mid-init or
	 * mid-run must not be killed out from under its request). `cold` (admitted but
	 * never ran), `idle`, and the already-child-less `dead`/`terminating` are fair
	 * game.
	 */
	#evictable(worker: ResidentWorker): boolean {
		return worker.state !== "starting" && worker.state !== "busy";
	}

	#sweep(): void {
		const now = Date.now();
		// Snapshot entries — dispose() mutates the map mid-iteration.
		for (const [worker, touched] of [...this.#residents]) {
			if (!this.#evictable(worker)) continue;
			if (now - touched >= this.#idleMs) {
				this.#residents.delete(worker);
				// Swallow a dispose() rejection — the child is being torn down best-effort
				// and an unhandled rejection from the timer must not crash the process.
				worker.dispose().catch(() => {});
			}
		}
	}
}

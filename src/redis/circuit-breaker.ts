/**
 * Process-wide Redis circuit breaker for the distributed-lock ACQUIRE paths.
 *
 * Problem (F5): the lock acquire loops conflate "lock busy" (contention) with
 * "Redis unreachable" (a thrown connection-class error). Both are retried until
 * `acquireTimeoutMs` (default 300 s), so a Redis outage hangs every exec for
 * ~5 minutes on an otherwise-healthy Postgres.
 *
 * This breaker is consulted by the acquire paths ONLY. Renew/release paths must
 * keep tolerating transient errors (dropping a lease or skipping a RELEASE would
 * regress H4 / leak ZSET+flag keys for a full lease), so they do NOT use it.
 *
 * State machine:
 *   - CLOSED: acquire proceeds. Each thrown (connection-class) error bumps a
 *     consecutive-failure counter; a success resets it. At `threshold`
 *     consecutive failures the breaker opens.
 *   - OPEN: acquire fast-fails immediately. After `openMs` the breaker becomes
 *     half-open and lets a single probe through.
 *   - HALF_OPEN: one probe is allowed. A success closes the breaker; a failure
 *     re-opens it for another `openMs`.
 *
 * The breaker is intentionally process-wide (one Redis per process), not
 * per-key: a Redis outage is global, so once we've seen K failures there is no
 * value in letting other keys re-discover the outage one slow acquire at a time.
 */

type BreakerState = "closed" | "open" | "half_open";

export interface RedisCircuitBreakerOptions {
	/** Consecutive connection-class failures before the breaker opens. */
	readonly threshold: number;
	/** How long the breaker stays open before allowing a half-open probe (ms). */
	readonly openMs: number;
	/** Clock source (injectable for tests). Defaults to `Date.now`. */
	readonly now?: () => number;
}

const DEFAULT_OPTIONS: Required<Omit<RedisCircuitBreakerOptions, "now">> = {
	threshold: 5,
	openMs: 5_000,
};

/** Thrown by `assertClosed()` when the breaker is open. Carries `code` so callers can distinguish it. */
export class CircuitOpenError extends Error {
	readonly code = "EREDISCIRCUITOPEN";
	constructor() {
		super("EREDISCIRCUITOPEN: Redis circuit breaker is open (Redis appears unreachable)");
		this.name = "CircuitOpenError";
	}
}

export class RedisCircuitBreaker {
	#state: BreakerState = "closed";
	#consecutiveFailures = 0;
	#openedAt = 0;
	#halfOpenInFlight = false;
	readonly #threshold: number;
	readonly #openMs: number;
	readonly #now: () => number;

	constructor(options: RedisCircuitBreakerOptions = DEFAULT_OPTIONS) {
		this.#threshold = options.threshold ?? DEFAULT_OPTIONS.threshold;
		this.#openMs = options.openMs ?? DEFAULT_OPTIONS.openMs;
		this.#now = options.now ?? Date.now;
	}

	/**
	 * Returns `true` when acquire should fast-fail without touching Redis.
	 *
	 * When the open window has elapsed this transitions to half-open and lets a
	 * single probe through (returns `false` for that one caller), so a recovering
	 * Redis can close the breaker.
	 */
	isOpen(): boolean {
		if (this.#state === "closed") return false;
		if (this.#state === "half_open") {
			// Only one probe at a time; everyone else keeps fast-failing.
			if (this.#halfOpenInFlight) return true;
			this.#halfOpenInFlight = true;
			return false;
		}
		// open: stay open until the cool-down elapses, then allow one probe.
		if (this.#now() - this.#openedAt >= this.#openMs) {
			this.#state = "half_open";
			this.#halfOpenInFlight = true;
			return false;
		}
		return true;
	}

	/** Throw `CircuitOpenError` when the breaker is open (and not letting a probe through). */
	assertClosed(): void {
		if (this.isOpen()) throw new CircuitOpenError();
	}

	/** A successful PING / eval / set: close the breaker and clear the failure run. */
	recordSuccess(): void {
		this.#state = "closed";
		this.#consecutiveFailures = 0;
		this.#halfOpenInFlight = false;
	}

	/** A thrown (connection-class) error: count it; open at threshold, or re-open a failed half-open probe. */
	recordFailure(): void {
		if (this.#state === "half_open") {
			this.#open();
			return;
		}
		this.#consecutiveFailures += 1;
		if (this.#consecutiveFailures >= this.#threshold) {
			this.#open();
		}
	}

	/** Current state, for tests/observability. */
	get state(): BreakerState {
		return this.#state;
	}

	#open(): void {
		this.#state = "open";
		this.#openedAt = this.#now();
		this.#halfOpenInFlight = false;
		this.#consecutiveFailures = this.#threshold;
	}
}

/**
 * Per-call error budget for an acquire loop. Advances ONLY on thrown
 * (connection-class) errors — genuine contention (a 0/non-OK Redis result) does
 * not consume it, so a busy lock still gets the full `acquireTimeoutMs` window.
 *
 * Construct one per acquire call; share it across the multiple loops of a single
 * acquire (e.g. the writer's set-flag loop and `waitReadersDrained`).
 */
export class AcquireErrorBudget {
	#firstErrorAt: number | undefined;
	readonly #budgetMs: number;
	readonly #now: () => number;

	constructor(budgetMs: number, now: () => number = Date.now) {
		this.#budgetMs = budgetMs;
		this.#now = now;
	}

	/** Record a thrown error. Returns `true` when the budget is now exhausted. */
	recordError(): boolean {
		const t = this.#now();
		if (this.#firstErrorAt === undefined) this.#firstErrorAt = t;
		return t - this.#firstErrorAt >= this.#budgetMs;
	}

	/** A successful Redis call: clear the error run so a later blip restarts the budget. */
	reset(): void {
		this.#firstErrorAt = undefined;
	}
}

/** Default per-call acquire error budget (ms): how long thrown errors are tolerated before fast-failing. */
export const DEFAULT_ACQUIRE_ERROR_BUDGET_MS = 4_000;

let singleton: RedisCircuitBreaker | undefined;

/** Process-wide breaker shared by every acquire path. */
export function getRedisCircuitBreaker(): RedisCircuitBreaker {
	if (singleton === undefined) {
		singleton = new RedisCircuitBreaker();
	}
	return singleton;
}

/** Test hook: drop the singleton so each test starts from a clean breaker. */
export function resetRedisCircuitBreakerForTest(): void {
	singleton = undefined;
}

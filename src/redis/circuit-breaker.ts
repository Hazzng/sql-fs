/**
 * Per-role Redis circuit breaker.
 *
 * Problem (F5): the lock acquire loops conflate "lock busy" (contention) with
 * "Redis unreachable" (a thrown connection-class error). Both are retried until
 * `acquireTimeoutMs` (default 300 s), so a Redis outage hangs every exec for
 * ~5 minutes on an otherwise-healthy Postgres.
 *
 * On the control role this breaker is consulted by the lock ACQUIRE paths ONLY.
 * Renew/release paths must keep tolerating transient errors (dropping a lease or
 * skipping a RELEASE would regress H4 / leak ZSET+flag keys for a full lease), so
 * they do NOT use it. On the data role it short-circuits best-effort cache I/O,
 * which is fail-open by contract.
 *
 * State machine:
 *   - CLOSED: acquire proceeds. Each thrown (connection-class) error bumps a
 *     consecutive-failure counter; a success resets it. At `threshold`
 *     consecutive failures the breaker opens.
 *   - OPEN: acquire fast-fails immediately. After `openMs` the breaker becomes
 *     half-open and lets a single probe through. Results arriving while open
 *     belong to commands admitted before it opened and are ignored — they can
 *     neither close it nor restart its cool-down (#167).
 *   - HALF_OPEN: one probe is allowed, minted with a generation ticket. Only a
 *     settle presenting the CURRENT ticket closes or re-opens the breaker; a
 *     pre-open straggler settling here carries no ticket (or a superseded one)
 *     and is ignored, so it can neither close the breaker onto an untested
 *     Redis nor restart the cool-down (#167).
 *
 * The breaker is intentionally per-role rather than per-key: a Redis outage is
 * global to a connection, so once we've seen K failures there is no value in
 * letting other keys re-discover it one slow acquire at a time. It is scoped by
 * role (#167) so a stalled data-plane cache can never fast-fail the control
 * plane's locks, nor the reverse.
 *
 * Every state transition logs `redis_circuit_open` / `redis_circuit_closed` with
 * the role: the original 114,213-request outage produced zero log lines beyond
 * request logs, which is why it was misdiagnosed.
 */

import type { RedisRole } from "./client.js";

type BreakerState = "closed" | "open" | "half_open";

export interface RedisCircuitBreakerOptions {
	/** Consecutive connection-class failures before the breaker opens. */
	readonly threshold: number;
	/** How long the breaker stays open before allowing a half-open probe (ms). */
	readonly openMs: number;
	/** Clock source (injectable for tests). Defaults to `Date.now`. */
	readonly now?: () => number;
	/** Role label emitted on transition events. Defaults to `"control"`. */
	readonly role?: RedisRole;
}

const DEFAULT_OPTIONS: Required<Omit<RedisCircuitBreakerOptions, "now" | "role">> = {
	threshold: 5,
	openMs: 5_000,
};

/**
 * Proof that the holder was admitted as the current half-open probe.
 * Minted by `tryAcquire()` on probe admission; settles present it to
 * `recordSuccess()` / `recordFailure()`, which honour only the current
 * generation. A straggler admitted before the breaker opened holds no ticket
 * (or a superseded one), so its late result cannot steer the breaker.
 */
export interface HalfOpenProbeTicket {
	readonly generation: number;
}

/** Out-param receiving the probe ticket when `tryAcquire()` admits the half-open probe. */
export interface ProbeTicketHolder {
	ticket?: HalfOpenProbeTicket;
}

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
	/** Generation of the latest half-open probe; incremented on every probe admission. */
	#probeGeneration = 0;
	readonly #threshold: number;
	readonly #openMs: number;
	readonly #now: () => number;
	readonly #role: RedisRole;

	constructor(options: RedisCircuitBreakerOptions = DEFAULT_OPTIONS) {
		this.#threshold = options.threshold ?? DEFAULT_OPTIONS.threshold;
		this.#openMs = options.openMs ?? DEFAULT_OPTIONS.openMs;
		this.#now = options.now ?? Date.now;
		this.#role = options.role ?? "control";
	}

	/**
	 * PURE predicate: `true` when Redis is currently considered unreachable.
	 *
	 * Never mutates — in particular it never claims the half-open probe, so it is
	 * safe for a caller that may decide not to touch Redis after asking (#167 M7:
	 * a claimed-but-never-settled probe wedges the breaker for the process
	 * lifetime, because the half_open branch never re-checks the clock). Callers
	 * that are about to issue a Redis command must use `tryAcquire()` instead.
	 */
	isOpen(): boolean {
		if (this.#state === "closed") return false;
		if (this.#state === "half_open") return this.#halfOpenInFlight;
		return this.#now() - this.#openedAt < this.#openMs;
	}

	/**
	 * Claim the right to issue one Redis command. Returns `false` when the caller
	 * must fast-fail.
	 *
	 * When the open window has elapsed this transitions to half-open and hands the
	 * single probe to this caller, so a recovering Redis can close the breaker.
	 * Pass a holder to receive the probe's generation ticket, and present that
	 * ticket when settling — only the current ticket settles while half-open.
	 * A caller that gets `true` MUST settle it with `recordSuccess()` or
	 * `recordFailure()` — otherwise the probe is never returned.
	 */
	tryAcquire(ticketOut?: ProbeTicketHolder): boolean {
		if (this.#state === "closed") return true;
		if (this.#state === "half_open") {
			// Only one probe at a time; everyone else keeps fast-failing.
			if (this.#halfOpenInFlight) return false;
			this.#halfOpenInFlight = true;
			this.#mintProbeTicket(ticketOut);
			return true;
		}
		// open: stay open until the cool-down elapses, then allow one probe.
		if (this.#now() - this.#openedAt >= this.#openMs) {
			this.#state = "half_open";
			this.#halfOpenInFlight = true;
			this.#mintProbeTicket(ticketOut);
			return true;
		}
		return false;
	}

	/** Throw `CircuitOpenError` when the breaker is open (and not letting a probe through). */
	assertClosed(): void {
		if (!this.tryAcquire()) throw new CircuitOpenError();
	}

	/**
	 * A successful PING / eval / set: close the breaker and clear the failure run.
	 *
	 * Ignored while OPEN. A success arriving then belongs to a command admitted
	 * before the breaker opened — a straggler that proves nothing about the
	 * present — and closing on it releases the whole herd onto a Redis nothing
	 * has re-tested. While HALF_OPEN only the current probe ticket closes;
	 * ticketless (or superseded) settles are stragglers and are ignored.
	 */
	recordSuccess(probe?: HalfOpenProbeTicket): void {
		if (this.#state === "open") return;
		if (this.#state === "half_open" && probe?.generation !== this.#probeGeneration) return;
		const wasHalfOpen = this.#state === "half_open";
		this.#state = "closed";
		this.#consecutiveFailures = 0;
		this.#halfOpenInFlight = false;
		// Only a real transition is an event; the steady-state success path runs
		// on every acquire and must not log.
		if (wasHalfOpen) {
			console.log(
				JSON.stringify({
					event: "redis_circuit_closed",
					role: this.#role,
					threshold: this.#threshold,
					openMs: this.#openMs,
					openDurationMs: this.#now() - this.#openedAt,
				}),
			);
		}
	}

	/**
	 * A thrown (connection-class) error: count it; open at threshold, or re-open
	 * a failed half-open probe. While HALF_OPEN only the current probe ticket
	 * re-opens; a ticketless (or superseded) failure is a straggler admitted
	 * before the breaker opened and must neither re-open nor restart the
	 * cool-down — it carries no news about the present.
	 */
	recordFailure(probe?: HalfOpenProbeTicket): void {
		if (this.#state === "half_open") {
			if (probe?.generation !== this.#probeGeneration) return;
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

	/** Mint the current half-open probe's generation ticket into the holder, if given. */
	#mintProbeTicket(ticketOut?: ProbeTicketHolder): void {
		this.#probeGeneration += 1;
		if (ticketOut !== undefined) ticketOut.ticket = { generation: this.#probeGeneration };
	}

	#open(): void {
		const reopened = this.#state === "open";
		this.#state = "open";
		// Restart the cool-down only on a fresh declaration (closed → open) or a
		// failed half-open probe. A failure arriving while already open is a
		// straggler admitted before the breaker opened; restarting the clock on
		// each one lets a burst of them (up to the blob-cache backfill cap, all
		// expiring on the same `commandTimeout`) push the recovery probe out of
		// reach for as long as they keep landing (#167).
		if (!reopened) this.#openedAt = this.#now();
		this.#halfOpenInFlight = false;
		this.#consecutiveFailures = this.#threshold;
		if (!reopened) {
			console.error(
				JSON.stringify({
					event: "redis_circuit_open",
					role: this.#role,
					threshold: this.#threshold,
					openMs: this.#openMs,
				}),
			);
		}
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

const singletons: Map<RedisRole, RedisCircuitBreaker> = new Map();

/**
 * Breaker for `role`, shared by every caller on that role's connection.
 * Defaults to `control` so existing lock-path callers are unchanged.
 */
export function getRedisCircuitBreaker(role: RedisRole = "control"): RedisCircuitBreaker {
	const existing = singletons.get(role);
	if (existing !== undefined) return existing;
	const created = new RedisCircuitBreaker({ ...DEFAULT_OPTIONS, role });
	singletons.set(role, created);
	return created;
}

/** Test hook: drop the singletons so each test starts from a clean breaker. */
export function resetRedisCircuitBreakerForTest(): void {
	singletons.clear();
}

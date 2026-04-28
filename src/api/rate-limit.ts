/**
 * In-memory per-route rate limiter (issue #23).
 *
 * Mounted on auth routes so brute-forcing X-Admin-Secret / X-Auth-Secret is
 * bounded. The store is in-process per replica — multi-replica leakage is
 * acknowledged; a follow-up will swap in a Redis-backed store via the existing
 * `getRedisClient()`.
 *
 * The store and clock are injectable so tests can drive deterministic windows
 * without sleeping.
 */

import type { Context, MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { logAudit } from "./lib/audit.js";

export interface RateLimitDecision {
	allowed: boolean;
	/** Unix-ms timestamp when the current window expires. */
	resetAt: number;
	/** Requests still allowed in the current window after this hit. */
	remaining: number;
}

export interface RateLimitStore {
	hit(key: string, windowMs: number, max: number, now: number): RateLimitDecision;
	reset(): void;
}

interface Entry {
	count: number;
	resetAt: number;
}

/**
 * Default cap on live keys. With attacker-controlled key cardinality (e.g.
 * rotating IPs against unauthenticated bootstrap), the unbounded variant could
 * grow within a single window. Each entry is ~80 bytes; 10k = ~0.8 MB worst-case.
 */
const DEFAULT_MAX_ENTRIES = 10_000;

export interface InMemoryRateLimitStoreOptions {
	maxEntries?: number;
}

export class InMemoryRateLimitStore implements RateLimitStore {
	private readonly entries: Map<string, Entry> = new Map();
	private readonly maxEntries: number;
	private hits = 0;

	constructor(opts: InMemoryRateLimitStoreOptions = {}) {
		this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
	}

	hit(key: string, windowMs: number, max: number, now: number): RateLimitDecision {
		this.hits++;
		// Lazy GC: every 1024 hits, drop expired entries first (cheap path).
		if (this.hits % 1024 === 0) {
			for (const [k, v] of this.entries) {
				if (v.resetAt <= now) this.entries.delete(k);
			}
		}

		const existing = this.entries.get(key);
		if (existing === undefined || existing.resetAt <= now) {
			// New (or rolled-over) bucket. Cap live keys: when we'd exceed the
			// max, first purge expired entries so we don't evict a still-live
			// tracker while dead space is sitting in the map (the every-1024-hits
			// lazy GC may not have run yet under bursty traffic). If the store
			// is still full after that, fall back to FIFO eviction.
			if (existing === undefined && this.entries.size >= this.maxEntries) {
				for (const [k, v] of this.entries) {
					if (v.resetAt <= now) {
						this.entries.delete(k);
						if (this.entries.size < this.maxEntries) break;
					}
				}
				if (this.entries.size >= this.maxEntries) {
					const oldest = this.entries.keys().next().value;
					if (oldest !== undefined) this.entries.delete(oldest);
				}
			}
			const resetAt = now + windowMs;
			// Re-insert (delete + set) so the entry moves to the tail of the
			// insertion order, keeping the FIFO eviction behaviour stable when a
			// previously-tracked key rolls over.
			if (existing !== undefined) this.entries.delete(key);
			this.entries.set(key, { count: 1, resetAt });
			return { allowed: 1 <= max, resetAt, remaining: Math.max(0, max - 1) };
		}

		existing.count += 1;
		return {
			allowed: existing.count <= max,
			resetAt: existing.resetAt,
			remaining: Math.max(0, max - existing.count),
		};
	}

	reset(): void {
		this.entries.clear();
		this.hits = 0;
	}

	/** Visible for tests. */
	size(): number {
		return this.entries.size;
	}
}

/** Process-wide default store. Tests should call `defaultRateLimitStore.reset()` in `beforeEach`. */
export const defaultRateLimitStore = new InMemoryRateLimitStore();

export interface RateLimitOptions {
	windowMs: number;
	max: number;
	scope: "admin" | "bootstrap";
	/** One or more keys to evaluate. Tripping any key returns 429. */
	keys: (c: Context) => string[];
	store?: RateLimitStore;
	now?: () => number;
}

/**
 * Extract the client IP for rate-limit keying.
 *
 * Forwarding headers (`X-Forwarded-For`, `X-Real-IP`) are spoofable by any
 * caller that can reach the application, so we only honour them when the
 * operator opts in via `TRUST_PROXY_HEADERS=true`. That mode is appropriate
 * when the application sits behind an ingress that strips inbound forwarding
 * headers and re-emits its own. Otherwise we fall back to the connecting
 * socket's remote address (set by `@hono/node-server` on `c.env.incoming`).
 *
 * Failure mode: when neither source is available (e.g. the in-process
 * `app.request()` test harness), we return "unknown" — a single shared bucket
 * is the *safe* default for rate-limit keying.
 */
export function clientIp(c: Context): string {
	if (process.env.TRUST_PROXY_HEADERS === "true") {
		const fwd = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
		if (fwd) return fwd;
		const real = c.req.header("x-real-ip");
		if (real) return real;
	}
	const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string | null } } } | undefined)?.incoming;
	const remote = incoming?.socket?.remoteAddress;
	if (remote) return remote;
	return "unknown";
}

export function rateLimit(opts: RateLimitOptions): MiddlewareHandler {
	const store = opts.store ?? defaultRateLimitStore;
	const now = opts.now ?? (() => Date.now());

	return async (c, next) => {
		const t = now();
		const keys = opts.keys(c);

		let trippedKey: string | undefined;
		let trippedResetAt = 0;

		for (const key of keys) {
			const decision = store.hit(key, opts.windowMs, opts.max, t);
			// Track the *latest* resetAt across all denied keys so Retry-After
			// reflects the longest remaining wait — not the first bucket tripped.
			// Otherwise a client could wake up while a slower-resetting bucket
			// is still in violation and immediately receive another 429.
			if (!decision.allowed && decision.resetAt >= trippedResetAt) {
				trippedKey = key;
				trippedResetAt = decision.resetAt;
			}
		}

		if (trippedKey !== undefined) {
			const ip = clientIp(c);
			// `c.get("owner")` is set by Bearer middleware on /admin; on
			// /bootstrap it is undefined (the path is exempt). Read defensively.
			const sub = (c.get("owner") as string | undefined) ?? undefined;
			logAudit("auth_rate_limited", {
				ts: new Date(t).toISOString(),
				scope: opts.scope,
				keys,
				trippedKey,
				ip,
				sub,
				path: c.req.path,
			});
			c.header("Retry-After", String(Math.ceil((trippedResetAt - t) / 1000)));
			return c.json({ error: "rate_limited", code: "RATE_LIMITED" }, 429 as ContentfulStatusCode);
		}

		await next();
	};
}

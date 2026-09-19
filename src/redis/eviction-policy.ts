/**
 * Boot-time check on the eviction policy of the Redis backing the blob cache
 * (#188).
 *
 * Blob cache entries carry a 24 h TTL (`REDIS_BLOB_CACHE_TTL_MS`). Under the
 * Redis default `maxmemory-policy noeviction`, an instance that reaches
 * `maxmemory` starts refusing every write with `OOM command not allowed` and
 * does not recover on its own: waiting out a 24 h TTL is not an operational
 * strategy, so a human has to flush keys or raise the limit. The harness
 * measured that shape as 97.6% 5xx with no recovery, against a `CLIENT PAUSE`
 * that recovered the moment the pause lifted. An `allkeys-lru` / `allkeys-lfu` policy turns
 * the same event into eviction of cold blobs, which cost a Postgres read and
 * nothing else — see `SAFE_POLICIES` for why those two and not the rest.
 *
 * This is a WARNING and never a startup failure. Managed Redis providers
 * routinely refuse `CONFIG GET` (ElastiCache renames the command, Redis Cloud
 * answers `NOPERM`), so a deployment that cannot answer the question must still
 * boot.
 */

import type { Redis } from "ioredis";

/** The subset of ioredis this check needs, so tests do not build a whole client. */
export interface ConfigReader {
	config(op: "GET", parameter: string): Promise<unknown>;
}

export type EvictionPolicyVerdict = "safe" | "unsafe" | "unreadable" | "denied";

export interface EvictionPolicyResult {
	readonly verdict: EvictionPolicyVerdict;
	readonly policy?: string;
	readonly error?: string;
}

/**
 * True when the error says the provider will not answer `CONFIG GET` at all, as
 * opposed to the connection being broken. Managed Redis hides or restricts the
 * command in several different ways, and every one of them is a non-event: the
 * operator cannot fix it, so the log line must not read like a misconfiguration.
 */
function isConfigDenied(message: string): boolean {
	const lower = message.toLowerCase();
	// `OOM command not allowed when used memory > 'maxmemory'` contains "not
	// allowed" but is the very failure this check exists to prevent, so it must
	// not be filed as a benign permission answer.
	if (lower.startsWith("oom")) return false;
	return lower.startsWith("noperm") || lower.includes("unknown command") || lower.includes("not allowed");
}

/** ioredis answers `CONFIG GET` with a flat `[name, value]` array. */
function policyFromReply(reply: unknown): string | undefined {
	if (Array.isArray(reply)) {
		const value = reply[1];
		return typeof value === "string" ? value : undefined;
	}
	// RESP3 clients hand back a map instead of a flat array.
	if (reply !== null && typeof reply === "object") {
		const value = (reply as Record<string, unknown>)["maxmemory-policy"];
		return typeof value === "string" ? value : undefined;
	}
	return undefined;
}

/**
 * Reads `maxmemory-policy` and classifies it. Never throws and never rejects:
 * the caller boots either way.
 */
export async function readEvictionPolicy(client: ConfigReader): Promise<EvictionPolicyResult> {
	let reply: unknown;
	try {
		reply = await client.config("GET", "maxmemory-policy");
	} catch (err) {
		const message = (err as Error)?.message ?? String(err);
		return { verdict: isConfigDenied(message) ? "denied" : "unreadable", error: message };
	}
	const policy = policyFromReply(reply);
	if (policy === undefined) return { verdict: "unreadable" };
	return { verdict: SAFE_POLICIES.has(policy) ? "safe" : "unsafe", policy };
}

/**
 * The only two policies that both always have something to evict and evict the
 * right thing.
 *
 * By default the data role shares an instance with the control role
 * (`REDIS_DATA_URL` falls back to `REDIS_URL`), so whatever policy is set
 * governs the exec-lock leases, the version counters and the destroy
 * tombstones as well as the blob cache. Under LRU or LFU those are effectively
 * immune: a lease renewed every `REDIS_EXEC_LOCK_RENEW_MS` (20 s) and a version
 * counter touched on every write are the most recently and most frequently used
 * keys in the instance, so a cold blob is always the better candidate.
 *
 * `allkeys-random` is NOT accepted: it samples uniformly, so a live lease is
 * exactly as likely to be reaped as the cold blob next to it. `volatile-*` is
 * not accepted either, but for a different reason than recency — it evicts ONLY
 * keys carrying a TTL, so an instance that fills with keys that do not carry one
 * (the RW-lock reader ZSETs, anything a future change adds) has no eviction
 * candidate left and degrades to exactly the `noeviction` failure this check
 * exists to prevent: writes refused, no recovery without a human. `allkeys-*`
 * always has a candidate.
 */
const SAFE_POLICIES: ReadonlySet<string> = new Set(["allkeys-lru", "allkeys-lfu"]);

/** Why this specific policy is refused — an operator log line has to be actionable. */
function unsafeReason(policy: string | undefined): string {
	if (policy === "allkeys-random") {
		return "allkeys-random evicts uniformly at random, so a live exec-lock lease or version counter is as likely to be reaped as a cold blob; LRU/LFU never pick a key renewed every 20s.";
	}
	if (policy?.startsWith("volatile-") === true) {
		return "volatile-* evicts only keys that carry a TTL, so once the instance fills with keys that do not, it has no candidate left and behaves exactly like noeviction: writes refused, no recovery without a human.";
	}
	return "under noeviction a Redis at maxmemory refuses every write and does not recover, because blob entries carry a 24h TTL.";
}

/**
 * Runs {@link readEvictionPolicy} and logs the verdict. Returns the result so
 * tests and callers can assert on it without parsing stderr.
 */
export async function checkEvictionPolicy(
	client: ConfigReader,
	sink?: (line: string) => void,
): Promise<EvictionPolicyResult> {
	const result = await readEvictionPolicy(client);
	// An unsafe policy is an operator action item, so it goes to stderr at
	// critical severity; the rest are informational.
	const log = sink ?? (result.verdict === "unsafe" ? console.error : console.warn);
	switch (result.verdict) {
		case "safe":
			log(JSON.stringify({ event: "redis_eviction_policy", policy: result.policy }));
			break;
		case "unsafe":
			log(
				JSON.stringify({
					event: "redis_eviction_policy_unsafe",
					severity: "critical",
					policy: result.policy,
					message: `Redis maxmemory-policy is "${result.policy}". The blob cache needs allkeys-lru (or allkeys-lfu): ${unsafeReason(result.policy)} Run CONFIG SET maxmemory-policy allkeys-lru (and persist it in redis.conf).`,
				}),
			);
			break;
		case "denied":
			log(
				JSON.stringify({
					event: "redis_eviction_policy_unknown",
					reason: "config_get_denied",
					error: result.error,
					message:
						"Could not read maxmemory-policy: this Redis does not allow CONFIG GET. " +
						"Confirm with your provider that the instance evicts (allkeys-lru or equivalent).",
				}),
			);
			break;
		case "unreadable":
			log(
				JSON.stringify({
					event: "redis_eviction_policy_unknown",
					reason: "config_get_failed",
					error: result.error,
				}),
			);
			break;
	}
	return result;
}

export interface EvictionPolicyCheckOptions {
	/**
	 * Whether this client actually carries data-plane state (blob cache or path
	 * snapshot). Defaults to `true`; pass `false` to skip the check entirely.
	 *
	 * #188 M8: `REDIS_DATA_URL` falls back to `REDIS_URL`, so with the blob cache
	 * disabled and no path snapshot the "data" client IS the control instance. A
	 * control-only Redis holds leases, version counters and destroy tombstones and
	 * no cache at all — nothing there is worth evicting, and the remediation this
	 * check pages for (switch to `allkeys-*`) would make all of it evictable. So a
	 * correctly-configured control-only deployment must not be paged at all.
	 */
	readonly carriesDataPlane?: boolean;
}

/**
 * Fire-and-forget boot hook. Deliberately not awaited by the caller: a Redis
 * that answers slowly must not hold up `listen`, and a rejection here must not
 * become an unhandled rejection.
 */
export function startEvictionPolicyCheck(client: Redis | undefined, opts: EvictionPolicyCheckOptions = {}): void {
	if (client === undefined) return;
	if (opts.carriesDataPlane === false) return;
	void checkEvictionPolicy(client).catch(() => {
		// checkEvictionPolicy already swallows; this is belt-and-braces so a
		// future change there can never crash boot.
	});
}

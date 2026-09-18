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
 * that recovered the moment the pause lifted. An `allkeys-*` policy turns the
 * same event into eviction of cold blobs, which cost a Postgres read and
 * nothing else.
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
	// `allkeys-lru`, `allkeys-lfu` and `allkeys-random` all evict blob entries
	// under pressure, which is the property that matters. `volatile-*` is not
	// accepted: it evicts only keys carrying a TTL, and by default the data role
	// shares an instance with the control role (`REDIS_DATA_URL` falls back to
	// `REDIS_URL`), whose version counters and lock leases carry a TTL too — so
	// it can reap a live lock lease to make room for a cached blob.
	return { verdict: policy.startsWith("allkeys-") ? "safe" : "unsafe", policy };
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
					message: `Redis maxmemory-policy is "${result.policy}". The blob cache needs allkeys-lru: under noeviction a Redis at maxmemory refuses every write and does not recover, because blob entries carry a 24h TTL. Run CONFIG SET maxmemory-policy allkeys-lru (and persist it in redis.conf).`,
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

/**
 * Fire-and-forget boot hook. Deliberately not awaited by the caller: a Redis
 * that answers slowly must not hold up `listen`, and a rejection here must not
 * become an unhandled rejection.
 */
export function startEvictionPolicyCheck(client: Redis | undefined): void {
	if (client === undefined) return;
	void checkEvictionPolicy(client).catch(() => {
		// checkEvictionPolicy already swallows; this is belt-and-braces so a
		// future change there can never crash boot.
	});
}

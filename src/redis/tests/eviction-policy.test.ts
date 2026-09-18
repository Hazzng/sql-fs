/**
 * US-188 unit tests: the boot-time `maxmemory-policy` check.
 *
 * The check exists because `noeviction` turns a full Redis into a permanent
 * outage rather than a transient one (blob entries carry a 24 h TTL, so waiting
 * it out is not a strategy). It must warn loudly, never fail startup, and tell a
 * provider that forbids `CONFIG GET` apart from a provider that answered badly.
 */

import { describe, expect, it, vi } from "vitest";
import {
	type ConfigReader,
	checkEvictionPolicy,
	readEvictionPolicy,
	startEvictionPolicyCheck,
} from "../eviction-policy.js";

function reader(reply: unknown): ConfigReader {
	return { config: vi.fn(async () => reply) };
}

function failing(message: string): ConfigReader {
	return {
		config: vi.fn(async () => {
			throw new Error(message);
		}),
	};
}

/** Captures the lines the check emits so assertions read the JSON, not stderr. */
function sink(): { lines: string[]; log: (line: string) => void } {
	const lines: string[] = [];
	return { lines, log: (line) => lines.push(line) };
}

describe("readEvictionPolicy (US-188)", () => {
	it("accepts every allkeys policy", async () => {
		for (const policy of ["allkeys-lru", "allkeys-lfu", "allkeys-random"]) {
			expect(await readEvictionPolicy(reader(["maxmemory-policy", policy]))).toEqual({ verdict: "safe", policy });
		}
	});

	it("rejects noeviction and every volatile policy", async () => {
		// volatile-* is rejected on purpose: it evicts only keys carrying a TTL,
		// and the control-plane lock leases sharing the default single instance
		// carry one, so it can reap a live lease to cache a blob.
		for (const policy of ["noeviction", "volatile-lru", "volatile-lfu", "volatile-random", "volatile-ttl"]) {
			expect(await readEvictionPolicy(reader(["maxmemory-policy", policy]))).toEqual({ verdict: "unsafe", policy });
		}
	});

	it("reads a RESP3 map reply as well as a flat array", async () => {
		expect(await readEvictionPolicy(reader({ "maxmemory-policy": "allkeys-lru" }))).toEqual({
			verdict: "safe",
			policy: "allkeys-lru",
		});
	});

	it("reports a reply it cannot parse as unreadable rather than guessing", async () => {
		for (const reply of [[], ["maxmemory-policy"], null, "allkeys-lru", 7]) {
			expect(await readEvictionPolicy(reader(reply))).toEqual({ verdict: "unreadable" });
		}
	});

	it("classifies the ways a managed provider refuses CONFIG GET as denied", async () => {
		for (const message of [
			"NOPERM this user has no permissions to run the 'config|get' command",
			"ERR unknown command 'config', with args beginning with: 'GET'",
			"ERR CONFIG GET is not allowed on this instance",
		]) {
			expect(await readEvictionPolicy(failing(message))).toEqual({ verdict: "denied", error: message });
		}
	});

	it("does not file a transport failure or an OOM refusal as denied", async () => {
		// Negative guard: "denied" is the quiet verdict, so anything that is
		// actually wrong with the instance must not land there. `OOM command not
		// allowed…` contains "not allowed" and is the exact failure this check
		// exists to prevent.
		for (const message of [
			"OOM command not allowed when used memory > 'maxmemory'.",
			"Command timed out",
			"ECONNRESET",
			"Connection is closed.",
		]) {
			expect(await readEvictionPolicy(failing(message))).toEqual({ verdict: "unreadable", error: message });
		}
	});
});

describe("checkEvictionPolicy logging (US-188)", () => {
	it("logs a critical warning naming the policy and the remedy when it is unsafe", async () => {
		const out = sink();
		await checkEvictionPolicy(reader(["maxmemory-policy", "noeviction"]), out.log);

		expect(out.lines).toHaveLength(1);
		const line = JSON.parse(out.lines[0] as string) as Record<string, string>;
		expect(line.event).toBe("redis_eviction_policy_unsafe");
		expect(line.severity).toBe("critical");
		expect(line.policy).toBe("noeviction");
		expect(line.message).toContain("allkeys-lru");
	});

	it("does not emit the unsafe event when the policy is safe", async () => {
		// Negative guard: a warning on every healthy boot would train operators to
		// ignore the one that matters.
		const out = sink();
		await checkEvictionPolicy(reader(["maxmemory-policy", "allkeys-lru"]), out.log);

		expect(out.lines).toHaveLength(1);
		expect(JSON.parse(out.lines[0] as string)).toEqual({ event: "redis_eviction_policy", policy: "allkeys-lru" });
	});

	it("distinguishes a refused CONFIG GET from a failed one in the log", async () => {
		const denied = sink();
		await checkEvictionPolicy(failing("NOPERM this user has no permissions"), denied.log);
		const failed = sink();
		await checkEvictionPolicy(failing("Command timed out"), failed.log);

		expect(JSON.parse(denied.lines[0] as string).reason).toBe("config_get_denied");
		expect(JSON.parse(failed.lines[0] as string).reason).toBe("config_get_failed");
	});

	it("never rejects, whatever CONFIG GET does", async () => {
		// The whole point is that startup survives this check.
		const out = sink();
		await expect(checkEvictionPolicy(failing("boom"), out.log)).resolves.toMatchObject({ verdict: "unreadable" });
		const thrower: ConfigReader = {
			config: () => {
				throw new Error("synchronous throw");
			},
		};
		await expect(checkEvictionPolicy(thrower, out.log)).resolves.toMatchObject({ verdict: "unreadable" });
	});
});

describe("startEvictionPolicyCheck (US-188)", () => {
	it("is a no-op when no Redis is configured", () => {
		expect(() => startEvictionPolicyCheck(undefined)).not.toThrow();
	});

	it("returns synchronously without awaiting the Redis round trip", async () => {
		let resolveConfig: (v: unknown) => void = () => {};
		const pending = new Promise((r) => {
			resolveConfig = r;
		});
		const client = { config: vi.fn(() => pending) } as unknown as Parameters<typeof startEvictionPolicyCheck>[0];
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		startEvictionPolicyCheck(client);
		// Boot continues while CONFIG GET is still in flight.
		expect(warn).not.toHaveBeenCalled();

		resolveConfig(["maxmemory-policy", "allkeys-lru"]);
		await pending;
		await new Promise((r) => setImmediate(r));
		expect(warn).toHaveBeenCalledTimes(1);
		warn.mockRestore();
	});
});

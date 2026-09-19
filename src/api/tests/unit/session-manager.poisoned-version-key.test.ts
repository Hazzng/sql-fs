/**
 * US-187 unit tests: recovery from a structurally poisoned version key.
 *
 * #175 made a failed version publish honest (`503 ECOHERENCE`, `retryable:
 * false`). It did not make it recoverable: a version key holding a non-integer
 * or the wrong type fails every future INCR identically, so the deferral never
 * drains and the sandbox is write-wedged forever. These tests pin the split
 * between a structurally invalid key (repair it) and a transport failure (keep
 * deferring, exactly as #175 does).
 */

import { describe, expect, it, vi } from "vitest";
import { SessionManager, isPoisonedVersionKeyError } from "../../session-manager.js";
import { FakeRedis, StubCoherentFs, asRedis, makeFsFactory } from "./helpers/session-manager-fakes.js";

const VKEY = "vfs:default:ver:sbx";

/** Writes `value` straight into the fake's store, bypassing INCR's integer check. */
function poison(redis: FakeRedis, value: string): void {
	redis.store.set(VKEY, { value, expiresAt: Date.now() + 60_000 });
}

describe("isPoisonedVersionKeyError (US-187)", () => {
	it("classifies the two Redis replies that make a key permanently un-INCR-able", () => {
		expect(isPoisonedVersionKeyError(new Error("ERR value is not an integer or out of range"))).toBe(true);
		expect(
			isPoisonedVersionKeyError(new Error("WRONGTYPE Operation against a key holding the wrong kind of value")),
		).toBe(true);
	});

	it("does not classify transport, breaker or replica-role failures as poison", () => {
		// Negative guard: every entry here must stay on the #175 deferral path. If
		// the matcher widens to (say) any ReplyError or any message containing
		// "value", a real Redis outage starts silently resetting live counters.
		for (const message of [
			"ECONNRESET",
			"Command timed out",
			"Stream isn't writeable and enableOfflineQueue options is false",
			"READONLY You can't write against a read only replica.",
			"ERR max number of clients reached",
			"OOM command not allowed when used memory > 'maxmemory'.",
			"Connection is closed.",
		]) {
			expect(isPoisonedVersionKeyError(new Error(message))).toBe(false);
		}
	});

	it("does not classify a non-Error throw", () => {
		expect(isPoisonedVersionKeyError("WRONGTYPE")).toBe(false);
		expect(isPoisonedVersionKeyError(null)).toBe(false);
		expect(isPoisonedVersionKeyError(undefined)).toBe(false);
		expect(isPoisonedVersionKeyError({ message: 42 })).toBe(false);
	});
});

describe("SessionManager poisoned version key recovery (US-187)", () => {
	it("recovers the write instead of returning ECOHERENCE when the key holds a non-integer", async () => {
		const redis = new FakeRedis();
		const stub = new StubCoherentFs();
		const sm = new SessionManager({ createFs: makeFsFactory(stub), redis: asRedis(redis) });

		await sm.withSession("default", "sbx", async () => {});
		poison(redis, "not-an-integer");

		await expect(
			sm.withSession("default", "sbx", async () => {
				stub.dirty = true;
			}),
		).resolves.toBeUndefined();

		expect(redis.store.get(VKEY)?.value).toMatch(/^\d+$/);
		expect(stub.dirty).toBe(false);
		expect(sm.getSession("default", "sbx")?.publishPending).toBe(false);
		expect(sm.getSession("default", "sbx")?.lastSeenVersion).toBe(Number(redis.store.get(VKEY)?.value));
	});

	it("recovers a WRONGTYPE key, which SET replaces in place", async () => {
		const redis = new FakeRedis();
		const stub = new StubCoherentFs();
		const sm = new SessionManager({ createFs: makeFsFactory(stub), redis: asRedis(redis) });

		await sm.withSession("default", "sbx", async () => {});
		// A hash/list at this key makes INCR reply WRONGTYPE; the atomic script heals it.
		redis.store.delete(VKEY);
		redis.wrongTypeKeys.add(VKEY);

		await expect(
			sm.withSession("default", "sbx", async () => {
				stub.dirty = true;
			}),
		).resolves.toBeUndefined();

		expect(redis.store.get(VKEY)?.value).toMatch(/^\d+$/);
	});

	it("keeps accepting writes after the repair", async () => {
		const redis = new FakeRedis();
		const stub = new StubCoherentFs();
		const sm = new SessionManager({ createFs: makeFsFactory(stub), redis: asRedis(redis) });

		await sm.withSession("default", "sbx", async () => {});
		poison(redis, "not-an-integer");

		await sm.withSession("default", "sbx", async () => {
			stub.dirty = true;
		});
		const afterRepair = Number(redis.store.get(VKEY)?.value);

		for (let i = 1; i <= 3; i++) {
			await expect(
				sm.withSession("default", "sbx", async () => {
					stub.dirty = true;
				}),
			).resolves.toBeUndefined();
			expect(Number(redis.store.get(VKEY)?.value)).toBe(afterRepair + i);
		}
	});

	it("resets to a counter no sibling replica can already be holding", async () => {
		// Restarting at 1 would be invisible to a replica whose lastSeenVersion is
		// already 1 — it would never reload and would serve stale reads with no
		// further write to shake it loose. The reset must jump clear of every value
		// a real counter can reach.
		const redis = new FakeRedis();
		const stub = new StubCoherentFs();
		const sm = new SessionManager({ createFs: makeFsFactory(stub), redis: asRedis(redis) });

		const before = Date.now();
		await sm.withSession("default", "sbx", async () => {
			stub.dirty = true;
		});
		expect(redis.store.get(VKEY)?.value).toBe("1");

		poison(redis, "not-an-integer");
		await sm.withSession("default", "sbx", async () => {
			stub.dirty = true;
		});

		const reset = Number(redis.store.get(VKEY)?.value);
		expect(reset).toBeGreaterThanOrEqual(before);
		expect(reset).toBeLessThanOrEqual(Date.now());
	});

	it("still defers, and still throws ECOHERENCE, on a transport failure", async () => {
		// Negative guard: #186's deferral is the correct answer for a Redis that is
		// merely unreachable, and resetting a live counter there would be data loss.
		const redis = new FakeRedis();
		const stub = new StubCoherentFs();
		const sm = new SessionManager({ createFs: makeFsFactory(stub), redis: asRedis(redis) });

		await sm.withSession("default", "sbx", async () => {
			stub.dirty = true;
		});
		const setSpy = vi.spyOn(redis, "set");
		const evalSpy = vi.spyOn(redis, "eval");
		vi.spyOn(redis, "incr").mockRejectedValueOnce(new Error("Command timed out"));

		await expect(
			sm.withSession("default", "sbx", async () => {
				stub.dirty = true;
			}),
		).rejects.toMatchObject({ code: "ECOHERENCE" });

		expect(setSpy).not.toHaveBeenCalled();
		expect(evalSpy.mock.calls.some(([script]) => (script as string).includes("US-187 poison reset"))).toBe(false);
		expect(redis.store.get(VKEY)?.value).toBe("1");
		expect(sm.getSession("default", "sbx")?.publishPending).toBe(true);
		expect(sm.getSession("default", "sbx")?.lastSeenVersion).toBe(-1);
	});

	it("never overwrites the F7 destroy tombstone", async () => {
		// Negative guard: the tombstone is a non-numeric string too, so it fails
		// INCR identically. Repairing it would resurrect a destroyed sandbox for
		// every sibling replica still holding a warm session.
		const redis = new FakeRedis();
		const stub = new StubCoherentFs();
		const sm = new SessionManager({ createFs: makeFsFactory(stub), redis: asRedis(redis) });

		await sm.withSession("default", "sbx", async () => {});

		// The reachable ordering: the turn's freshness probe passed, then a destroy
		// on another replica stamped the tombstone before this turn published.
		await expect(
			sm.withSession("default", "sbx", async () => {
				stub.dirty = true;
				poison(redis, "DESTROYED");
			}),
		).rejects.toMatchObject({ code: "ECOHERENCE" });

		expect(redis.store.get(VKEY)?.value).toBe("DESTROYED");
	});

	it("falls back to the deferral when the repair write itself fails", async () => {
		const redis = new FakeRedis();
		const stub = new StubCoherentFs();
		const sm = new SessionManager({ createFs: makeFsFactory(stub), redis: asRedis(redis) });

		await sm.withSession("default", "sbx", async () => {});
		poison(redis, "not-an-integer");
		const realEval = redis.eval.bind(redis);
		vi.spyOn(redis, "eval").mockImplementation(async (script: string, numKeys: number, ...args: string[]) => {
			if (script.includes("US-187 poison reset")) throw new Error("Command timed out");
			return realEval(script, numKeys, ...args);
		});

		await expect(
			sm.withSession("default", "sbx", async () => {
				stub.dirty = true;
			}),
		).rejects.toMatchObject({ code: "ECOHERENCE" });

		expect(redis.store.get(VKEY)?.value).toBe("not-an-integer");
		expect(sm.getSession("default", "sbx")?.publishPending).toBe(true);
	});

	it("reloads and bumps instead of overwriting when a concurrent repair already won", async () => {
		// Codex P1 (#195): the loser must not SET over the winner's version and
		// record it without the winner's write. It reloads, then INCRs past it.
		const redis = new FakeRedis();
		const stub = new StubCoherentFs();
		const sm = new SessionManager({ createFs: makeFsFactory(stub), redis: asRedis(redis) });

		await sm.withSession("default", "sbx", async () => {});
		poison(redis, "not-an-integer");
		vi.spyOn(redis, "incr").mockImplementationOnce(async () => {
			redis.store.set(VKEY, { value: "42", expiresAt: Date.now() + 60_000 });
			throw new Error("ERR value is not an integer or out of range");
		});

		await expect(
			sm.withSession("default", "sbx", async () => {
				stub.dirty = true;
			}),
		).resolves.toBeUndefined();

		expect(redis.store.get(VKEY)?.value).toBe("43");
		expect(stub.reloadCount).toBeGreaterThanOrEqual(1);
		expect(sm.getSession("default", "sbx")?.lastSeenVersion).toBe(43);
		expect(sm.getSession("default", "sbx")?.publishPending).toBe(false);
	});
});

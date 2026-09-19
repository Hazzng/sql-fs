/**
 * US-175 unit tests: the ECOHERENCE durability contract.
 *
 * ECOHERENCE and the not-applied 503s used to share one code and one message,
 * and the message told clients to retry — which double-applies a committed,
 * non-idempotent write. These tests pin the split:
 *  - a committed write whose INCR failed → ECOHERENCE, "do not blindly retry".
 *  - a rolled-back (poisoned) turn → ECOHERENCE_UNAPPLIED, retry is safe.
 *  - a turn that mutated nothing never inherits either.
 */

import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../session-manager.js";
import { FakeRedis, StubCoherentFs, asRedis, makeFsFactory } from "./helpers/session-manager-fakes.js";

const VKEY = "vfs:default:ver:sbx";

describe("SessionManager ECOHERENCE contract (US-175)", () => {
	it("throws ECOHERENCE whose message states the write is applied and must not be blindly retried", async () => {
		const redis = new FakeRedis();
		const stub = new StubCoherentFs();
		const sm = new SessionManager({ createFs: makeFsFactory(stub), redis: asRedis(redis) });

		await sm.withSession("default", "sbx", async () => {});
		vi.spyOn(redis, "incr").mockRejectedValueOnce(new Error("ECONNRESET"));

		await expect(
			sm.withSession("default", "sbx", async () => {
				stub.dirty = true;
			}),
		).rejects.toMatchObject({
			code: "ECOHERENCE",
			message:
				"ECOHERENCE: write committed but cross-replica version publish failed; the write IS applied — do not blindly retry",
		});
	});

	it("throws ECOHERENCE_UNAPPLIED, not ECOHERENCE, when the cache is poisoned", async () => {
		const redis = new FakeRedis();
		const stub = new StubCoherentFs();
		stub.isPoisoned = true;
		const sm = new SessionManager({ createFs: makeFsFactory(stub), redis: asRedis(redis) });

		await expect(sm.withSession("default", "sbx", async () => {})).rejects.toMatchObject({
			code: "ECOHERENCE_UNAPPLIED",
			message: "ECOHERENCE_UNAPPLIED: cache poisoned by failed reload; nothing was applied, retry is safe",
		});
	});

	it("suppresses the INCR entirely while poisoned", async () => {
		const redis = new FakeRedis();
		const stub = new StubCoherentFs();
		stub.isPoisoned = true;
		const incrSpy = vi.spyOn(redis, "incr");
		const sm = new SessionManager({ createFs: makeFsFactory(stub), redis: asRedis(redis) });

		await expect(sm.withSession("default", "sbx", async () => {})).rejects.toMatchObject({
			code: "ECOHERENCE_UNAPPLIED",
		});

		// The code assertion above is what the fix changed. These two are a
		// regression guard on pre-existing F1 behaviour: renaming the code must not
		// move the poison check to after the INCR.
		expect(incrSpy).not.toHaveBeenCalled();
		expect(redis.store.has(VKEY)).toBe(false);
	});

	it("does not fail a turn that mutated nothing when the pending INCR still fails", async () => {
		const redis = new FakeRedis();
		const stub = new StubCoherentFs();
		const sm = new SessionManager({ createFs: makeFsFactory(stub), redis: asRedis(redis) });

		await sm.withSession("default", "sbx", async () => {});

		// Turn 1 mutates and its INCR fails: ECOHERENCE is correct here.
		const incrSpy = vi.spyOn(redis, "incr").mockRejectedValue(new Error("Command timed out"));
		await expect(
			sm.withSession("default", "sbx", async () => {
				stub.dirty = true;
			}),
		).rejects.toMatchObject({ code: "ECOHERENCE" });

		// Turn 2 mutates nothing. It only piggy-backs turn 1's stranded bump, so
		// it must return its own (correct) result instead of a 503.
		stub.dirty = false;
		await expect(sm.withSession("default", "sbx", async () => "read-result")).resolves.toBe("read-result");

		// The INCR was still attempted — the fix defers the failure, it does not
		// skip the healing attempt.
		expect(incrSpy).toHaveBeenCalledTimes(2);
	});

	it("keeps the stranded bump queued after a non-mutating turn swallows the INCR failure", async () => {
		const redis = new FakeRedis();
		const stub = new StubCoherentFs();
		const sm = new SessionManager({ createFs: makeFsFactory(stub), redis: asRedis(redis) });

		await sm.withSession("default", "sbx", async () => {});
		const incrSpy = vi.spyOn(redis, "incr").mockRejectedValue(new Error("Command timed out"));
		await expect(
			sm.withSession("default", "sbx", async () => {
				stub.dirty = true;
			}),
		).rejects.toMatchObject({ code: "ECOHERENCE" });

		stub.dirty = false;
		await sm.withSession("default", "sbx", async () => {});

		// publishPending survives, lastSeenVersion stays forced-stale, and the
		// bump lands as soon as Redis recovers.
		expect(sm.getSession("default", "sbx")?.publishPending).toBe(true);
		expect(sm.getSession("default", "sbx")?.lastSeenVersion).toBe(-1);

		incrSpy.mockRestore();
		await sm.withSession("default", "sbx", async () => {});
		expect(redis.store.get(VKEY)?.value).toBe("1");
		expect(sm.getSession("default", "sbx")?.publishPending).toBe(false);
	});

	it("still fails a mutating turn while the INCR keeps failing", async () => {
		// Negative guard: the no-mutation carve-out must not swallow the applied
		// case it was carved out of.
		const redis = new FakeRedis();
		const stub = new StubCoherentFs();
		const sm = new SessionManager({ createFs: makeFsFactory(stub), redis: asRedis(redis) });

		await sm.withSession("default", "sbx", async () => {});
		vi.spyOn(redis, "incr").mockRejectedValue(new Error("Command timed out"));

		for (let i = 0; i < 2; i++) {
			await expect(
				sm.withSession("default", "sbx", async () => {
					stub.dirty = true;
				}),
			).rejects.toMatchObject({ code: "ECOHERENCE" });
		}
	});
});

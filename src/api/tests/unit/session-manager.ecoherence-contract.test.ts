import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../session-manager.js";
import { FakeRedis, StubCoherentFs, asRedis, makeFsFactory } from "./helpers/session-manager-fakes.js";

describe("SessionManager recovery contract", () => {
	it("commits once without touching legacy Redis publication", async () => {
		const redis = new FakeRedis();
		const stub = new StubCoherentFs();
		const sm = new SessionManager({ createFs: makeFsFactory(stub), redis: asRedis(redis) });
		const incr = vi.spyOn(redis, "incr").mockRejectedValue(new Error("publication unavailable"));
		let value = "old";
		await sm.withSession("default", "sbx", async () => {
			value += "x";
			stub.dirty = true;
		});
		expect(value).toBe("oldx");
		expect(incr).not.toHaveBeenCalled();
		await sm.shutdown();
	});

	it("preserves the unapplied recovery error after a poisoned callback", async () => {
		const stub = new StubCoherentFs();
		const sm = new SessionManager({ createFs: makeFsFactory(stub) });
		await expect(
			sm.withSession("default", "sbx", async () => {
				stub.isPoisoned = true;
			}),
		).rejects.toMatchObject({ code: "ECOHERENCE_UNAPPLIED" });
		await sm.shutdown();
	});

	it("preserves an applied failure without rerunning its callback", async () => {
		const stub = new StubCoherentFs();
		const sm = new SessionManager({ createFs: makeFsFactory(stub) });
		const error = Object.assign(new Error("committed recovery failed"), { code: "ECOHERENCE" });
		const callback = vi.fn(async () => {
			throw error;
		});
		await expect(sm.withSession("default", "sbx", callback)).rejects.toBe(error);
		expect(callback).toHaveBeenCalledOnce();
		await sm.shutdown();
	});
});

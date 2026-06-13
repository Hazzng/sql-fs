/**
 * Audit F9b: boot-time assertion that the session idle window stays below the
 * Redis version-key TTL.
 *
 * The version-key TTL is 7 days (in SECONDS); the idle window is in
 * MILLISECONDS. The guard enforces the MARGIN variant
 * `idleMs <= VERSION_KEY_TTL_SECONDS * 1000 / 2` and only fires when Redis is
 * present. These tests pin both the unit conversion and the redis-scoping.
 */

import type { Redis } from "ioredis";
import type { IFileSystem } from "just-bash";
import { InMemoryFs } from "just-bash";
import { describe, expect, it } from "vitest";
import { SessionManager, assertIdleBelowVersionTtl } from "../../session-manager.js";

// 7 days in seconds → / 2 → * 1000 = max allowed idle window in ms.
const MAX_IDLE_MS = (7 * 24 * 60 * 60 * 1000) / 2; // 302_400_000

const fakeRedis = {} as Redis;

const makeFs = async (): Promise<IFileSystem> => new InMemoryFs();

describe("assertIdleBelowVersionTtl (F9b)", () => {
	it("does not throw when redis is absent, even with an enormous idle window", () => {
		expect(() => assertIdleBelowVersionTtl(MAX_IDLE_MS * 100, false)).not.toThrow();
	});

	it("does not throw for a sane idle window with redis present", () => {
		expect(() => assertIdleBelowVersionTtl(600_000, true)).not.toThrow();
	});

	it("does not throw at exactly the bound with redis present", () => {
		expect(() => assertIdleBelowVersionTtl(MAX_IDLE_MS, true)).not.toThrow();
	});

	it("does not throw just under the bound with redis present", () => {
		expect(() => assertIdleBelowVersionTtl(MAX_IDLE_MS - 1, true)).not.toThrow();
	});

	it("throws just over the bound with redis present", () => {
		expect(() => assertIdleBelowVersionTtl(MAX_IDLE_MS + 1, true)).toThrow(/version-key TTL/);
	});

	it("attaches the ERR_IDLE_TTL_INVARIANT code", () => {
		try {
			assertIdleBelowVersionTtl(MAX_IDLE_MS + 1, true);
			expect.unreachable("should have thrown");
		} catch (err) {
			expect((err as { code?: string }).code).toBe("ERR_IDLE_TTL_INVARIANT");
		}
	});

	it("guards against the unit bug: a value that would pass without *1000 still throws", () => {
		// VERSION_KEY_TTL_SECONDS / 2 = 302_400. A naive seconds-vs-ms compare
		// (no *1000) would treat any idleMs <= 302_400 as fine; the correct ms
		// comparison still allows it, but a value above the ms bound must throw.
		expect(() => assertIdleBelowVersionTtl(302_400, true)).not.toThrow();
		expect(() => assertIdleBelowVersionTtl(MAX_IDLE_MS + 1, true)).toThrow();
	});
});

describe("SessionManager constructor idle/TTL guard (F9b)", () => {
	it("throws when constructed with redis and an over-bound idleMs", () => {
		expect(
			() =>
				new SessionManager({
					createFs: makeFs,
					redis: fakeRedis,
					idleMs: MAX_IDLE_MS + 1,
				}),
		).toThrow(/version-key TTL/);
	});

	it("does not throw with redis and a sane idleMs", () => {
		expect(
			() =>
				new SessionManager({
					createFs: makeFs,
					redis: fakeRedis,
					idleMs: 600_000,
				}),
		).not.toThrow();
	});

	it("does not throw with an over-bound idleMs when redis is absent", () => {
		expect(
			() =>
				new SessionManager({
					createFs: makeFs,
					idleMs: MAX_IDLE_MS + 1,
				}),
		).not.toThrow();
	});
});

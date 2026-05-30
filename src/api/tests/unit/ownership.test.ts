/**
 * Unit tests for ownership enforcement (audit M1 — fail-open ownership).
 *
 * These pin the fail-CLOSED invariant: access is granted only when the caller
 * is positively identified AND matches the recorded owner. An empty/NULL owner
 * must never grant blanket access to every authenticated caller.
 */

import { describe, expect, it } from "vitest";
import { assertSessionOwner, isOwnedBy } from "../../ownership.js";
import type { Session } from "../../session-manager.js";

describe("isOwnedBy (fail-closed)", () => {
	it("grants access when owner equals a non-empty caller", () => {
		expect(isOwnedBy("agent-1", "agent-1")).toBe(true);
	});

	it("denies access when owner differs from caller", () => {
		expect(isOwnedBy("agent-1", "agent-2")).toBe(false);
	});

	it("denies access when owner is empty (no fail-open)", () => {
		expect(isOwnedBy("", "agent-1")).toBe(false);
	});

	it("denies access when owner is null/undefined (no fail-open)", () => {
		expect(isOwnedBy(null, "agent-1")).toBe(false);
		expect(isOwnedBy(undefined, "agent-1")).toBe(false);
	});

	it("denies access when caller is empty even if owner is also empty", () => {
		expect(isOwnedBy("", "")).toBe(false);
	});
});

describe("assertSessionOwner (fail-closed)", () => {
	const mk = (owner: string): Pick<Session, "owner"> => ({ owner }) as Pick<Session, "owner">;

	it("does not throw when caller owns the session", () => {
		expect(() => assertSessionOwner(mk("agent-1"), "agent-1")).not.toThrow();
	});

	it("throws FORBIDDEN for a different caller", () => {
		expect(() => assertSessionOwner(mk("agent-1"), "agent-2")).toThrowError(
			expect.objectContaining({ code: "FORBIDDEN" }),
		);
	});

	it("throws FORBIDDEN for an ownerless session (no fail-open)", () => {
		expect(() => assertSessionOwner(mk(""), "agent-1")).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
	});
});

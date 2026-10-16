import { describe, expect, it } from "vitest";
import { configuredBoolean, positiveIntEnv } from "../../lib/env.js";

describe("positiveIntEnv", () => {
	it("returns the parsed value for a positive integer string", () => {
		expect(positiveIntEnv("8", 16)).toBe(8);
	});

	it("floors a fractional value", () => {
		expect(positiveIntEnv("12.9", 16)).toBe(12);
	});

	it("falls back when unset", () => {
		expect(positiveIntEnv(undefined, 16)).toBe(16);
	});

	it("falls back on an empty string", () => {
		expect(positiveIntEnv("", 16)).toBe(16);
	});

	it("falls back on zero (would otherwise spin a batch loop forever)", () => {
		expect(positiveIntEnv("0", 16)).toBe(16);
	});

	it("falls back on a negative value", () => {
		expect(positiveIntEnv("-4", 16)).toBe(16);
	});

	it("falls back on a non-numeric value (would otherwise make slice(0, NaN) empty)", () => {
		expect(positiveIntEnv("abc", 16)).toBe(16);
	});

	it("falls back on Infinity", () => {
		expect(positiveIntEnv("Infinity", 16)).toBe(16);
	});
});

describe("configuredBoolean", () => {
	it.each([
		[undefined, true, true],
		[undefined, false, false],
		["true", false, true],
		["false", true, false],
	])("reads %j with fallback %s as %s", (value, fallback, expected) => {
		expect(configuredBoolean({ FLAG: value }, "FLAG", fallback)).toBe(expected);
	});

	it.each(["", "1", "yes", "TRUE"])("rejects %j", (value) => {
		expect(() => configuredBoolean({ FLAG: value }, "FLAG", true)).toThrow("FLAG must be true or false");
	});
});

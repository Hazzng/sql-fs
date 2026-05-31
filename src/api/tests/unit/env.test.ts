import { describe, expect, it } from "vitest";
import { positiveIntEnv } from "../../lib/env.js";

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

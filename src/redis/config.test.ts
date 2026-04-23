import { afterEach, describe, expect, it } from "vitest";
import { parseNonNegativeInt } from "./config.js";

const TEST_VAR = "VFS_TEST_ENV_VAR_DO_NOT_SET";

afterEach(() => {
	delete process.env[TEST_VAR];
});

describe("parseNonNegativeInt", () => {
	it("returns the default when the env var is unset", () => {
		expect(parseNonNegativeInt(TEST_VAR, 123)).toBe(123);
	});

	it("returns the default when the env var is empty string", () => {
		process.env[TEST_VAR] = "";
		expect(parseNonNegativeInt(TEST_VAR, 99)).toBe(99);
	});

	it("parses a valid integer", () => {
		process.env[TEST_VAR] = "42";
		expect(parseNonNegativeInt(TEST_VAR, 0)).toBe(42);
	});

	it("parses zero", () => {
		process.env[TEST_VAR] = "0";
		expect(parseNonNegativeInt(TEST_VAR, 5)).toBe(0);
	});

	it("parses a valid finite float", () => {
		process.env[TEST_VAR] = "1500.5";
		expect(parseNonNegativeInt(TEST_VAR, 0)).toBe(1500.5);
	});

	it("throws on non-numeric input", () => {
		process.env[TEST_VAR] = "abc";
		expect(() => parseNonNegativeInt(TEST_VAR, 0)).toThrow(/Invalid value for VFS_TEST_ENV_VAR_DO_NOT_SET/);
	});

	it("throws on negative numbers", () => {
		process.env[TEST_VAR] = "-1";
		expect(() => parseNonNegativeInt(TEST_VAR, 0)).toThrow(/expected a finite, non-negative number/);
	});

	it("throws on Infinity", () => {
		process.env[TEST_VAR] = "Infinity";
		expect(() => parseNonNegativeInt(TEST_VAR, 0)).toThrow(/expected a finite, non-negative number/);
	});

	it("throws on NaN literal", () => {
		process.env[TEST_VAR] = "NaN";
		expect(() => parseNonNegativeInt(TEST_VAR, 0)).toThrow(/expected a finite, non-negative number/);
	});
});

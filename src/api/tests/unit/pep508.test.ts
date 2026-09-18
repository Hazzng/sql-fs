import { describe, expect, it } from "vitest";
import { MARKER_VALUES, evaluateMarker, parseRequirement, parseRequirementText } from "../../commands/pep508.js";

function fail(message: string): never {
	throw new Error(message);
}

function evaluate(marker: string, extra = ""): boolean {
	return evaluateMarker(marker, extra, fail);
}

describe("PEP 508 environment markers", () => {
	it("exposes every standard marker variable", () => {
		expect(Object.keys(MARKER_VALUES).sort()).toEqual([
			"implementation_name",
			"implementation_version",
			"os_name",
			"platform_machine",
			"platform_python_implementation",
			"platform_release",
			"platform_system",
			"platform_version",
			"python_full_version",
			"python_version",
			"sys_platform",
		]);
	});

	it("compares python_version as a version, not a string", () => {
		expect(evaluate('python_version >= "3.9"')).toBe(true);
		expect(evaluate('python_version < "3.9"')).toBe(false);
	});

	it("accepts the variable on the right-hand side", () => {
		expect(evaluate('"3.8" < python_version')).toBe(true);
		expect(evaluate('"3.14" < python_version')).toBe(false);
	});

	it("evaluates the newly added variables instead of failing", () => {
		expect(evaluate('platform_release >= "18"')).toBe(false);
		expect(evaluate('platform_version == ""')).toBe(true);
		expect(evaluate('implementation_version >= "3.13"')).toBe(true);
	});

	it("uses string containment for in and not in", () => {
		expect(evaluate('sys_platform in "linux emscripten darwin"')).toBe(true);
		expect(evaluate('sys_platform not in "linux darwin"')).toBe(true);
		expect(evaluate('"scripten" in sys_platform')).toBe(true);
	});

	it("does not split the right operand of in on commas", () => {
		// "emscripten" is not a substring of this list, even though a
		// comma-splitting implementation would report a match.
		expect(evaluate('sys_platform in "linux,emscript,darwin"')).toBe(false);
	});

	it("does not mistake an in inside a quoted literal for the operator", () => {
		expect(evaluate('"win" in sys_platform')).toBe(false);
		expect(evaluate('"win" not in sys_platform')).toBe(true);
	});

	it("evaluates and, or, not and parentheses", () => {
		expect(evaluate('python_version >= "3.9" and os_name == "posix"')).toBe(true);
		expect(evaluate('python_version < "3" or os_name == "posix"')).toBe(true);
		expect(evaluate('not (os_name == "nt")')).toBe(true);
		expect(evaluate('(python_version >= "3.9" and os_name == "nt") or sys_platform == "emscripten"')).toBe(true);
	});

	it("binds extra to the requested extra", () => {
		expect(evaluate('extra == "socks"', "socks")).toBe(true);
		expect(evaluate('extra == "socks"', "")).toBe(false);
	});

	it("fails hard on an unknown variable, naming it and the marker", () => {
		expect(() => evaluate('platform_libc == "glibc"')).toThrowError(
			"unknown dependency marker variable 'platform_libc' in marker 'platform_libc == \"glibc\"'",
		);
	});

	it("applies the compatible-release upper bound for ~=", () => {
		// Runtime is 3.13.2 — outside the 3.12.x compatible range.
		expect(evaluate('python_full_version ~= "3.12.0"')).toBe(false);
		// Inside the 3.13.x compatible range.
		expect(evaluate('python_full_version ~= "3.13.0"')).toBe(true);
		// python_version is "3.13" — inside ~= "3.7" means >= 3.7, < 4.
		expect(evaluate('python_version ~= "3.7"')).toBe(true);
	});

	it("performs wildcard prefix matching for == and !=", () => {
		// Runtime python_full_version is 3.13.2 — matches 3.13.*.
		expect(evaluate('python_full_version == "3.13.*"')).toBe(true);
		expect(evaluate('python_full_version != "3.13.*"')).toBe(false);
		// Does not match 3.12.*.
		expect(evaluate('python_full_version == "3.12.*"')).toBe(false);
		expect(evaluate('python_full_version != "3.12.*"')).toBe(true);
	});
});

describe("PEP 508 requirements", () => {
	it("parses extras", () => {
		const parsed = parseRequirementText("requests[socks,security] >= 2.0", fail);
		expect(parsed?.requirement).toEqual({
			name: "requests",
			extras: ["socks", "security"],
			specs: [{ operator: ">=", version: "2.0" }],
			raw: "requests[socks,security] >= 2.0",
		});
	});

	it("normalizes the distribution name", () => {
		expect(parseRequirementText("Databricks_CLI", fail)?.requirement.name).toBe("databricks-cli");
	});

	it("separates the marker from the requirement", () => {
		const parsed = parseRequirementText('idna<4; python_version >= "3.8"', fail);
		expect(parsed?.marker).toBe('python_version >= "3.8"');
	});

	it("drops a requirement whose marker excludes the runtime", () => {
		expect(parseRequirement('pywin32; sys_platform == "win32"', "", fail)).toBeUndefined();
	});

	it("keeps a requirement whose marker names the requested extra", () => {
		expect(parseRequirement('pysocks; extra == "socks"', "socks", fail)?.name).toBe("pysocks");
		expect(parseRequirement('pysocks; extra == "socks"', "", fail)).toBeUndefined();
	});
});

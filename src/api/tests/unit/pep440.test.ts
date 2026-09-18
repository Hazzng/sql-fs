import { describe, expect, it } from "vitest";
import {
	compareVersions,
	hasExplicitPrerelease,
	isPreOrDevRelease,
	parseSpecifierSet,
	versionSatisfies,
} from "../../commands/pep440.js";

function specs(input: string): ReturnType<typeof parseSpecifierSet> {
	return parseSpecifierSet(input, (reason) => {
		throw new Error(reason);
	});
}

describe("PEP 440 ordering conformance", () => {
	it("orders an epoch above every version without one", () => {
		expect(compareVersions("1!1.0", "2.0")).toBeGreaterThan(0);
	});

	it("orders a development release below its own release", () => {
		expect(compareVersions("1.0.dev1", "1.0")).toBeLessThan(0);
	});

	it("orders a development release below a pre-release of the same version", () => {
		expect(compareVersions("1.0.dev1", "1.0a1")).toBeLessThan(0);
	});

	it("orders a post release above its own release", () => {
		expect(compareVersions("1.0.post1", "1.0")).toBeGreaterThan(0);
	});

	it("ignores the local label when ordering", () => {
		expect(compareVersions("1.0+ubuntu.1", "1.0")).toBe(0);
	});

	it("orders pre-release labels a < b < rc", () => {
		expect(compareVersions("1.0a2", "1.0b1")).toBeLessThan(0);
		expect(compareVersions("1.0b1", "1.0rc1")).toBeLessThan(0);
	});

	it("pads the shorter release segment with zeros", () => {
		expect(compareVersions("1.0", "1.0.0")).toBe(0);
		expect(compareVersions("1.0.1", "1.0")).toBeGreaterThan(0);
	});
});

describe("PEP 440 specifier conformance", () => {
	it("matches a wildcard equality against the release prefix", () => {
		expect(versionSatisfies("1.2.3", specs("==1.2.*"))).toBe(true);
		expect(versionSatisfies("1.3.0", specs("==1.2.*"))).toBe(false);
	});

	it("excludes a wildcard range with !=", () => {
		expect(versionSatisfies("1.2.3", specs("!=1.2.*"))).toBe(false);
		expect(versionSatisfies("1.3.0", specs("!=1.2.*"))).toBe(true);
	});

	it("bounds ~= at the second-to-last release component", () => {
		expect(versionSatisfies("1.4.6", specs("~=1.4.5"))).toBe(true);
		expect(versionSatisfies("1.5.0", specs("~=1.4.5"))).toBe(false);
		expect(versionSatisfies("1.5", specs("~=1.4"))).toBe(true);
		expect(versionSatisfies("2.0", specs("~=1.4"))).toBe(false);
	});

	it("compares === against the raw string, local label included", () => {
		expect(versionSatisfies("1.0+abc", specs("===1.0+abc"))).toBe(true);
		expect(versionSatisfies("1.0", specs("===1.0+abc"))).toBe(false);
	});

	it("admits an epoch-qualified version only against an epoch specifier", () => {
		expect(versionSatisfies("1!1.0", specs(">=1!1.0"))).toBe(true);
		expect(versionSatisfies("1!1.0", specs("<2.0"))).toBe(false);
	});

	it("admits a post release under >=", () => {
		expect(versionSatisfies("1.0.post1", specs(">=1.0"))).toBe(true);
	});

	it("refuses a wildcard on an ordering operator", () => {
		expect(() => specs(">=1.2.*")).toThrowError(/wildcard is only supported with == or !=/);
	});

	it("refuses a specifier with two wildcards", () => {
		expect(() => specs("==1.*.*")).toThrowError(/unsupported wildcard/);
	});

	it("refuses an unparseable specifier", () => {
		expect(() => specs("=>1.0")).toThrowError(/unsupported version specifier/);
	});
});

describe("pre-release and development release detection", () => {
	it("treats a dev release as a pre-release for candidate filtering", () => {
		expect(isPreOrDevRelease("1.0.dev1")).toBe(true);
		expect(isPreOrDevRelease("1.0a1")).toBe(true);
		expect(isPreOrDevRelease("1.0")).toBe(false);
		expect(isPreOrDevRelease("1.0.post1")).toBe(false);
	});

	it("only allows pre-releases when a specifier names one", () => {
		expect(hasExplicitPrerelease(specs(">=1.0"))).toBe(false);
		expect(hasExplicitPrerelease(specs(">=1.0a1"))).toBe(true);
		expect(hasExplicitPrerelease(specs("==1.0.dev1"))).toBe(true);
	});
});

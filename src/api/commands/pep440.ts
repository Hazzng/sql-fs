/**
 * PEP 440 version handling for the experimental pip command.
 *
 * Supported subset (everything the pure-Python wheel resolver needs):
 *
 * - `N!` epochs (`1!1.0`), compared before the release segment.
 * - Release segments of arbitrary length (`1`, `1.2`, `1.2.3.4`), zero padded
 *   on the shorter side when comparing.
 * - Pre-release segments `a` / `alpha`, `b` / `beta`, `rc` / `c` / `pre` /
 *   `preview`, with or without a separator and with an implicit `0` ordinal.
 * - Post-release segments `.post` / `.rev` / `.r` with an implicit `0`.
 * - Development releases `.dev` with an implicit `0`, ordered before every
 *   other release with the same release segment.
 * - Local version labels (`1.0+ubuntu.1`) are parsed and then IGNORED for
 *   ordering; `===` is the only operator that sees them, because it compares
 *   the raw strings.
 * - Operators `===`, `==` (including a single trailing `.*` wildcard), `!=`
 *   (including the wildcard form), `<`, `<=`, `>`, `>=` and `~=`.
 *
 * Deliberately NOT supported (a specifier using one is refused by
 * `parseSpecifierSet`, never silently accepted): multiple wildcards, a
 * wildcard on an ordering operator, local versions on the right-hand side of
 * an ordering operator, and the `>`/`<` pre-release exclusion subtleties of
 * the full specification. This is an experiment against PyPI wheels, not a
 * conformant installer.
 */

export interface VersionSpec {
	readonly operator: string;
	readonly version: string;
}

export interface ParsedVersion {
	readonly epoch: number;
	readonly release: readonly number[];
	readonly pre: readonly [string, number] | undefined;
	readonly post: number | undefined;
	readonly dev: number | undefined;
	readonly local: string | undefined;
}

const SPEC_PATTERN = /^(===|~=|==|!=|<=|>=|<|>)\s*([A-Za-z0-9][A-Za-z0-9!+._*-]*)$/;

export function parseVersion(input: string): ParsedVersion {
	let value = input.trim().toLowerCase().replace(/^v/, "");
	const epochMatch = value.match(/^([0-9]+)!/);
	const epoch = epochMatch ? Number(epochMatch[1]) : 0;
	if (epochMatch) value = value.slice(epochMatch[0].length);
	const plus = value.indexOf("+");
	const local = plus >= 0 ? value.slice(plus + 1) : undefined;
	if (plus >= 0) value = value.slice(0, plus);
	const devMatch = value.match(/(?:[._-]?dev)([0-9]*)$/);
	const dev = devMatch ? Number(devMatch[1] || 0) : undefined;
	if (devMatch) value = value.slice(0, devMatch.index);
	const postMatch = value.match(/(?:[._-]?(?:post|rev|r))([0-9]*)$/);
	const post = postMatch ? Number(postMatch[1] || 0) : undefined;
	if (postMatch) value = value.slice(0, postMatch.index);
	const preMatch = value.match(/(?:[._-]?(a|b|c|rc|alpha|beta|preview|pre))([0-9]*)$/);
	const pre = preMatch ? ([normalizePreLabel(preMatch[1]!), Number(preMatch[2] || 0)] as const) : undefined;
	if (preMatch) value = value.slice(0, preMatch.index);
	const release = value
		.split(/[._-]/)
		.filter(Boolean)
		.map((part) => Number(part) || 0);
	return { epoch, release, pre, post, dev, local };
}

function normalizePreLabel(label: string): string {
	if (label === "alpha") return "a";
	if (label === "beta") return "b";
	if (label === "c" || label === "pre" || label === "preview") return "rc";
	return label;
}

/**
 * Sort key for the pre-release segment, following the reference
 * implementation: a version with no pre-release but a development release
 * sorts BELOW every pre-release of the same release, and a version with
 * neither sorts above them all.
 */
const PRE_RANK: Readonly<Record<string, number>> = Object.assign(Object.create(null) as Record<string, number>, {
	a: 0,
	b: 1,
	rc: 2,
});
const PRE_BELOW_EVERYTHING = -1;
const PRE_ABOVE_EVERYTHING = 3;

function preKey(parsed: ParsedVersion): readonly [number, number] {
	if (parsed.pre) return [PRE_RANK[parsed.pre[0]] ?? PRE_RANK.rc!, parsed.pre[1]];
	if (parsed.post === undefined && parsed.dev !== undefined) return [PRE_BELOW_EVERYTHING, 0];
	return [PRE_ABOVE_EVERYTHING, 0];
}

export function compareVersions(leftInput: string, rightInput: string): number {
	const left = parseVersion(leftInput);
	const right = parseVersion(rightInput);
	if (left.epoch !== right.epoch) return left.epoch - right.epoch;
	const length = Math.max(left.release.length, right.release.length);
	for (let index = 0; index < length; index++) {
		const difference = (left.release[index] ?? 0) - (right.release[index] ?? 0);
		if (difference) return difference;
	}
	const leftPre = preKey(left);
	const rightPre = preKey(right);
	if (leftPre[0] !== rightPre[0]) return leftPre[0] - rightPre[0];
	if (leftPre[1] !== rightPre[1]) return leftPre[1] - rightPre[1];
	const leftPost = left.post ?? -1;
	const rightPost = right.post ?? -1;
	if (leftPost !== rightPost) return leftPost - rightPost;
	const leftDev = left.dev ?? Number.POSITIVE_INFINITY;
	const rightDev = right.dev ?? Number.POSITIVE_INFINITY;
	if (leftDev !== rightDev) return leftDev < rightDev ? -1 : 1;
	return 0;
}

/** Canonical form used for wildcard prefix matching (local labels excluded). */
function canonicalRelease(parsed: ParsedVersion): string {
	const epoch = parsed.epoch ? `${parsed.epoch}!` : "";
	const pre = parsed.pre ? `${parsed.pre[0]}${parsed.pre[1]}` : "";
	const post = parsed.post === undefined ? "" : `.post${parsed.post}`;
	const dev = parsed.dev === undefined ? "" : `.dev${parsed.dev}`;
	return `${epoch}${parsed.release.join(".")}${pre}${post}${dev}`;
}

export function versionSatisfies(version: string, specs: readonly VersionSpec[]): boolean {
	if (specs.length === 0) return true;
	const parsed = parseVersion(version);
	const normalized = canonicalRelease(parsed);
	return specs.every((spec) => {
		const wildcard = spec.version.endsWith(".*");
		const expected = wildcard ? spec.version.slice(0, -2) : spec.version;
		const comparison = compareVersions(version, expected);
		const equals = (): boolean => {
			if (!wildcard) return comparison === 0;
			const prefix = canonicalRelease(parseVersion(expected));
			return normalized === prefix || normalized.startsWith(`${prefix}.`);
		};
		switch (spec.operator) {
			case "===":
				return version === expected;
			case "==":
				return equals();
			case "!=":
				return !equals();
			case "<":
				return comparison < 0;
			case "<=":
				return comparison <= 0;
			case ">":
				return comparison > 0;
			case ">=":
				return comparison >= 0;
			case "~=": {
				const expectedVersion = parseVersion(expected);
				const upperRelease =
					expectedVersion.release.length <= 1
						? [(expectedVersion.release[0] ?? 0) + 1]
						: [...expectedVersion.release.slice(0, -2), (expectedVersion.release.at(-2) ?? 0) + 1];
				const upper = upperRelease.join(".");
				return compareVersions(version, expected) >= 0 && compareVersions(version, upper) < 0;
			}
			default:
				return false;
		}
	});
}

/**
 * Parses a comma-separated PEP 440 specifier set. `onError` is called with a
 * human-readable reason for anything outside the documented subset; callers
 * decide whether that is fatal (a requirement) or merely disqualifying (a
 * `Requires-Python` value read off PyPI).
 */
export function parseSpecifierSet(input: string, onError: (reason: string) => never): VersionSpec[] {
	const specs: VersionSpec[] = [];
	for (const part of input
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean)) {
		const match = part.match(SPEC_PATTERN);
		if (!match) onError(`unsupported version specifier '${part.slice(0, 80)}'`);
		const operator = match[1]!;
		const version = match[2]!;
		const wildcards = version.split("*").length - 1;
		if (wildcards > 1 || (wildcards === 1 && !version.endsWith(".*"))) {
			onError(`unsupported wildcard in version specifier '${part.slice(0, 80)}'`);
		}
		if (wildcards === 1 && operator !== "==" && operator !== "!=") {
			onError(`wildcard is only supported with == or != in '${part.slice(0, 80)}'`);
		}
		specs.push({ operator, version });
	}
	return specs;
}

/** True when any specifier explicitly names a pre-release or development release. */
export function hasExplicitPrerelease(specs: readonly VersionSpec[]): boolean {
	return specs.some((spec) => /(?:a|b|c|rc|alpha|beta|pre|preview|dev)[0-9]*(?:\.\*)?$/i.test(spec.version));
}

/** True when a release is a pre-release or a development release. */
export function isPreOrDevRelease(version: string): boolean {
	const parsed = parseVersion(version);
	return parsed.pre !== undefined || parsed.dev !== undefined;
}

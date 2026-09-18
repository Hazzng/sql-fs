/**
 * PEP 508 requirement and environment-marker handling for the experimental
 * pip command.
 *
 * The full standard variable set is implemented, evaluated against the
 * CPython WASM runtime just-bash ships. An unknown variable is a hard error:
 * silently treating it as unsatisfied would drop a dependency edge and
 * produce an install that fails later at import time, which is strictly worse
 * than refusing up front.
 */

import { type VersionSpec, compareVersions, parseSpecifierSet } from "./pep440.js";

export interface Requirement {
	readonly name: string;
	readonly extras: readonly string[];
	readonly specs: readonly VersionSpec[];
	readonly raw: string;
}

/**
 * Every PEP 508 environment marker variable, as seen from the CPython WASM
 * runtime (verified against a live sandbox on 2026-09-18). `platform_release`
 * and `platform_version` are empty strings in Emscripten builds; they are
 * present so a marker that mentions them evaluates instead of failing.
 */
export const MARKER_VALUES: Readonly<Record<string, string>> = Object.assign(
	Object.create(null) as Record<string, string>,
	{
		os_name: "posix",
		sys_platform: "emscripten",
		platform_machine: "wasm32",
		platform_release: "",
		platform_system: "Emscripten",
		platform_version: "",
		python_version: "3.13",
		python_full_version: "3.13.2",
		platform_python_implementation: "CPython",
		implementation_name: "cpython",
		implementation_version: "3.13.2",
	},
);

/** Marker variables whose values compare as PEP 440 versions, not as strings. */
const VERSION_VARIABLES = new Set(["python_version", "python_full_version", "implementation_version"]);

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_.]*$/;

/** Longest first, so `===` is not read as `==` and `not in` not as `in`. */
const MARKER_OPERATORS = ["not in", "===", "==", "!=", "<=", ">=", "~=", "in", "<", ">"] as const;

function isWordBoundary(character: string | undefined): boolean {
	return character === undefined || /\s|\(|\)/.test(character);
}

/**
 * Finds the comparison operator of a single marker clause, skipping anything
 * inside quotes so a literal such as `"win" in sys_platform` is not split on
 * the `in` hiding inside `"win"`.
 */
function splitClause(expression: string): { left: string; operator: string; right: string } | undefined {
	let quote = "";
	for (let index = 0; index < expression.length; index++) {
		const character = expression[index]!;
		if (quote) {
			if (character === quote && expression[index - 1] !== "\\") quote = "";
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			continue;
		}
		for (const operator of MARKER_OPERATORS) {
			if (expression.slice(index, index + operator.length).toLowerCase() !== operator) continue;
			const wordy = /^[a-z ]+$/.test(operator);
			if (wordy && !(isWordBoundary(expression[index - 1]) && isWordBoundary(expression[index + operator.length]))) {
				continue;
			}
			return {
				left: expression.slice(0, index),
				operator,
				right: expression.slice(index + operator.length),
			};
		}
	}
	return undefined;
}

export function splitOutsideQuotes(input: string, separator: string): string[] {
	const result: string[] = [];
	let start = 0;
	let depth = 0;
	let quote = "";
	for (let index = 0; index <= input.length - separator.length; index++) {
		const character = input[index];
		if (quote) {
			if (character === quote && input[index - 1] !== "\\") quote = "";
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			continue;
		}
		if (character === "(") depth++;
		if (character === ")") depth--;
		if (depth === 0 && input.slice(index, index + separator.length).toLowerCase() === separator) {
			result.push(input.slice(start, index).trim());
			start = index + separator.length;
			index += separator.length - 1;
		}
	}
	result.push(input.slice(start).trim());
	return result.filter(Boolean);
}

export function stripOuterParens(input: string): string {
	let value = input.trim();
	while (value.startsWith("(") && value.endsWith(")")) {
		let depth = 0;
		let closesAtEnd = true;
		let quote = "";
		for (let index = 0; index < value.length; index++) {
			const character = value[index];
			if (quote) {
				if (character === quote && value[index - 1] !== "\\") quote = "";
				continue;
			}
			if (character === "'" || character === '"') quote = character;
			else if (character === "(") depth++;
			else if (character === ")") {
				depth--;
				if (depth === 0 && index !== value.length - 1) {
					closesAtEnd = false;
					break;
				}
			}
		}
		if (!closesAtEnd) break;
		value = value.slice(1, -1).trim();
	}
	return value;
}

interface Operand {
	readonly value: string;
	/** Set when the operand was a marker variable rather than a string literal. */
	readonly variable: string | undefined;
}

function isQuoted(text: string): boolean {
	return (
		(text.startsWith("'") && text.endsWith("'") && text.length >= 2) ||
		(text.startsWith('"') && text.endsWith('"') && text.length >= 2)
	);
}

function resolveOperand(rawText: string, marker: string, extra: string, fail: (message: string) => never): Operand {
	const text = rawText.trim();
	if (isQuoted(text)) return { value: text.slice(1, -1), variable: undefined };
	if (!IDENTIFIER_PATTERN.test(text)) {
		fail(`unsupported dependency marker operand '${text.slice(0, 80)}' in marker '${marker.slice(0, 120)}'`);
	}
	const name = text.toLowerCase();
	if (name === "extra") return { value: extra, variable: "extra" };
	const value = MARKER_VALUES[name];
	if (value === undefined) {
		fail(`unknown dependency marker variable '${text.slice(0, 60)}' in marker '${marker.slice(0, 120)}'`);
	}
	return { value, variable: name };
}

/**
 * Evaluates a PEP 508 marker. `extra` binds the `extra` variable; pass the
 * empty string for the base dependency set.
 */
export function evaluateMarker(marker: string | undefined, extra: string, fail: (message: string) => never): boolean {
	if (!marker) return true;
	const expression = stripOuterParens(marker);
	const ors = splitOutsideQuotes(expression, " or ");
	if (ors.length > 1) return ors.some((part) => evaluateMarker(part, extra, fail));
	const ands = splitOutsideQuotes(expression, " and ");
	if (ands.length > 1) return ands.every((part) => evaluateMarker(part, extra, fail));
	const negated = expression.match(/^not\s+(?!in\b)(.+)$/i);
	if (negated) return !evaluateMarker(negated[1]!, extra, fail);

	const clause = splitClause(expression);
	if (!clause) fail(`unsupported dependency marker '${marker.slice(0, 120)}'`);
	const operator = clause.operator;
	const left = resolveOperand(clause.left, marker, extra, fail);
	const right = resolveOperand(clause.right, marker, extra, fail);

	// PEP 508 defines `in` / `not in` as plain string containment, in both
	// directions depending on which side is the literal.
	if (operator === "in") return right.value.includes(left.value);
	if (operator === "not in") return !right.value.includes(left.value);

	const asVersion = VERSION_VARIABLES.has(left.variable ?? "") || VERSION_VARIABLES.has(right.variable ?? "");
	const comparison = asVersion
		? compareVersions(left.value, right.value)
		: left.value < right.value
			? -1
			: left.value > right.value
				? 1
				: 0;
	switch (operator) {
		case "==":
			return comparison === 0;
		case "===":
			return left.value === right.value;
		case "!=":
			return comparison !== 0;
		case "<":
			return comparison < 0;
		case "<=":
			return comparison <= 0;
		case ">":
			return comparison > 0;
		case ">=":
			return comparison >= 0;
		case "~=":
			return comparison >= 0;
		default:
			fail(`unsupported dependency marker operator '${operator}'`);
	}
}

const NAME_PATTERN = /^([A-Za-z0-9](?:[-_.A-Za-z0-9]*[A-Za-z0-9])?)(?:\[([^\]]*)\])?\s*(.*)$/;

export function normalizeName(name: string, fail: (message: string) => never): string {
	const normalized = name
		.trim()
		.toLowerCase()
		.replace(/[-_.]+/g, "-");
	if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(normalized)) {
		fail(`invalid package name '${name.slice(0, 80)}'`);
	}
	return normalized;
}

/** Splits `name[extras] specs ; marker` without evaluating the marker. */
export function parseRequirementText(
	raw: string,
	fail: (message: string) => never,
): { readonly requirement: Requirement; readonly marker: string | undefined } | undefined {
	const trimmed = raw.trim();
	if (!trimmed) return undefined;
	const semicolon = splitOutsideQuotes(trimmed, ";");
	const requirementText = semicolon[0] ?? "";
	const marker = semicolon.length > 1 ? semicolon.slice(1).join(";") : undefined;
	const match = requirementText.match(NAME_PATTERN);
	if (!match) fail(`unsupported dependency '${raw.slice(0, 160)}'`);
	const extras = (match[2] ?? "")
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean)
		.map((item) => normalizeName(item, fail));
	const specs = parseSpecifierSet(match[3] ?? "", (reason) => fail(`${reason} in '${raw.slice(0, 120)}'`));
	return {
		requirement: { name: normalizeName(match[1]!, fail), extras, specs, raw: trimmed },
		marker,
	};
}

/**
 * Parses a requirement and applies its marker under `extra`. Returns
 * `undefined` when the marker excludes it.
 */
export function parseRequirement(
	raw: string,
	extra: string,
	fail: (message: string) => never,
): Requirement | undefined {
	const parsed = parseRequirementText(raw, fail);
	if (!parsed) return undefined;
	if (!evaluateMarker(parsed.marker, extra, fail)) return undefined;
	return parsed.requirement;
}

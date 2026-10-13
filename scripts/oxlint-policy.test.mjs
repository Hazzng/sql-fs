import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));

const rejected = [
	["chained casts", "const value = {} as unknown as { id: string };", "anti-slop(no-chained-type-assertions)"],
	["object parameter", "function read(value: object) { return value; }", "anti-slop(no-object-parameters)"],
	[
		"widen then assert",
		'const source = { id: "a" }; const wide: unknown = source; const value = wide as { id: string };',
		"anti-slop(no-widen-then-assert)",
	],
	[
		"accumulator copy",
		"const result = [1, 2].reduce((acc, item) => acc.concat(item), []);",
		"anti-slop(no-reduce-accumulator-copy)",
	],
	[
		"accumulator spread",
		"const result = [1, 2].reduce((acc, item) => [...acc, item], []);",
		"oxc(no-accumulating-spread)",
	],
	[
		"async Promise executor",
		"export const pending = new Promise(async (resolve) => resolve(1));",
		"eslint(no-async-promise-executor)",
	],
	["unsafe finally", "export function run() { try { return 1; } finally { return 2; } }", "eslint(no-unsafe-finally)"],
	[
		"unsafe optional chaining",
		"export function run(value?: { count: number }) { return (value?.count).toString(); }",
		"eslint(no-unsafe-optional-chaining)",
	],
	[
		"missing callback return",
		"export const values = [1].map((value) => { value + 1; });",
		"eslint(array-callback-return)",
	],
	[
		"floating promise",
		"async function work(): Promise<void> {} export function run(): void { work(); }",
		"typescript(no-floating-promises)",
		true,
	],
	[
		"async timer callback",
		"export function run(): void { setTimeout(async () => { await Promise.resolve(); }, 1); }",
		"typescript(no-misused-promises)",
		true,
	],
	[
		"awaiting a number",
		"export async function run(): Promise<number> { return await 1; }",
		"typescript(await-thenable)",
		true,
	],
	[
		"spreading a Map",
		"export function run(value: Map<string, string>) { return { ...value }; }",
		"typescript(no-misused-spread)",
		true,
	],
	["focused test", 'import { it } from "vitest"; it.only("only", () => {});', "vitest(no-focused-tests)", true],
	["disabled test", 'import { it } from "vitest"; it.skip("skip", () => {});', "vitest(no-disabled-tests)", true],
	[
		"describe callback parameters",
		'import { describe } from "vitest"; describe("suite", (done) => {});',
		"vitest(valid-describe-callback)",
		true,
	],
	[
		"unawaited poll",
		'import { expect } from "vitest"; expect.poll(() => 1).toBe(1);',
		"vitest(require-awaited-expect-poll)",
		true,
	],
];

function lint(source, relativePath = "input.ts", typeAware = false) {
	const directory = mkdtempSync(join(root, "src/oxlint-policy-"));
	try {
		const path = join(directory, relativePath);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, source);
		const result = spawnSync(
			process.execPath,
			[
				join(root, "node_modules/oxlint/bin/oxlint"),
				"-c",
				typeAware ? ".oxlintrc-type-aware.json" : ".oxlintrc.json",
				"--deny-warnings",
				"--format",
				"json",
				path,
			],
			{
				cwd: root,
				encoding: "utf8",
				env: { ...process.env, NODE_OPTIONS: "--import=tsx" },
				timeout: 30_000,
			},
		);
		assert.ifError(result.error);
		assert.ok(result.status === 0 || result.status === 1, result.stderr || result.stdout);
		const report = JSON.parse(result.stdout);
		assert.equal(report.number_of_files, 1, "fixture must be linted, not ignored");
		return { status: result.status, diagnostics: report.diagnostics };
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

for (const [name, source, code, typeAware] of rejected) {
	test(`Oxlint rejects ${name}`, () => {
		const result = lint(source, "input.ts", typeAware);
		assert.equal(result.status, 1);
		assert.ok(
			result.diagnostics.some((diagnostic) => diagnostic.code === code),
			JSON.stringify(result),
		);
	});
}

test("Oxlint permits boundary narrowing and module mocks", () => {
	const result = lint(
		'export function parse(value: unknown): string { if (typeof value !== "string") throw new Error("string required"); return value; }\nvi.mock("transport");',
	);
	assert.equal(result.status, 0, JSON.stringify(result));
});

test("test fixtures retain casts but still reject accumulator copies", () => {
	const fixture = "export function double(value: object) { return value as unknown as { id: string }; }";
	assert.equal(lint(fixture, "tests/double.ts").status, 0);
	assert.equal(lint(fixture, "double.test.ts").status, 0);
	const result = lint(
		`${fixture}\nconst result = [1, 2].reduce((acc, item) => acc.concat(item), []);`,
		"tests/double.ts",
	);
	assert.equal(result.status, 1);
	assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "anti-slop(no-reduce-accumulator-copy)"));
});

test("type-aware lint permits assertions attached before a concurrency barrier", () => {
	const result = lint(
		'import { expect } from "vitest"; export async function run(pending: Promise<unknown>, release: () => void): Promise<void> { const assertion = expect(pending).rejects.toThrow("lost"); release(); await assertion; }',
		"input.ts",
		true,
	);
	assert.equal(result.status, 0, JSON.stringify(result));
});

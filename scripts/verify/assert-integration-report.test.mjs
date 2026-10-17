import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assertIntegrationReport } from "./assert-integration-report.mjs";

const passing = { numPassedTests: 3, numFailedTests: 0, numPendingTests: 0 };

test("integration report proof rejects empty, failed or skipped runs", () => {
	assertIntegrationReport(passing);
	for (const report of [
		{ ...passing, numPassedTests: 0 },
		{ ...passing, numFailedTests: 1 },
		{ ...passing, numPendingTests: 1 },
		{},
	]) {
		assert.throws(() => assertIntegrationReport(report));
	}
});

test("integration report CLI exits non-zero for a skipped run", () => {
	const script = fileURLToPath(new URL("./assert-integration-report.mjs", import.meta.url));
	const directory = mkdtempSync(join(tmpdir(), "integration-report-"));
	const write = (name, report) => {
		const file = join(directory, name);
		writeFileSync(file, JSON.stringify(report));
		return file;
	};
	execFileSync(process.execPath, [script, write("pass.json", passing)]);
	assert.throws(
		() => execFileSync(process.execPath, [script, write("skip.json", { ...passing, numPendingTests: 2 })], { stdio: "pipe" }),
		/must not silently skip/,
	);
});

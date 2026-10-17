#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function assertIntegrationReport(report) {
	assert.ok(report.numPassedTests > 0, "Integration tests must execute");
	assert.equal(report.numFailedTests, 0, "Integration tests must pass");
	assert.equal(report.numPendingTests, 0, "Integration tests must not silently skip");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	assertIntegrationReport(JSON.parse(readFileSync(process.argv[2], "utf8")));
}

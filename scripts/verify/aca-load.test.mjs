import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { buildScript, markerIntegrity, outcomeTotals, overloadDelayMs, safeRetryAfter, validateOperation, visitConcurrent } from "./aca-load-workload.mjs";
import { createEventLogger } from "./aca-load-logger.mjs";

const execute = promisify(execFile);
const operation = (outcome, attempts) => ({ id: 1, marker: "one", sandbox: "owned", outcome, attempts });
const counts = (text) => {
	const result = new Map();
	for (const line of text.split("\n").filter(Boolean)) result.set(line, (result.get(line) ?? 0) + 1);
	return result;
};

test("load scripts preserve marker lines and catch broken newline escaping", async () => {
	const directory = await mkdtemp(join(tmpdir(), "sqlfs-aca-script-"));
	try {
		const path = join(directory, "marker file's.txt");
		const config = { hold: 0, cpu: 3 };
		assert.equal((await execute("bash", ["-c", buildScript("first", config, path)])).stdout, "first");
		await execute("bash", ["-c", buildScript("second", config, path)]);
		assert.equal(await readFile(path, "utf8"), "first\nsecond\n");
		const brokenPath = join(directory, "broken.txt");
		const script = buildScript("broken", config, brokenPath);
		const broken = script.replace(String.raw`printf '%s\n'`, String.raw`printf '%s\\n'`);
		assert.notEqual(broken, script);
		await execute("bash", ["-c", broken]);
		const content = await readFile(brokenPath, "utf8");
		assert.equal(content, String.raw`broken\n`);
		const op = operation("success", [{ marker: "broken", success: true }]);
		assert.equal(validateOperation(op, counts(content), true).valid, false);
		assert.equal(markerIntegrity([op], counts(content)).valid, false);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("durable validation rejects missing, duplicate, unexpected and unreadable successes", () => {
	const op = operation("success", [{ marker: "one", success: true }]);
	assert.equal(validateOperation(op, counts("one\n"), true).valid, true);
	assert.equal(validateOperation(op, new Map(), true).valid, false);
	assert.equal(validateOperation(op, counts("one\none\n"), true).valid, false);
	assert.equal(validateOperation(op, new Map(), false).valid, false);
	assert.equal(markerIntegrity([op], counts("one\nunexpected\n")).valid, false);
	assert.equal(markerIntegrity([op], counts("one\none\n")).valid, false);
});

test("a safe refusal never writes, including before a successful retry", () => {
	const op = operation("success", [
		{ marker: "busy", safeRefusal: true },
		{ marker: "done", success: true },
	]);
	assert.equal(validateOperation(op, counts("done\n"), true).valid, true);
	assert.equal(validateOperation(op, counts("busy\ndone\n"), true).valid, false);
});

test("observed markers do not turn unknown or incomplete outcomes into successes", () => {
	const op = operation("unknown", [{ marker: "maybe" }]);
	assert.equal(validateOperation(op, counts("maybe\n"), true).valid, null);
	assert.deepEqual(outcomeTotals([op, { driverError: "interrupted" }]), {
		success: 0,
		safeRefusal: 0,
		unknown: 2,
		failed: 0,
	});
});

test("overload backoff grows within the client deadline and respects Retry-After", () => {
	assert.deepEqual([0, 1, 2, 3, 4, 20].map((attempt) => overloadDelayMs("1", attempt)), [
		1000, 2000, 4000, 8000, 10000, 10000,
	]);
	assert.equal(overloadDelayMs(null, 0), 1000);
	assert.equal(overloadDelayMs("", 0), 1000);
	assert.equal(overloadDelayMs("not-a-date", 0), 1000);
	assert.equal(overloadDelayMs("30", 0), 30000);
	assert.equal(overloadDelayMs("Thu, 01 Jan 1970 00:00:30 GMT", 0, 0), 30000);
	assert.equal(overloadDelayMs("Thu, 01 Jan 1970 00:00:01 GMT", 0, 30000), 1000);
});

test("Retry-After evidence preserves bounded HTTP dates", () => {
	assert.equal(safeRetryAfter("Thu, 01 Jan 1970 00:00:30 GMT"), "Thu, 01 Jan 1970 00:00:30 GMT");
	assert.equal(safeRetryAfter("30"), "30");
	assert.equal(safeRetryAfter("not-a-date"), null);
	assert.equal(safeRetryAfter("x".repeat(129)), null);
});

test("event logging recovers after an append failure and retains the first error", async () => {
	const appendFailure = new Error("disk full");
	const writes = [];
	const failures = [];
	let appendCalls = 0;
	const logger = createEventLogger(async (entry) => {
		if (appendCalls++ === 0) throw appendFailure;
		writes.push(entry);
	}, (error) => failures.push(error));
	await logger.record("first");
	await logger.record("second");
	await logger.flush();
	assert.equal(logger.error, appendFailure);
	assert.deepEqual(failures, [appendFailure]);
	assert.deepEqual(writes, ["second"]);
});


test("fixture workers bound concurrency and drain active calls before rejecting", async () => {
	let active = 0, peak = 0, released = false;
	const started = [], finished = [];
	let release;
	const barrier = new Promise(resolve => { release = resolve; });
	const failure = new Error("fixture creation failed");
	const work = visitConcurrent([0, 1, 2, 3, 4], 3, async item => {
		started.push(item); peak = Math.max(peak, ++active);
		try {
			if (item === 1) throw failure;
			await barrier; finished.push(item);
		} finally { active--; }
	});
	const rejected = assert.rejects(work, error => {
		assert.equal(error, failure); assert.equal(released, true); assert.equal(active, 0); return true;
	});
	await Promise.resolve();
	try { assert.deepEqual(started, [0, 1, 2]); assert.equal(peak, 2); }
	finally { released = true; release(); }
	await rejected;
	assert.deepEqual(finished, [0, 2]);
});

test("fixture workers visit each item once at the requested bound", async () => {
	let active = 0, peak = 0;
	const visited = [];
	await visitConcurrent(Array.from({ length: 11 }, (_, i) => i), 4, async item => {
		peak = Math.max(peak, ++active); await new Promise(resolve => setTimeout(resolve, 1));
		visited.push(item); active--;
	});
	assert.equal(peak, 4); assert.equal(active, 0);
	assert.deepEqual(visited.sort((a, b) => a - b), Array.from({ length: 11 }, (_, i) => i));
});

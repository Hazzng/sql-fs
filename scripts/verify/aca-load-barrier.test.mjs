import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { waitForStartBarrier } from "./aca-load-barrier.mjs";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function fixture(visit) {
	const directory = await mkdtemp(join(tmpdir(), "sqlfs-start-barrier-"));
	try { await visit(join(directory, "release.json")); }
	finally { await rm(directory, { recursive: true, force: true }); }
}
async function prepared(path) {
	for (let i = 0; i < 100; i++) {
		try { return JSON.parse(await readFile(`${path}.prepared.json`, "utf8")); }
		catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
		await pause(5);
	}
	throw new Error("prepared signal not observed");
}

test("the local barrier waits for an explicit release matching its run", async () => {
	await fixture(async (path) => {
		let settled = false;
		const waiting = waitForStartBarrier(path, "fresh-run", { timeoutMs: 1000 });
		waiting.then(() => { settled = true; }, () => { settled = true; });
		const signal = await prepared(path);
		assert.equal(signal.runId, "fresh-run"); assert.equal(signal.releasePath, path);
		await pause(20); assert.equal(settled, false);
		await writeFile(path, JSON.stringify({ runId: signal.runId, release: true }));
		await waiting; assert.equal(settled, true);
	});
});

test("a stale release or a missing explicit release flag cannot start work", async () => {
	for (const [release, code] of [
		[{ runId: "old-run", release: true }, "ESTART_BARRIER_MISMATCH"],
		[{ runId: "fresh-run" }, "ESTART_BARRIER_RELEASE"],
	]) await fixture(async (path) => {
		await writeFile(path, JSON.stringify(release));
		await assert.rejects(waitForStartBarrier(path, "fresh-run", { timeoutMs: 1000 }), { code });
	});
});

test("an unreleased barrier times out and a stopped run never auto-releases", async () => {
	await fixture(async (path) => {
		await assert.rejects(waitForStartBarrier(path, "fresh-run", { timeoutMs: 25 }), { code: "ESTART_BARRIER_TIMEOUT" });
	});
	await fixture(async (path) => {
		let stopped = false;
		const waiting = waitForStartBarrier(path, "fresh-run", { timeoutMs: 1000, isStopped: () => stopped });
		const rejection = assert.rejects(waiting, { code: "ESTART_BARRIER_STOPPED" });
		await prepared(path); stopped = true; await rejection;
	});
});

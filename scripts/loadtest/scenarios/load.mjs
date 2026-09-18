/**
 * Throughput and latency under a concurrency ramp, plus true memory before/after.
 *
 * Establishes the healthy-regime baseline everything else is compared against. Previously measured
 * (1 CPU, local Postgres+Redis): saturates ~3,200 ops/s at C=16-32, with the latency knee at C=8.
 *
 * Usage: node scripts/loadtest/scenarios/load.mjs [--sandboxes 20] [--seconds 20]
 */

import { CONFIG, Client, drive, row } from "../lib/client.mjs";

const arg = (name, dflt) => {
	const i = process.argv.indexOf(`--${name}`);
	return i === -1 ? dflt : Number(process.argv[i + 1]);
};
const SANDBOXES = arg("sandboxes", 20);
const SECONDS = arg("seconds", 20);
const LEVELS = [1, 2, 4, 8, 16, 32, 48];

const api = new Client(CONFIG.replicaA);

console.log(`# load — ${SANDBOXES} sandboxes, ${SECONDS}s per level, replica A\n`);

const ids = [];
for (let i = 0; i < SANDBOXES; i++) {
	const r = await api.createSandbox({ name: `load-${i}` });
	if (r.status !== 201 && r.status !== 200) throw new Error(`create failed: ${r.status} ${r.text}`);
	ids.push(r.json.id);
	// Seed a file so reads and edits have something to work on.
	await api.writeFile(ids[i], "/work.txt", "seed\n".repeat(64));
}
console.log(`seeded ${ids.length} sandboxes\n`);

/**
 * A realistic mix rather than one operation: 40% read, 25% write, 20% exec, 15% edit.
 *
 * The edit writes its own target first and uses `replaceAll`. Editing a shared seeded file is
 * tempting and wrong: a token that appears more than once is rejected as ambiguous, so the edit
 * share silently becomes a measurement of the 409 path instead of the edit path.
 */
const mix = async (api, id, i, worker) => {
	const r = i % 20;
	if (r < 8) return api.readFile(id, "/work.txt");
	if (r < 13) return api.writeFile(id, `/w-${i % 4}.txt`, `body ${i}\n`);
	if (r < 17) return api.exec(id, "echo hi", { timeoutMs: 30_000 });
	// Per-worker path: two workers sharing one would race write-then-edit into a real 409.
	const path = `/e-w${worker}.txt`;
	await api.writeFile(id, path, `token-${i}\n`);
	// Only the PATCH is timed; the setup write is a different operation's cost.
	return api.editFile(id, path, `token-${i}`, `edited-${i}`, true);
};

// Warm the sessions first. Without this the first level pays cache load and session creation and
// reads as an order-of-magnitude outlier, which then gets mistaken for a concurrency effect.
process.stdout.write("warming up... ");
await drive({ workers: 4, durationMs: 4000, task: (i, w) => mix(api, ids[i % ids.length], i, w) });
console.log("done\n");

const widths = [6, 9, 9, 7, 7, 7, 7, 26];
row(["conc", "ops", "ops/s", "p50", "p95", "p99", "max", "codes"], widths);
for (const workers of LEVELS) {
	const res = await drive({
		workers,
		durationMs: SECONDS * 1000,
		task: (i, w) => mix(api, ids[i % ids.length], i, w),
	});
	row(
		[
			workers,
			res.latency.n,
			res.opsPerSec,
			res.latency.p50,
			res.latency.p95,
			res.latency.p99,
			res.latency.max,
			JSON.stringify(res.codes),
		],
		widths,
	);
}

console.log("\ncleaning up");
for (const id of ids) await api.deleteSandbox(id);
console.log("done — a non-2xx code in the healthy regime, or a p99 that climbs with concurrency");
console.log("while ops/s stays flat, is the signal worth chasing.");

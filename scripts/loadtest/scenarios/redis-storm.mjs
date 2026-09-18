/**
 * Redis stall to replica-wide 503 storm — issue #167.
 *
 * Runs against the ISOLATED fault replica with its own Redis, because it deliberately breaks that
 * Redis. One connection carries the blob cache, the version counter and both locks, so large blob
 * writes queue head-of-line in front of latency-critical commands; a process-wide circuit breaker
 * then fast-fails every request on the replica.
 *
 * Signature to look for: ELOCKTIMEOUT with p50 of 1-7 ms. That is the breaker, not lock contention.
 * Bystander reads 503 at the same rate — the blast radius is the whole replica.
 *
 * Usage: node scripts/loadtest/scenarios/redis-storm.mjs [pause|maxmem|freeze]
 */

import { execFileSync } from "node:child_process";
import { CONFIG, Client, drive, sleep } from "../lib/client.mjs";

const MODE = process.argv[2] ?? "pause";
const api = new Client(CONFIG.replicaFault);
const rc = (...args) => execFileSync("redis-cli", ["-p", "6380", ...args]).toString().trim();

const main = await api.createSandbox({ name: "storm-main" });
const bystander = await api.createSandbox({ name: "storm-bystander" });
const mainId = main.json.id;
const byId = bystander.json.id;
await api.writeFile(byId, "/read.txt", "bystander\n");

// 2 MiB payloads: big enough to occupy the shared connection, which is the mechanism.
const payload = "x".repeat(2 * 1024 * 1024);

const inject = async () => {
	if (MODE === "pause") {
		console.log("  injecting: CLIENT PAUSE 6000");
		rc("CLIENT", "PAUSE", "6000");
	} else if (MODE === "maxmem") {
		console.log("  injecting: maxmemory 30mb + noeviction (does NOT self-heal)");
		rc("CONFIG", "SET", "maxmemory", "30mb");
		rc("CONFIG", "SET", "maxmemory-policy", "noeviction");
	} else if (MODE === "freeze") {
		console.log("  injecting: docker pause for 25s");
		execFileSync("docker", ["pause", "lt-redis-fault"]);
		setTimeout(() => execFileSync("docker", ["unpause", "lt-redis-fault"]), 25_000);
	}
};

console.log(`# redis-storm (${MODE}) — isolated replica :${new URL(CONFIG.replicaFault).port}\n`);

const windows = [];
let injected = false;
const started = Date.now();
const res = await drive({
	workers: 12,
	durationMs: 40_000,
	task: async (i) => {
		if (!injected && Date.now() - started > 6000) {
			injected = true;
			await inject();
		}
		// Mix the blob-cache pressure with a bystander read on a DIFFERENT sandbox.
		if (i % 4 === 3) return api.readFile(byId, "/read.txt");
		return api.writeFile(mainId, `/blob-${i % 8}.bin`, payload);
	},
});

console.log(`\nops=${res.latency.n} ops/s=${res.opsPerSec}`);
console.log(`latency ${JSON.stringify(res.latency)}`);
console.log(`codes   ${JSON.stringify(res.codes)}`);

const fivexx = Object.entries(res.codes)
	.filter(([c]) => c.startsWith("5"))
	.reduce((a, [, n]) => a + n, 0);
const pct = ((fivexx / res.latency.n) * 100).toFixed(1);
console.log(`\n5xx: ${fivexx}/${res.latency.n} (${pct}%)`);
console.log(
	res.latency.p50 <= 10 && fivexx > 0
		? ">>> fast-fail signature (p50 <= 10ms with 5xx) — consistent with the process-wide breaker"
		: ">>> no fast-fail signature in this run",
);
console.log("\nGrep the replica log for the chain:");
console.log("  grep -E 'redis_blob_set_error|version_incr_error|ECOHERENCE' scripts/loadtest/.run/fault.log | tail");
console.log("A fix should keep the failure local to the failing operation and leave bystander reads serving.");

if (MODE === "maxmem") {
	rc("CONFIG", "SET", "maxmemory", "0");
	console.log("\n(reset maxmemory to 0)");
}
await sleep(500);
for (const id of [mainId, byId]) await api.deleteSandbox(id);

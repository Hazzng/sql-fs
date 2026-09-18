/**
 * Cross-replica silent lost update — issue #170.
 *
 * This is the scenario a single replica cannot express: the in-process `session.lock` masks it.
 * Two replicas share one database and one Redis, and the lock's heartbeat only DETECTS a stolen
 * lease at its next tick — so a script that finishes inside that window commits having never
 * consulted a lease it no longer holds, and the replica that took over can overwrite it.
 *
 * Shrink the window to make it reachable in seconds rather than minutes:
 *
 *   LT_EXTRA_ENV="REDIS_EXEC_LOCK_LEASE_MS=3000 REDIS_EXEC_LOCK_RENEW_MS=1000" scripts/loadtest/up.sh
 *
 * Without that, the default renew interval is 20s and the measured overlap was 14 seconds.
 *
 * Expected on a BROKEN build: the STEAL run loses A's line (7/7 reproducible).
 * Expected on a FIXED build: A's line survives, or A's commit fails.
 */

import { execFileSync } from "node:child_process";
import { CONFIG, Client, sleep } from "../lib/client.mjs";

const a = new Client(CONFIG.replicaA);
const b = new Client(CONFIG.replicaB);

const redisCli = (...args) =>
	execFileSync("redis-cli", ["-n", String(new URL(process.env.LT_REDIS_SHARED ?? "redis://127.0.0.1:6379/9").pathname.slice(1) || 0), ...args])
		.toString()
		.trim();

async function run(steal) {
	const created = await a.createSandbox({ name: `steal-${steal ? "on" : "off"}` });
	const id = created.json.id;
	await a.writeFile(id, "/shared.txt", "base\n");

	// A long script on replica A: it will finish well after the key is stolen.
	const scriptA = a.exec(id, "sleep 4; echo A-line >> /shared.txt; echo done", { timeoutMs: 60_000 });
	await sleep(1200);

	if (steal) {
		// Models Redis-side key loss with Redis healthy: failover before replication, eviction, restart.
		const key = `vfs:default:rwlock:{${id}}:writer`;
		const deleted = redisCli("DEL", key);
		console.log(`  stole writer key (DEL -> ${deleted})`);
	}

	// Replica B now believes it may write. It reads, then appends.
	const seenByB = (await b.readFile(id, "/shared.txt")).text;
	const bWrite = await b.exec(id, "echo B-line >> /shared.txt", { timeoutMs: 60_000 });
	const aResult = await scriptA;

	await sleep(500);
	const final = (await a.readFile(id, "/shared.txt")).text;
	await a.deleteSandbox(id);

	return {
		seenByB,
		final,
		aStatus: aResult.status,
		aExit: aResult.json?.exitCode,
		bStatus: bWrite.status,
		bExit: bWrite.json?.exitCode,
	};
}

console.log("# replica-steal — two replicas, one db, one redis\n");
for (const steal of [false, true]) {
	console.log(steal ? "STEAL:" : "CONTROL:");
	const r = await run(steal);
	console.log(`  B saw           : ${JSON.stringify(r.seenByB)}`);
	console.log(`  final           : ${JSON.stringify(r.final)}`);
	console.log(`  A http/exit     : ${r.aStatus}/${r.aExit}   B http/exit: ${r.bStatus}/${r.bExit}`);

	// The invariant is symmetric, and which side loses depends on timing: whichever replica commits
	// second overwrites from its own stale cache. Checking only one direction misses half the races.
	const aOk = r.aStatus < 300 && r.aExit === 0;
	const bOk = r.bStatus < 300 && r.bExit === 0;
	const lost = [];
	if (aOk && !r.final.includes("A-line")) lost.push("A");
	if (bOk && !r.final.includes("B-line")) lost.push("B");

	if (lost.length > 0) {
		console.log(
			`  >>> LOST UPDATE: ${lost.join(" and ")} reported success (exit 0) and ${
				lost.length > 1 ? "their lines are" : "its line is"
			} gone — #170 reproduced`,
		);
	} else if (steal) {
		console.log("  >>> both writes survived, or the loser failed cleanly — the property holds");
	}
	console.log();
}
console.log("Verify against the blobs table, not just the API, when confirming a fix:");
console.log(`  psql "$(. scripts/loadtest/env.sh; lt_pg_url $LT_DB_SHARED)" -c "select length(data), size from blobs"`);
console.log("And check BOTH replicas afterwards — they stayed divergent indefinitely (lastSeenVersion).");

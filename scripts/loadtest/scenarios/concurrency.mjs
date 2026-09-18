/**
 * Correctness under concurrent writes — the properties that must hold regardless of load.
 *
 * Every check asserts rather than reports: a lost update or a partial bulk write is a failure, not
 * a measurement. Exit code is non-zero if any check fails, so this is CI-able.
 */

import { CONFIG, Client, drive, sleep } from "../lib/client.mjs";

const api = new Client(CONFIG.replicaA);
const failures = [];
const check = (name, ok, detail = "") => {
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures.push(name);
};

async function sandbox(name) {
	const r = await api.createSandbox({ name });
	if (!r.json?.id) throw new Error(`create failed: ${r.status} ${r.text}`);
	return r.json.id;
}

// ── 1. Concurrent edits: every success must be visible, no interleaving ──────────────────────
{
	const id = await sandbox("conc-edit");
	const N = 40;
	// Delimited and zero-padded: `slot-1` would otherwise be a substring of `slot-10`..`slot-19`,
	// which the uniqueness rule correctly rejects with 409 — and which would also make an
	// `includes()` count lie. The marker has to be unique as a STRING, not just as an id.
	const slot = (i) => `[slot-${String(i).padStart(3, "0")}]`;
	const done = (i) => `[done-${String(i).padStart(3, "0")}]`;
	await api.writeFile(id, "/e.txt", Array.from({ length: N }, (_, i) => slot(i)).join("\n"));
	const res = await drive({
		workers: N,
		total: N,
		task: (i) => api.editFile(id, "/e.txt", slot(i), done(i)),
	});
	const body = (await api.readFile(id, "/e.txt")).text;
	const applied = Array.from({ length: N }, (_, i) => body.includes(done(i))).filter(Boolean).length;
	const ok2xx = Object.entries(res.codes).filter(([c]) => c.startsWith("2")).reduce((a, [, n]) => a + n, 0);
	check(
		"concurrent edits: applied count equals success count",
		applied === ok2xx,
		`${applied} applied / ${ok2xx} 2xx — codes ${JSON.stringify(res.codes)}`,
	);
	check("concurrent edits: every line is intact", body.split("\n").every((l) => /^\[(slot|done)-\d{3}\]$/.test(l)));
	await api.deleteSandbox(id);
}

// ── 2. Lost update: shell read-modify-write from many workers ────────────────────────────────
{
	const id = await sandbox("conc-counter");
	await api.writeFile(id, "/c.txt", "");
	const N = 60;
	const res = await drive({
		workers: 12,
		total: N,
		task: () => api.exec(id, "echo x >> /c.txt", { timeoutMs: 60_000 }),
	});
	const ok2xx = Object.entries(res.codes).filter(([c]) => c.startsWith("2")).reduce((a, [, n]) => a + n, 0);
	const lines = (await api.readFile(id, "/c.txt")).text.split("\n").filter(Boolean).length;
	check("append-only counter: no lost update", lines === ok2xx, `${lines} lines / ${ok2xx} successes`);
	await api.deleteSandbox(id);
}

// ── 3. Bulk write atomicity: a rejected batch must leave nothing ─────────────────────────────
{
	const id = await sandbox("conc-bulk");
	await api.exec(id, "mkdir -p /poison", { timeoutMs: 30_000 });
	// A directory as a target makes the last entry fail; the earlier ones must not survive.
	const r = await api.writeFiles(id, { "/ok-1.txt": "a", "/deep/ok-2.txt": "b", "/poison": "c" });
	const tree = (await api.tree(id)).text;
	check("bulk write: rejected batch is refused", r.status >= 400, `status ${r.status}`);
	check("bulk write: no entry from the failed batch persisted", !tree.includes("ok-1.txt") && !tree.includes("ok-2.txt"));
	check("bulk write: auto-created parent rolled back too", !tree.includes("/deep"));
	const good = await api.writeFiles(id, { "/after.txt": "fine" });
	check("bulk write: session still usable after a rejection", good.status < 300, `status ${good.status}`);
	await api.deleteSandbox(id);
}

// ── 4. Torn reads: a reader must never see a file mid-write ──────────────────────────────────
{
	const id = await sandbox("conc-torn");
	const A = "A".repeat(256 * 1024);
	const B = "B".repeat(256 * 1024);
	await api.writeFile(id, "/t.txt", A);
	let torn = 0;
	const stop = Date.now() + 8000;
	const writer = (async () => {
		let flip = false;
		while (Date.now() < stop) {
			await api.writeFile(id, "/t.txt", (flip = !flip) ? B : A);
		}
	})();
	const reader = (async () => {
		while (Date.now() < stop) {
			const body = (await api.readFile(id, "/t.txt")).text;
			if (body.length > 0 && !/^A+$|^B+$/.test(body)) torn++;
		}
	})();
	await Promise.all([writer, reader]);
	check("size-stable churn: zero torn reads", torn === 0, `${torn} torn`);
	await api.deleteSandbox(id);
}

// ── 5. Owner isolation under load ────────────────────────────────────────────────────────────
{
	const id = await sandbox("conc-isolation");
	await api.writeFile(id, "/secret.txt", "classified");
	const { execFileSync } = await import("node:child_process");
	const intruderToken = execFileSync("node", [new URL("../lib/token.mjs", import.meta.url).pathname, "intruder"], {
		env: { ...process.env, AUTH_SECRET: process.env.LT_AUTH_SECRET ?? "loadtest-secret-at-least-32-bytes-long-xxxxx" },
	})
		.toString()
		.trim();
	const intruder = new Client(CONFIG.replicaA, intruderToken);
	const probes = await drive({
		workers: 10,
		total: 30,
		task: (i) => (i % 2 ? intruder.readFile(id, "/secret.txt") : intruder.exec(id, "cat /secret.txt")),
	});
	const leaked = Object.keys(probes.codes).some((c) => c.startsWith("2"));
	check("owner isolation: another owner is always refused", !leaked, JSON.stringify(probes.codes));
	await api.deleteSandbox(id);
}

await sleep(200);
console.log(`\n${failures.length === 0 ? "all checks passed" : `FAILED: ${failures.join(", ")}`}`);
process.exit(failures.length === 0 ? 0 : 1);

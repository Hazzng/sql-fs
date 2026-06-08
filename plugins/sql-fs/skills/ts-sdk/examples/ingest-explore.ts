/**
 * Bulk-ingest a local folder, then explore the codebase via execBatch.
 *
 * Demonstrates the canonical agent workflow:
 *   1. ONE round-trip via `sb.ingestFiles(...)` to bootstrap the sandbox.
 *   2. ALL subsequent reads/lists via `sb.execBatch([...])` (one round-trip).
 *   3. Clean up.
 *
 * Compare wall-clock cost: per-file `fs.write` would cost N HTTP round-trips
 * (seconds-per-file at typical RTT). `ingestFiles` is one round-trip regardless
 * of file count.
 *
 * Run with:
 *   BASE_URL=... AUTH_SECRET=... npx tsx ingest-explore.ts /path/to/local/code
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { Client } from "sql-fs-sdk";

const SANDBOX_BASE = "/home/user/proj";
const SKIP_DIRS = new Set([".git", "node_modules", "dist", ".next", "__pycache__"]);
const SKIP_NAMES = new Set([".DS_Store"]);

async function collect(root: string, base = root, out: Record<string, Uint8Array> = {}): Promise<Record<string, Uint8Array>> {
	for (const entry of await readdir(root, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			await collect(path.join(root, entry.name), base, out);
		} else if (entry.isFile() && !SKIP_NAMES.has(entry.name)) {
			const abs = path.join(root, entry.name);
			const rel = path.relative(base, abs).split(path.sep).join("/");
			out[rel] = await readFile(abs);
		}
	}
	return out;
}

async function main(): Promise<number> {
	const folder = process.argv[2];
	if (!folder) {
		console.error(`usage: ${process.argv[1]} <local-folder>`);
		return 2;
	}

	console.log(`walking ${folder} ...`);
	const files = await collect(path.resolve(folder));
	const total = Object.values(files).reduce((n, b) => n + b.byteLength, 0);
	console.log(`  ${Object.keys(files).length} files, ${total.toLocaleString()} bytes`);

	const client = new Client({
		baseUrl: process.env.BASE_URL!,
		authSecret: process.env.AUTH_SECRET!,
		sub: "ingest-explore",
	});
	try {
		const sb = await client.sandboxes.create({ name: "ingest-explore" });
		try {
			let t = performance.now();
			await sb.ingestFiles(files, { basePath: SANDBOX_BASE });
			console.log(
				`ingestFiles: ${Math.round(performance.now() - t)} ms ` +
					`(${Object.keys(files).length} files, 1 HTTP round-trip)`,
			);

			// Build an exploration probe-set. Every probe runs in ONE batch
			// round-trip. Add or trim freely — the batch endpoint handles up to
			// 50 scripts and shares a single timeout budget.
			const probes: Array<{ id: string; script: string }> = [
				{ id: "tree", script: `find ${SANDBOX_BASE} -type f -printf '%s %p\\n' | sort -rn | head -10` },
				{ id: "ts_count", script: `find ${SANDBOX_BASE} -name '*.ts' | wc -l` },
				{ id: "imports", script: `grep -rhn '^import ' ${SANDBOX_BASE} 2>/dev/null | sort -u | head -20` },
				{ id: "exports", script: `grep -rhn '^export ' ${SANDBOX_BASE} 2>/dev/null | head -15` },
				{ id: "todos", script: `grep -rn 'TODO\\|FIXME' ${SANDBOX_BASE} 2>/dev/null | head -10` },
				{ id: "entry", script: `find ${SANDBOX_BASE} -maxdepth 2 -name 'index.ts' -o -name 'main.ts' | head -5` },
			];

			t = performance.now();
			const results = await sb.execBatch(probes, { timeoutMs: 60_000, readOnly: true });
			console.log(`execBatch:   ${Math.round(performance.now() - t)} ms for ${probes.length} probes (1 round-trip)`);

			for (const r of results) {
				const head = r.stdout.trimEnd().split("\n").slice(0, 8);
				console.log(`\n[${r.id}] exit=${r.exitCode}`);
				for (const line of head) console.log(`  ${line}`);
			}
		} finally {
			await client.sandboxes.delete(sb.id);
		}
	} finally {
		client.close();
	}
	return 0;
}

process.exit(await main());

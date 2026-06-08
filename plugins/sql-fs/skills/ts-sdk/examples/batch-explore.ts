/**
 * Agent exploration via execBatch — one round-trip, many probes.
 *
 * This is the canonical pattern for an LLM agent doing initial code reconnaissance
 * on a freshly-ingested sandbox. Each probe is independent, so they run as one
 * batch — wall-clock cost is the cost of a single round-trip.
 *
 * Compare:
 *   - 8 individual `sb.exec(...)` calls: ~8 × 700 ms = ~5.6 s
 *   - 1 `sb.execBatch([...])` with 8 scripts: ~700 ms
 *
 * Run with:
 *   BASE_URL=... AUTH_SECRET=... SANDBOX_ID=... npx tsx batch-explore.ts
 *   # (assumes the sandbox is already populated by ingest-explore.ts)
 */

import { Client, type Sandbox } from "sql-fs-sdk";

const SANDBOX_BASE = "/home/user/proj";

async function explore(sb: Sandbox): Promise<Record<string, string>> {
	const probes: Record<string, string> = {
		tree: `find ${SANDBOX_BASE} -type f | head -50`,
		ts_count: `find ${SANDBOX_BASE} -name '*.ts' | wc -l`,
		biggest: `find ${SANDBOX_BASE} -type f -printf '%s %p\\n' | sort -rn | head -5`,
		imports: `grep -rhn '^import ' ${SANDBOX_BASE} 2>/dev/null | sort -u | head -30`,
		exports: `grep -rn '^export ' ${SANDBOX_BASE} 2>/dev/null | head -15`,
		todos: `grep -rn 'TODO\\|FIXME\\|XXX' ${SANDBOX_BASE} 2>/dev/null | head -10`,
		entrypoints: `find ${SANDBOX_BASE} -maxdepth 3 -name 'index.ts' -o -name 'main.ts' -o -name 'server.ts'`,
		pkg: `cat ${SANDBOX_BASE}/package.json 2>/dev/null | head -40`,
	};
	const results = await sb.execBatch(
		Object.entries(probes).map(([id, script]) => ({ id, script })),
		{ timeoutMs: 60_000, readOnly: true },
	);
	return Object.fromEntries(results.filter((r) => r.ok).map((r) => [r.id, r.stdout]));
}

async function main(): Promise<number> {
	const sandboxId = process.env.SANDBOX_ID;
	const client = new Client({
		baseUrl: process.env.BASE_URL!,
		authSecret: process.env.AUTH_SECRET!,
		sub: "batch-explorer",
	});
	try {
		if (!sandboxId) {
			console.error("set SANDBOX_ID to an already-populated sandbox (see ingest-explore.ts)");
			return 1;
		}
		const sb = client.sandboxes.attach(sandboxId);
		console.log(`attached to ${sb.id}`);

		const findings = await explore(sb);
		for (const [id, stdout] of Object.entries(findings)) {
			const preview = stdout.trimEnd().split("\n").slice(0, 6);
			console.log(`\n[${id}]`);
			for (const line of preview) console.log(`  ${line}`);
		}
		// Don't delete an attached sandbox — caller owns its lifecycle.
	} finally {
		client.close();
	}
	return 0;
}

process.exit(await main());

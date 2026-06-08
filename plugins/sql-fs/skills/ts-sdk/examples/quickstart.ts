/**
 * Quickstart — create a sandbox, exec a script, clean up.
 *
 * Run with:
 *   BASE_URL=...  AUTH_SECRET=...  npx tsx quickstart.ts
 */

import { Client, ExecTimeoutError } from "sql-fs-sdk";

async function main(): Promise<number> {
	const baseUrl = process.env.BASE_URL;
	const authSecret = process.env.AUTH_SECRET;
	const token = process.env.TOKEN;
	if (!baseUrl || !(authSecret || token)) {
		console.error("set BASE_URL and either AUTH_SECRET or TOKEN");
		return 2;
	}

	const client = new Client({ baseUrl, authSecret, token, sub: "quickstart" });
	try {
		const sb = await client.sandboxes.create({ name: "quickstart" });
		console.log(`created sandbox ${sb.id}`);
		try {
			// Single buffered exec — get back a flat ExecResult.
			const r = await sb.exec("echo hello && uname -srm");
			if (!r.ok) {
				console.error(`unexpected exit ${r.exitCode}: ${r.error}`);
				return 1;
			}
			console.log(`--- stdout (exit=${r.exitCode}, ${r.durationMs} ms) ---`);
			console.log(r.stdout);

			// Demonstrate timeout handling — exec scripts that exceed timeoutMs
			// surface as ExecTimeoutError, not as a failed-result row.
			try {
				await sb.exec("sleep 5", { timeoutMs: 1_000 });
			} catch (e) {
				if (e instanceof ExecTimeoutError) console.log(`(expected) timed out after ${e.durationMs} ms`);
				else throw e;
			}
		} finally {
			await client.sandboxes.delete(sb.id);
			console.log(`deleted sandbox ${sb.id}`);
		}
	} finally {
		client.close();
	}
	return 0;
}

process.exit(await main());

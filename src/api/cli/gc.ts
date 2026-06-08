/**
 * CLI: Garbage-collect orphan blobs across tenants.
 * US-014 (Phase 4)
 *
 * Usage:
 *   pnpm db:gc                       # grace from BLOB_GC_MIN_AGE_MS (default 3h)
 *   pnpm db:gc -- --min-age-ms 0     # collect all orphans now (ignore grace)
 *   pnpm db:gc -- --tenant tenant-a  # restrict to one tenant
 *
 * Each tenant is collected with a dedicated, context-less Postgres connection
 * so the RLS escape lets the anti-join see every inode. A per-tenant failure is
 * logged and recorded; the remaining tenants still run. Exits non-zero if any
 * tenant failed.
 */

import { closeRedisClient, getRedisClient } from "../../redis/client.js";
import { parseNonNegativeInt } from "../../redis/config.js";
import { runBlobGc } from "../blob-gc.js";
import { loadTenantConfig } from "../tenants.js";

interface CliArgs {
	minAgeMs: string | undefined;
	tenant: string | undefined;
}

function parseArgs(argv: string[]): CliArgs {
	let minAgeMs: string | undefined;
	let tenant: string | undefined;

	const readValue = (flag: string, index: number): string => {
		const next = argv[index + 1];
		if (next === undefined || next.startsWith("--")) {
			throw Object.assign(new Error(`Missing value for ${flag}`), { code: "EINVAL" });
		}
		return next;
	};

	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--min-age-ms") {
			minAgeMs = readValue("--min-age-ms", i);
			i++;
		} else if (argv[i] === "--tenant") {
			tenant = readValue("--tenant", i);
			i++;
		}
	}

	return { minAgeMs, tenant };
}

async function main(): Promise<void> {
	const { minAgeMs: minAgeMsArg, tenant } = parseArgs(process.argv.slice(2));

	let minAgeMs: number;
	if (minAgeMsArg !== undefined) {
		const parsed = Number(minAgeMsArg);
		if (!Number.isInteger(parsed) || parsed < 0) {
			process.stderr.write(`Error: --min-age-ms must be a non-negative integer (got "${minAgeMsArg}").\n`);
			process.exit(1);
		}
		minAgeMs = parsed;
	} else {
		minAgeMs = parseNonNegativeInt("BLOB_GC_MIN_AGE_MS", 3 * 60 * 60 * 1000);
	}

	const tenantConfig = loadTenantConfig();

	let tenantIds: readonly string[] | undefined;
	if (tenant !== undefined) {
		if (!tenantConfig.hasTenant(tenant)) {
			process.stderr.write(`Error: unknown tenant "${tenant}".\n`);
			process.exit(1);
		}
		tenantIds = [tenant];
	}

	const redis = getRedisClient();
	const blobCacheEnabled = process.env.REDIS_BLOB_CACHE_ENABLED !== "false";

	const results = await runBlobGc(tenantConfig, {
		minAgeMs,
		redis: redis ?? undefined,
		blobCacheEnabled,
		...(tenant ? { tenantIds } : {}),
	});

	const total = results.reduce((n, r) => n + r.deleted, 0);
	const failed = results.filter((r) => r.error);

	console.log(JSON.stringify({ event: "blob_gc_complete", total, tenants: results.length, failed: failed.length }));

	await closeRedisClient();

	if (failed.length > 0) process.exit(1);
}

main().catch((err) => {
	process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
	process.exit(1);
});

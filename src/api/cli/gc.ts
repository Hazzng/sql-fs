/**
 * CLI: Garbage-collect orphan blobs across tenants.
 * US-014 (Phase 4)
 *
 * Usage:
 *   pnpm db:gc                       # grace from BLOB_GC_MIN_AGE_MS (default 3h)
 *   pnpm db:gc -- --min-age-ms 0     # collect all orphans now (ignore grace)
 *   pnpm db:gc -- --tenant tenant-a  # restrict to one tenant
 *   pnpm db:gc -- --manifest-ttl-ms 0  # also drop every unreferenced package manifest
 *
 * The pass also expires package manifests (`PIP_MANIFEST_TTL_MS`, default 30
 * days): a manifest no sandbox has installed and unused for longer than the TTL
 * is deleted before the blob anti-join, so the blobs it rooted are collected in
 * the same pass.
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
import { DEFAULT_BLOB_GC_MIN_AGE_MS, DEFAULT_MANIFEST_TTL_MS, parseGcArgs, resolveDurationMs } from "./gc-args.js";

async function main(): Promise<void> {
	const { minAgeMs: minAgeMsArg, manifestTtlMs: manifestTtlMsArg, tenant } = parseGcArgs(process.argv.slice(2));

	const minAgeMs = resolveDurationMs(
		"--min-age-ms",
		minAgeMsArg,
		"BLOB_GC_MIN_AGE_MS",
		DEFAULT_BLOB_GC_MIN_AGE_MS,
		parseNonNegativeInt,
	);
	const manifestTtlMs = resolveDurationMs(
		"--manifest-ttl-ms",
		manifestTtlMsArg,
		"PIP_MANIFEST_TTL_MS",
		DEFAULT_MANIFEST_TTL_MS,
		parseNonNegativeInt,
	);

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
		manifestTtlMs,
		redis: redis ?? undefined,
		blobCacheEnabled,
		...(tenant ? { tenantIds } : {}),
	});

	const total = results.reduce((n, r) => n + r.deleted, 0);
	const manifestsDeleted = results.reduce((n, r) => n + r.manifestsDeleted, 0);
	const failed = results.filter((r) => r.error);

	console.log(
		JSON.stringify({
			event: "blob_gc_complete",
			total,
			manifestsDeleted,
			tenants: results.length,
			failed: failed.length,
		}),
	);

	await closeRedisClient();

	if (failed.length > 0) process.exit(1);
}

main().catch((err) => {
	process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
	process.exit(1);
});

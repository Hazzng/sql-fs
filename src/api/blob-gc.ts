import type { Redis } from "ioredis";
import { PostgresDialect } from "../sql-fs/dialects/postgres.js";
import { RedisBlobCache } from "../sql-fs/redis-blob-cache.js";
import type { TenantConfig } from "./tenants.js";

export interface BlobGcOptions {
	readonly minAgeMs: number;
	readonly redis?: Redis;
	readonly blobCacheEnabled?: boolean;
	/** Restrict to these tenant ids; defaults to all configured tenants. */
	readonly tenantIds?: readonly string[];
}

export interface BlobGcTenantResult {
	readonly tenantId: string;
	readonly deleted: number;
	readonly error?: string;
}

/**
 * Strip credentials from any connection-string-like substring before logging.
 * A per-tenant failure logs `err.message`, which for some driver / DNS / TLS
 * errors can echo the DSN; redacting the `user:pass@` userinfo keeps secrets
 * out of operator logs (CLAUDE.md: no connection strings in errors).
 */
function redactCredentials(message: string): string {
	return message.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]*@/gi, "$1***@");
}

/** Postgres SQLSTATEs that mean "retry the whole transaction". */
const RETRYABLE_SQLSTATES = new Set(["40001", "40P01"]); // serialization_failure, deadlock_detected
const MAX_GC_ATTEMPTS = 5;

function isRetryable(err: unknown): boolean {
	const code = (err as { code?: unknown }).code;
	return typeof code === "string" && RETRYABLE_SQLSTATES.has(code);
}

/**
 * Run the orphan-blob sweep at REPEATABLE READ, retrying on serialization
 * failure. The isolation level is load-bearing for correctness: a concurrent
 * dedup re-adoption (writer touches+locks an existing orphan blob, then inserts
 * its inode) would, under READ COMMITTED, let GC delete the freshly-referenced
 * blob (EvalPlanQual re-checks the blob row but not the inode anti-join). At
 * REPEATABLE READ that conflict raises 40001 and we retry, by which point the
 * inode is committed and the blob is correctly kept.
 */
async function gcOrphanBlobsRetrying(dialect: PostgresDialect, minAgeMs: number): Promise<Uint8Array[]> {
	let lastErr: unknown;
	for (let attempt = 1; attempt <= MAX_GC_ATTEMPTS; attempt++) {
		try {
			return await dialect.transaction((tx) => dialect.gcOrphanBlobs(tx, minAgeMs), {
				isolationLevel: "repeatable read",
			});
		} catch (err) {
			lastErr = err;
			if (!isRetryable(err) || attempt === MAX_GC_ATTEMPTS) throw err;
		}
	}
	throw lastErr; // unreachable: the loop either returns or throws
}

/**
 * Garbage-collect orphan blobs across tenants. Each tenant gets a dedicated
 * dialect connection that NEVER sets a sandbox context, so the RLS escape
 * (migration 0005) lets the anti-join see every inode. Resilient: a per-tenant
 * failure is logged and recorded, and the remaining tenants still run.
 */
export async function runBlobGc(tenantConfig: TenantConfig, opts: BlobGcOptions): Promise<BlobGcTenantResult[]> {
	const tenantIds = opts.tenantIds ?? tenantConfig.tenantIds;
	const results: BlobGcTenantResult[] = [];
	for (const tenantId of tenantIds) {
		const url = tenantConfig.getConnectionString(tenantId);
		const dialect = new PostgresDialect(url);
		try {
			await dialect.connect();
			const deleted = await gcOrphanBlobsRetrying(dialect, opts.minAgeMs);
			if (deleted.length > 0 && opts.redis && opts.blobCacheEnabled !== false) {
				await new RedisBlobCache(opts.redis, tenantId).mdel(deleted);
			}
			console.log(JSON.stringify({ event: "blob_gc_tenant_ok", tenantId, deleted: deleted.length }));
			results.push({ tenantId, deleted: deleted.length });
		} catch (err) {
			const message = redactCredentials(err instanceof Error ? err.message : String(err));
			console.error(JSON.stringify({ event: "blob_gc_tenant_failed", tenantId, error: message }));
			results.push({ tenantId, deleted: 0, error: message });
		} finally {
			await dialect.disconnect().catch(() => {});
		}
	}
	return results;
}

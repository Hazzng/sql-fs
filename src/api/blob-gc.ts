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
			const deleted = await dialect.transaction((tx) => dialect.gcOrphanBlobs(tx, opts.minAgeMs));
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

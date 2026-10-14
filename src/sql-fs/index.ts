/**
 * Factory: createSandboxFs() and destroySandbox().
 * US-053: createSandboxFs factory function
 * US-054: loadBackendConfig
 * US-055: destroySandbox
 *
 * Multi-tenant Phase 2: adds tenant-aware factories
 *   - createPostgresSandboxFs(opts, sandboxId) — explicit connection string + options
 *   - destroyPostgresSandbox(connectionString, sandboxId) — explicit connection string
 *
 * The legacy env-reading `createSandboxFs(backend, sandboxId)` / `destroySandbox(backend, sandboxId)`
 * remain for benchmarks and integration tests that rely on a single `DATABASE_URL`.
 */

import type { IFileSystem } from "just-bash";
import { InMemoryFs } from "just-bash";
import { loadRedisBlobCacheOptions } from "../redis/blob-cache-options.js";
import { getRedisClient } from "../redis/client.js";
import { runTrustedDbAsync } from "./defense.js";
import { PostgresDialect } from "./dialects/postgres.js";
import { raceDriverFault } from "./driver-fault.js";
import { createEnoent } from "./errors.js";
import { RedisBlobCache } from "./redis-blob-cache.js";
import { loadScriptTxBufferConfig, type ScriptTxBufferConfig } from "./script-tx-buffer.js";
import { SqlFs } from "./sql-fs.js";
import type { StorageBackend } from "./types.js";

export type { InodeKind, SandboxListEntry, StorageBackend } from "./types.js";

/**
 * Options passed to the tenant-aware Postgres factory.
 */
export interface PostgresBackendOptions {
	readonly poolMax?: number;
	readonly scriptTxBuffer?: ScriptTxBufferConfig;
	readonly connectionString: string;
	readonly tenantId?: string;
	readonly blobCache?: RedisBlobCache;
	readonly openExisting?: boolean;
}

/**
 * Tenant-aware constructor: builds a `SqlFs` against an explicit Postgres
 * connection string. Used by the multi-tenant `SessionManager` so each
 * tenant's sandboxes talk to the correct database.
 *
 * @param opts.connectionString - Postgres connection URL for this tenant's database.
 * @param opts.blobCache - Optional tenant-scoped RedisBlobCache (Phase 3 makes keys tenant-prefixed).
 * @param sandboxId - Sandbox identifier scoped within this tenant's database.
 */
export async function createPostgresSandboxFs(
	opts: PostgresBackendOptions,
	sandboxId: string,
	owner = "",
): Promise<{ fs: IFileSystem; resolvedOwner: string; createdAt: string }> {
	const dialect = new PostgresDialect(opts.connectionString, opts.blobCache, opts.poolMax);
	await dialect.connect();
	// All post-connect work runs inside try/catch so a failure (sandbox bootstrap,
	// metadata lookup, SqlFs construction, or fs.ready) cannot leak the dialect's
	// connection pool. The pg pool stays alive until disconnect() is awaited.
	try {
		let resolvedOwner = owner;
		let createdAt = new Date().toISOString();
		if (opts.openExisting) {
			const meta = await dialect.transaction(async (tx) => dialect.getSandboxMeta(tx, sandboxId));
			if (meta === null) throw createEnoent(`/${sandboxId}`);
			resolvedOwner = meta.owner ?? "";
			createdAt = meta.createdAt ?? createdAt;
		} else {
			try {
				await dialect.transaction(async (tx) => {
					const result = await dialect.createSandbox(tx, sandboxId, owner);
					createdAt = result.createdAt;
				});
			} catch (e) {
				const sqlErr = e as { code?: string };
				if (sqlErr.code !== "23505") throw e;
				const meta = await dialect.transaction(async (tx) => dialect.getSandboxMeta(tx, sandboxId));
				resolvedOwner = meta?.owner ?? "";
				createdAt = meta?.createdAt ?? createdAt;
			}
		}
		const fs = new SqlFs({
			dialect,
			sandboxId,
			// #166: the deployment default lives here rather than in SqlFs, so a bare
			// `new SqlFs(...)` in a test keeps the legacy script-long-transaction shape.
			scriptTxBuffer: opts.scriptTxBuffer ?? loadScriptTxBufferConfig(),
		});
		await fs.ready();
		return { fs, resolvedOwner, createdAt };
	} catch (err) {
		try {
			await dialect.disconnect();
		} catch (cleanupErr) {
			console.error(
				JSON.stringify({
					event: "postgres_dialect_cleanup_failed",
					sandboxId,
					error: (cleanupErr as Error).message,
				}),
			);
		}
		throw err;
	}
}

/**
 * Tenant-aware destroy: connects to the tenant's Postgres database with the
 * given connection string and deletes the sandbox row + subtree.
 */
export async function destroyPostgresSandbox(connectionString: string, sandboxId: string): Promise<void> {
	const dialect = new PostgresDialect(connectionString);
	await dialect.connect();
	try {
		await dialect.transaction(async (tx) => {
			await dialect.deleteSandbox(tx, sandboxId);
		});
	} finally {
		await dialect.disconnect();
	}
}

export async function retirePostgresSandboxGeneration(connectionString: string, sandboxId: string): Promise<void> {
	const dialect = new PostgresDialect(connectionString);
	await dialect.connect();
	try {
		await raceDriverFault(() =>
			runTrustedDbAsync(() => dialect.transaction((tx) => dialect.retireSandboxGeneration(tx, sandboxId))),
		);
	} finally {
		await dialect.disconnect();
	}
}

/**
 * Creates an IFileSystem instance for the given backend and sandbox ID.
 * For SQL backends, reads DATABASE_URL from process.env.
 * Calls dialect.connect() and fs.ready() before returning.
 *
 * Kept for backward compatibility (benchmarks, integration tests). New
 * multi-tenant code paths should use `createPostgresSandboxFs` instead.
 */
export async function createSandboxFs(backend: StorageBackend, sandboxId: string): Promise<IFileSystem> {
	switch (backend) {
		case "postgres": {
			const databaseUrl = process.env.DATABASE_URL;
			if (!databaseUrl) {
				throw new Error("DATABASE_URL environment variable is required for the postgres backend");
			}
			const blobCacheEnabled = process.env.REDIS_BLOB_CACHE_ENABLED !== "false";
			const redisData = blobCacheEnabled ? getRedisClient("data") : undefined;
			const blobCache =
				redisData && blobCacheEnabled
					? new RedisBlobCache(redisData, "default", loadRedisBlobCacheOptions())
					: undefined;
			const { fs } = await createPostgresSandboxFs({ connectionString: databaseUrl, blobCache }, sandboxId);
			return fs;
		}
		case "memory":
			return new InMemoryFs();
		case "mysql":
		case "azure-sql":
		case "azure-fileshare":
			throw new Error(`createSandboxFs: backend '${backend}' is not implemented`);
	}
}

/** Config returned by loadBackendConfig(). */
export interface BackendConfig {
	readonly backend: StorageBackend;
	readonly databaseUrl?: string;
	readonly mountPath?: string;
}

const SQL_BACKENDS: ReadonlySet<StorageBackend> = new Set(["postgres", "mysql", "azure-sql"]);

/**
 * Reads backend configuration from environment variables.
 * FS_BACKEND is required. DATABASE_URL is required for SQL backends.
 * FS_MOUNT_PATH is required for azure-fileshare.
 */
export function loadBackendConfig(): BackendConfig {
	const fsBackend = process.env.FS_BACKEND;
	if (!fsBackend) {
		throw new Error(
			"FS_BACKEND environment variable is required. Valid values: postgres, mysql, azure-sql, azure-fileshare, memory",
		);
	}

	const validBackends: StorageBackend[] = ["postgres", "mysql", "azure-sql", "azure-fileshare", "memory"];
	if (!validBackends.includes(fsBackend as StorageBackend)) {
		throw new Error(`FS_BACKEND '${fsBackend}' is not a valid backend. Valid values: ${validBackends.join(", ")}`);
	}

	const backend = fsBackend as StorageBackend;

	if (SQL_BACKENDS.has(backend)) {
		const databaseUrl = process.env.DATABASE_URL;
		if (!databaseUrl) {
			throw new Error(`DATABASE_URL environment variable is required when FS_BACKEND is '${backend}'`);
		}
		return { backend, databaseUrl };
	}

	if (backend === "azure-fileshare") {
		const mountPath = process.env.FS_MOUNT_PATH;
		if (!mountPath) {
			throw new Error("FS_MOUNT_PATH environment variable is required when FS_BACKEND is 'azure-fileshare'");
		}
		return { backend, mountPath };
	}

	// memory backend — no additional config needed
	return { backend };
}

/**
 * Destroys a sandbox and all its persistent data.
 * SQL backends: connects to DB, deletes sandbox in a transaction, disconnects.
 * Memory backend: no-op.
 *
 * Kept for backward compatibility. New multi-tenant code paths should use
 * `destroyPostgresSandbox` with an explicit connection string.
 */
export async function destroySandbox(backend: StorageBackend, sandboxId: string): Promise<void> {
	switch (backend) {
		case "postgres": {
			const databaseUrl = process.env.DATABASE_URL;
			if (!databaseUrl) {
				throw new Error("DATABASE_URL environment variable is required for the postgres backend");
			}
			await destroyPostgresSandbox(databaseUrl, sandboxId);
			return;
		}
		case "memory":
			return;
		case "mysql":
		case "azure-sql":
		case "azure-fileshare":
			throw new Error(`destroySandbox: backend '${backend}' is not implemented`);
	}
}

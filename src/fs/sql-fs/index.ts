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

import type { Redis } from "ioredis";
import type { IFileSystem } from "just-bash";
import { InMemoryFs } from "just-bash";
import { getRedisClient } from "../../redis/client.js";
import { parseNonNegativeInt } from "../../redis/config.js";
import { PostgresDialect } from "./dialects/postgres.js";
import { RedisBlobCache } from "./redis-blob-cache.js";
import { RedisPathSnapshot } from "./redis-path-snapshot.js";
import { SqlFs } from "./sql-fs.js";
import type { StorageBackend } from "./types.js";

export type { InodeKind, StorageBackend } from "./types.js";

/**
 * Options passed to the tenant-aware Postgres factory.
 */
export interface PostgresBackendOptions {
	readonly connectionString: string;
	readonly tenantId?: string;
	readonly blobCache?: RedisBlobCache;
	readonly pathSnapshot?: RedisPathSnapshot;
	readonly redis?: Redis;
}

/**
 * Tenant-aware constructor: builds a `SqlFs` against an explicit Postgres
 * connection string. Used by the multi-tenant `SessionManager` so each
 * tenant's sandboxes talk to the correct database.
 *
 * @param opts.connectionString - Postgres connection URL for this tenant's database.
 * @param opts.blobCache - Optional tenant-scoped RedisBlobCache (Phase 3 makes keys tenant-prefixed).
 * @param opts.pathSnapshot - Optional RedisPathSnapshot (shared instance in Phase 2).
 * @param opts.redis - Optional Redis client forwarded to SqlFs for coherence counters.
 * @param sandboxId - Sandbox identifier scoped within this tenant's database.
 */
export async function createPostgresSandboxFs(
	opts: PostgresBackendOptions,
	sandboxId: string,
	owner = "",
): Promise<{ fs: IFileSystem; resolvedOwner: string }> {
	const dialect = new PostgresDialect(opts.connectionString, opts.blobCache);
	await dialect.connect();
	// Initialize the sandbox in the DB (creates root inode structure).
	// On unique violation (23505) the sandbox already exists — read its owner back.
	let resolvedOwner = owner;
	try {
		await dialect.transaction(async (tx) => {
			await dialect.createSandbox(tx, sandboxId, owner);
		});
	} catch (e) {
		const sqlErr = e as { code?: string };
		if (sqlErr.code !== "23505") throw e;
		const meta = await dialect.transaction(async (tx) => dialect.getSandboxMeta(tx, sandboxId));
		resolvedOwner = meta?.owner ?? "";
	}
	const fs = new SqlFs({
		dialect,
		sandboxId,
		tenantId: opts.tenantId,
		redis: opts.redis,
		pathSnapshot: opts.pathSnapshot,
	});
	await fs.ready();
	return { fs, resolvedOwner };
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
			const redis = getRedisClient();
			const blobCacheEnabled = process.env.REDIS_BLOB_CACHE_ENABLED !== "false";
			const blobCache =
				redis && blobCacheEnabled
					? new RedisBlobCache(redis, "default", {
							ttlMs: parseNonNegativeInt("REDIS_BLOB_CACHE_TTL_MS", 24 * 60 * 60 * 1000),
							maxBytes: parseNonNegativeInt("REDIS_BLOB_MAX_BYTES", 8 * 1024 * 1024),
						})
					: undefined;
			const pathSnapshotEnabled = redis && process.env.REDIS_PATH_SNAPSHOT_ENABLED === "true";
			const pathSnapshot = pathSnapshotEnabled
				? new RedisPathSnapshot(redis, {
						ttlMs: parseNonNegativeInt("REDIS_PATH_SNAPSHOT_TTL_MS", 60 * 60 * 1000),
					})
				: undefined;
			const { fs } = await createPostgresSandboxFs(
				{ connectionString: databaseUrl, blobCache, pathSnapshot, redis: redis ?? undefined },
				sandboxId,
			);
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

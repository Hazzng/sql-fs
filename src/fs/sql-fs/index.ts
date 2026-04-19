/**
 * Factory: createSandboxFs() and destroySandbox().
 * US-053: createSandboxFs factory function
 * US-054: loadBackendConfig
 * US-055: destroySandbox
 */

import type { IFileSystem } from "just-bash";
import { InMemoryFs } from "just-bash";
import { PostgresDialect } from "./dialects/postgres.js";
import { SqlFs } from "./sql-fs.js";
import type { StorageBackend } from "./types.js";

export type { InodeKind, StorageBackend } from "./types.js";

/**
 * Creates an IFileSystem instance for the given backend and sandbox ID.
 * For SQL backends, reads DATABASE_URL from process.env.
 * Calls dialect.connect() and fs.ready() before returning.
 */
export async function createSandboxFs(backend: StorageBackend, sandboxId: string): Promise<IFileSystem> {
	switch (backend) {
		case "postgres": {
			const databaseUrl = process.env.DATABASE_URL;
			if (!databaseUrl) {
				throw new Error("DATABASE_URL environment variable is required for the postgres backend");
			}
			const dialect = new PostgresDialect(databaseUrl);
			await dialect.connect();
			const fs = new SqlFs({ dialect, sandboxId });
			await fs.ready();
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
 */
export async function destroySandbox(backend: StorageBackend, sandboxId: string): Promise<void> {
	switch (backend) {
		case "postgres": {
			const databaseUrl = process.env.DATABASE_URL;
			if (!databaseUrl) {
				throw new Error("DATABASE_URL environment variable is required for the postgres backend");
			}
			const dialect = new PostgresDialect(databaseUrl);
			await dialect.connect();
			try {
				await dialect.transaction(async (tx) => {
					await dialect.deleteSandbox(tx, sandboxId);
				});
			} finally {
				await dialect.disconnect();
			}
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

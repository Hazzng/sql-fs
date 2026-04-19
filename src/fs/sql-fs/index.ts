/**
 * Factory: createSandboxFs() and destroySandbox().
 * US-053: createSandboxFs factory function
 * US-054: loadBackendConfig (TODO)
 * US-055: destroySandbox (TODO)
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

// TODO: destroySandbox()
// TODO: loadBackendConfig()

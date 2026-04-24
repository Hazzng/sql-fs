/**
 * Startup migration runner.
 *
 * Applies every .sql file under src/fs/sql-fs/migrations/postgres/ (lexicographic
 * order) to each configured tenant database. Migrations are idempotent
 * (CREATE TABLE IF NOT EXISTS / CREATE OR REPLACE FUNCTION), so rerunning on a
 * migrated database is a no-op.
 *
 * Fails closed: the first tenant error aborts the boot with a clear log line.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import type { TenantConfig } from "./tenants.js";

function migrationFiles(): readonly string[] {
	const dir = fileURLToPath(new URL("../fs/sql-fs/migrations/postgres/", import.meta.url));
	return readdirSync(dir)
		.filter((name) => name.endsWith(".sql"))
		.sort()
		.map((name) => join(dir, name));
}

/**
 * Run Postgres DDL migrations for every tenant in `tenantConfig`, in file order.
 *
 * @param tenantConfig - Resolved tenant → connection string map.
 * @throws If any migration fails for any tenant (after logging `migration_failed`).
 */
export async function runMigrations(tenantConfig: TenantConfig): Promise<void> {
	const files = migrationFiles();
	for (const tenantId of tenantConfig.tenantIds) {
		const url = tenantConfig.getConnectionString(tenantId);
		const sql = postgres(url, { prepare: false, max: 1 });
		try {
			for (const path of files) {
				const body = readFileSync(path, "utf8");
				const file = path.split(/[/\\]/).pop() ?? path;
				console.log(JSON.stringify({ event: "migration_start", tenantId, file }));
				await sql.begin(async (tx) => {
					await tx.unsafe(body);
				});
				console.log(JSON.stringify({ event: "migration_ok", tenantId, file }));
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error(JSON.stringify({ event: "migration_failed", tenantId, error: message }));
			await sql.end({ timeout: 5 });
			throw new Error(`Migration failed for tenant "${tenantId}": ${message}`);
		}
		await sql.end({ timeout: 5 });
	}
}

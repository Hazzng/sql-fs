/**
 * Startup migration runner.
 *
 * Applies every .sql file under src/sql-fs/migrations/postgres/ (lexicographic
 * order) to each configured tenant database in ONE transaction. Migrations are
 * idempotent (CREATE TABLE IF NOT EXISTS / CREATE OR REPLACE FUNCTION), so
 * rerunning on a migrated database is a no-op.
 *
 * Fails closed: the first tenant error aborts the boot with a clear log line.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import type { TenantConfig } from "./tenants.js";

/**
 * Fixed Postgres advisory-lock key for the migration runner (audit M4). Any
 * constant works as long as it is stable across replicas; this is an arbitrary
 * 64-bit value unlikely to collide with application advisory locks (which are
 * derived from sandbox-id hashes).
 */
const MIGRATION_LOCK_KEY = 7_263_001_954_120_388n;

function migrationFiles(): readonly string[] {
	const dir = fileURLToPath(new URL("../sql-fs/migrations/postgres/", import.meta.url));
	return readdirSync(dir)
		.filter((name) => name.endsWith(".sql"))
		.sort()
		.map((name) => join(dir, name));
}

/**
 * Run Postgres DDL migrations for every tenant in `tenantConfig`, in file order.
 *
 * The whole run is a single transaction whose first statement takes
 * `pg_advisory_xact_lock`. This is the only shape that survives a transaction
 * pooler (#164): a session-scoped `pg_advisory_lock` is assigned a server
 * backend per transaction, so the lock, the DDL and the unlock land on
 * different backends — mutual exclusion silently stops holding and the lock
 * leaks onto a pooled connection. A transaction-scoped lock is released by
 * commit/rollback, so there is no unlock to leak and no direct (non-pooled)
 * connection is required.
 *
 * Every migration file must therefore stay transaction-safe: no
 * `CREATE INDEX CONCURRENTLY`, no `VACUUM`, no `REINDEX`.
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
			await sql.begin(async (tx) => {
				// Audit M4: serialize concurrent multi-replica boots. Without this, two
				// replicas can run the same DDL at once and crash-loop / race. The
				// second booter waits here for the first to commit (the migrations are
				// idempotent, so it then re-applies cleanly).
				// Inlined constant (not user input) — pg_advisory_xact_lock takes a
				// bigint literal; the tagged-template param path binds bigints as text.
				await tx.unsafe(`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`);
				for (const path of files) {
					const body = readFileSync(path, "utf8");
					const file = path.split(/[/\\]/).pop() ?? path;
					console.log(JSON.stringify({ event: "migration_start", tenantId, file }));
					await tx.unsafe(body);
					// Applied, not yet durable — a later file can still roll the whole run back.
					console.log(JSON.stringify({ event: "migration_ok", tenantId, file }));
				}
			});
			console.log(JSON.stringify({ event: "migrations_committed", tenantId, files: files.length }));
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error(JSON.stringify({ event: "migration_failed", tenantId, error: message }));
			throw new Error(`Migration failed for tenant "${tenantId}": ${message}`);
		} finally {
			await sql.end({ timeout: 5 });
		}
	}
}

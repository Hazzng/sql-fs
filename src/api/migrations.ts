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

/**
 * Fixed Postgres advisory-lock key for the migration runner (audit M4). Any
 * constant works as long as it is stable across replicas; this is an arbitrary
 * 64-bit value unlikely to collide with application advisory locks (which are
 * derived from sandbox-id hashes).
 */
const MIGRATION_LOCK_KEY = 7_263_001_954_120_388n;

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
		// max:1 so the session-level advisory lock below is held on the one
		// connection that runs every migration.
		const sql = postgres(url, { prepare: false, max: 1 });
		let lockHeld = false;
		try {
			// Audit M4: serialize concurrent multi-replica boots. Without this, two
			// replicas can run the same DDL at once and crash-loop / race. The
			// advisory lock makes the second booter wait for the first to finish
			// (the migrations are idempotent, so it then re-applies cleanly).
			// Inlined constant (not user input) — pg_advisory_lock takes a bigint
			// literal; the tagged-template param path binds bigints as text.
			await sql.unsafe(`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY})`);
			lockHeld = true;
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
			if (lockHeld) {
				try {
					await sql.unsafe(`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY})`);
				} catch {
					// best-effort; the lock also releases when the session ends below
				}
			}
			await sql.end({ timeout: 5 });
			throw new Error(`Migration failed for tenant "${tenantId}": ${message}`);
		}
		if (lockHeld) {
			try {
				await sql.unsafe(`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY})`);
			} catch {
				// best-effort
			}
		}
		await sql.end({ timeout: 5 });
	}
}

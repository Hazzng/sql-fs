/**
 * Startup migration runner.
 *
 * Applies pending .sql files under src/sql-fs/migrations/postgres/ in filename
 * order to each configured tenant database in one transaction. The migration
 * ledger records checksums so unchanged replica boots do not repeat table DDL.
 *
 * Fails closed: the first tenant error aborts the boot with a clear log line.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
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

interface Migration {
	readonly file: string;
	readonly body: string;
	readonly sha256: string;
}

function migrationFiles(): readonly Migration[] {
	const dir = fileURLToPath(new URL("../sql-fs/migrations/postgres/", import.meta.url));
	return readdirSync(dir)
		.filter((name) => name.endsWith(".sql"))
		.sort()
		.map((file) => {
			const body = readFileSync(join(dir, file));
			return { file, body: body.toString("utf8"), sha256: createHash("sha256").update(body).digest("hex") };
		});
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
			const appliedCount = await sql.begin(async (tx) => {
				// Inlined constant (not user input) — pg_advisory_xact_lock takes a
				// bigint literal; the tagged-template param path binds bigints as text.
				await tx.unsafe(`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`);
				await tx`
					CREATE TABLE IF NOT EXISTS public.sql_fs_migrations (
						filename TEXT PRIMARY KEY,
						sha256 TEXT NOT NULL,
						applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
					)
				`;
				const rows = await tx<{ filename: string; sha256: string }[]>`
					SELECT filename, sha256 FROM public.sql_fs_migrations
				`;
				const applied = new Map(rows.map((row) => [row.filename, row.sha256]));
				for (const { file, sha256 } of files) {
					const recorded = applied.get(file);
					if (recorded !== undefined && recorded !== sha256) {
						throw new Error(`Checksum mismatch for applied migration "${file}"; add a new migration instead`);
					}
				}
				const pending = files.filter(({ file }) => !applied.has(file));
				for (const { file, body, sha256 } of pending) {
					console.log(JSON.stringify({ event: "migration_start", tenantId, file }));
					await tx.unsafe(body);
					await tx`
						INSERT INTO public.sql_fs_migrations (filename, sha256) VALUES (${file}, ${sha256})
					`;
					// Applied, not yet durable — a later file can still roll the whole run back.
					console.log(JSON.stringify({ event: "migration_ok", tenantId, file }));
				}
				return pending.length;
			});
			console.log(
				JSON.stringify({
					event: "migrations_committed",
					tenantId,
					files: files.length,
					applied: appliedCount,
					skipped: files.length - appliedCount,
				}),
			);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error(JSON.stringify({ event: "migration_failed", tenantId, error: message }));
			throw new Error(`Migration failed for tenant "${tenantId}": ${message}`);
		} finally {
			await sql.end({ timeout: 5 });
		}
	}
}

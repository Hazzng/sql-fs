/**
 * Schema preconditions for the Postgres integration suites.
 *
 * Several suites used to apply migration DDL themselves in `beforeAll` — either
 * the whole set via `runMigrations` or individual files via `tx.unsafe(ddl)` —
 * so they would work on a database that predated the migration. That is
 * obsolete: `runMigrations` applies every file at boot and in harness setup
 * (`scripts/loadtest/up.sh`). It was also actively harmful. Migration 0005's
 * `ALTER TABLE … ENABLE ROW LEVEL SECURITY` and `DROP`/`CREATE POLICY` take an
 * AccessExclusiveLock on `inodes`/`dirents`/`sandboxes`, and the runner holds
 * one transaction across every file, so a suite migrating the shared database
 * while the rest of the run inserts rows deadlocks — non-deterministically, in
 * whichever file loses the cycle.
 *
 * Asserting the precondition keeps what the self-migration was there for — the
 * suite cannot pass vacuously against an unmigrated database — without taking a
 * single table lock.
 */

import postgres from "postgres";

const MIGRATE_HINT =
	"run the migrations first — they are applied by runMigrations (server boot, or scripts/loadtest/up.sh), not by the test suite";

const RLS_TABLES = ["inodes", "dirents", "sandboxes"] as const;

/**
 * Throws unless the connected database carries the full migrated schema:
 * RLS enabled and forced on every per-sandbox table (0005) and the durable
 * fencing state (0007).
 */
export async function requireMigratedSchema(connectionString: string): Promise<void> {
	const sql = postgres(connectionString, { prepare: false, max: 1 });
	try {
		const rls = await sql<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
			SELECT relname, relrowsecurity, relforcerowsecurity
			FROM pg_class
			WHERE relnamespace = 'public'::regnamespace
			  AND relname IN ${sql(RLS_TABLES)}
		`;
		const missingRls = RLS_TABLES.filter((name) => {
			const row = rls.find((r) => r.relname === name);
			return row === undefined || !row.relrowsecurity || !row.relforcerowsecurity;
		});
		if (missingRls.length > 0) {
			throw new Error(`migration 0005 (RLS) not applied to ${missingRls.join(", ")} — ${MIGRATE_HINT}`);
		}

		const fencing = await sql<{ has_epochs: boolean; has_version: boolean }[]>`
			SELECT to_regclass('public.sandbox_epochs') IS NOT NULL AS has_epochs,
			       EXISTS (
			         SELECT 1 FROM information_schema.columns
			         WHERE table_schema = 'public' AND table_name = 'sandboxes' AND column_name = 'version'
			       ) AS has_version
		`;
		const row = fencing[0];
		if (row === undefined || !row.has_epochs || !row.has_version) {
			throw new Error(`migration 0007 (sandbox fencing) not applied — ${MIGRATE_HINT}`);
		}
	} finally {
		await sql.end({ timeout: 5 });
	}
}

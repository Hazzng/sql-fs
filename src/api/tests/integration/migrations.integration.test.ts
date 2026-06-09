/**
 * Integration tests for startup Postgres migrations (Phase 4).
 *
 * Creates an ephemeral database on the same server as DATABASE_URL so the test
 * does not drop tables on a shared dev database. Skips when DATABASE_URL is unset.
 */

import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../migrations.js";
import { loadTenantConfig } from "../../tenants.js";

const SKIP = !process.env.DATABASE_URL;

function withDatabase(connectionString: string, database: string): string {
	const u = new URL(connectionString);
	u.pathname = `/${database}`;
	return u.toString();
}

function adminConnectionString(connectionString: string): string {
	const u = new URL(connectionString);
	u.pathname = "/postgres";
	return u.toString();
}

describe.skipIf(SKIP)("runMigrations (integration)", () => {
	let dbName: string;
	let testUrl: string;
	let admin: postgres.Sql | undefined;

	beforeAll(async () => {
		const base = process.env.DATABASE_URL;
		if (!base) {
			throw new Error("DATABASE_URL required for this suite");
		}
		dbName = `vfs_mig_${randomBytes(8).toString("hex")}`;
		const adminUrl = adminConnectionString(base);
		testUrl = withDatabase(base, dbName);
		admin = postgres(adminUrl, { prepare: false, max: 1 });
		await admin.unsafe(`CREATE DATABASE ${dbName}`);
	});

	afterAll(async () => {
		if (admin === undefined) {
			return;
		}
		try {
			await admin`
				SELECT pg_terminate_backend(pid)
				FROM pg_stat_activity
				WHERE datname = ${dbName} AND pid <> pg_backend_pid()
			`;
			await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName}`);
		} finally {
			await admin.end({ timeout: 5 });
		}
	});

	it("applies migrations to an empty database and second run is a no-op", async () => {
		const cfg = loadTenantConfig({
			TENANT_DATABASES: JSON.stringify({ default: testUrl }),
		});

		await runMigrations(cfg);

		const sql = postgres(testUrl, { prepare: false, max: 1 });
		try {
			const tables = await sql<{ n: string }[]>`
				SELECT count(*)::text AS n FROM information_schema.tables
				WHERE table_schema = 'public' AND table_name IN ('sandboxes','inodes','dirents','blobs')
			`;
			expect(tables[0]?.n).toBe("4");

			const procs = await sql<{ n: string }[]>`
				SELECT count(*)::text AS n FROM pg_proc p
				JOIN pg_namespace n ON n.oid = p.pronamespace
				WHERE n.nspname = 'public' AND p.proname = 'fs_resolve'
			`;
			expect(Number(procs[0]?.n)).toBeGreaterThanOrEqual(1);

			// 0006: python_runtime column + CHECK exist.
			const col = await sql<{ n: string }[]>`
				SELECT count(*)::text AS n FROM information_schema.columns
				WHERE table_name = 'sandboxes' AND column_name = 'python_runtime'`;
			expect(col[0]?.n).toBe("1");

			// Old-replica-style row (python=true, python_runtime NULL) reads back as stdlib via COALESCE.
			await sql`INSERT INTO sandboxes (id, python, python_runtime) VALUES ('mig-legacy', true, NULL)`;
			const legacy = await sql<{ pr: string | null }[]>`
				SELECT COALESCE(python_runtime, CASE WHEN python THEN 'stdlib' END) AS pr
				FROM sandboxes WHERE id = 'mig-legacy'`;
			expect(legacy[0]?.pr).toBe("stdlib");
		} finally {
			await sql.end({ timeout: 5 });
		}

		await expect(runMigrations(cfg)).resolves.toBeUndefined();
	});

	it("re-runs idempotently after a simulated python-column drop (N+1)", async () => {
		const base = process.env.DATABASE_URL;
		if (!base) {
			throw new Error("DATABASE_URL required for this suite");
		}
		// own ephemeral DB, mirroring beforeAll's create/teardown pattern
		const dropDb = `vfs_mig_drop_${randomBytes(8).toString("hex")}`;
		await admin!.unsafe(`CREATE DATABASE ${dropDb}`);
		const dropUrl = withDatabase(base, dropDb);
		const dropCfg = loadTenantConfig({ TENANT_DATABASES: JSON.stringify({ default: dropUrl }) });
		const s = postgres(dropUrl, { prepare: false, max: 1 });
		try {
			await runMigrations(dropCfg);
			await s`ALTER TABLE sandboxes DROP COLUMN IF EXISTS python`; // simulate the N+1 drop
			await expect(runMigrations(dropCfg)).resolves.toBeUndefined(); // pg_attribute guard → no error
		} finally {
			await s.end({ timeout: 5 });
			await admin!`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
				WHERE datname = ${dropDb} AND pid <> pg_backend_pid()`;
			await admin!.unsafe(`DROP DATABASE IF EXISTS ${dropDb}`);
		}
	});
});

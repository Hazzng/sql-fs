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

	it("applies migrations, backfills sandbox epochs, and second run is a no-op", async () => {
		const cfg = loadTenantConfig({
			TENANT_DATABASES: JSON.stringify({ default: testUrl }),
		});

		// Seed the schema and a row as it existed before migration 0007.
		const legacy = postgres(testUrl, { prepare: false, max: 1 });
		await legacy.unsafe(`
			CREATE TABLE sandboxes (
				id TEXT PRIMARY KEY,
				root_inode BIGINT,
				owner TEXT,
				created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
			)
		`);
		await legacy`INSERT INTO sandboxes (id) VALUES ('legacy-sandbox')`;
		await legacy.end({ timeout: 5 });

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

			const columns = await sql<
				{
					dataType: string;
					isNullable: string;
					columnDefault: string | null;
				}[]
			>`
				SELECT data_type AS "dataType", is_nullable AS "isNullable",
				       column_default AS "columnDefault"
				FROM information_schema.columns
				WHERE table_schema = 'public' AND table_name = 'sandboxes'
				  AND column_name = 'version'
				`;
			expect(columns).toHaveLength(1);
			expect(columns[0]).toMatchObject({
				dataType: "bigint",
				isNullable: "NO",
			});
			expect(columns[0]?.columnDefault).toMatch(/0/);

			const legacyRows = await sql<{ versionEpoch: string }[]>`
				SELECT version::text AS "versionEpoch"
				FROM sandboxes WHERE id = 'legacy-sandbox'
			`;
			expect(legacyRows[0]?.versionEpoch).toBe("0");

			await sql`INSERT INTO sandboxes (id) VALUES ('new-sandbox')`;
			const newRows = await sql<{ versionEpoch: string }[]>`
				SELECT version::text AS "versionEpoch"
				FROM sandboxes WHERE id = 'new-sandbox'
			`;
			expect(newRows[0]?.versionEpoch).toBe("0");
		} finally {
			await sql.end({ timeout: 5 });
		}

		await expect(runMigrations(cfg)).resolves.toBeUndefined();
	}, 60_000);
});

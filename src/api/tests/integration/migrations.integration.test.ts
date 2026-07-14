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

			const versionColumn = await sql<
				{
					data_type: string;
					is_nullable: string;
					column_default: string | null;
				}[]
			>`
				SELECT data_type, is_nullable, column_default
				FROM information_schema.columns
				WHERE table_schema = 'public' AND table_name = 'sandboxes' AND column_name = 'version'
			`;
			expect(versionColumn).toHaveLength(1);
			expect(versionColumn[0]).toMatchObject({
				data_type: "bigint",
				is_nullable: "NO",
			});
			expect(versionColumn[0]?.column_default).toMatch(/0/);

			const inserted = await sql<{ version: string | number }[]>`
				INSERT INTO sandboxes (id, owner) VALUES ('migration-version-default', 'test')
				RETURNING version
			`;
			expect(String(inserted[0]?.version)).toBe("0");

			const procs = await sql<{ n: string }[]>`
				SELECT count(*)::text AS n FROM pg_proc p
				JOIN pg_namespace n ON n.oid = p.pronamespace
				WHERE n.nspname = 'public' AND p.proname = 'fs_resolve'
			`;
			expect(Number(procs[0]?.n)).toBeGreaterThanOrEqual(1);
		} finally {
			await sql.end({ timeout: 5 });
		}

		await expect(runMigrations(cfg)).resolves.toBeUndefined();
	});
});

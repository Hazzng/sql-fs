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
		} finally {
			await sql.end({ timeout: 5 });
		}

		await expect(runMigrations(cfg)).resolves.toBeUndefined();
	});

	it("0007 creates the package tables with RLS on the ledger only, and is idempotent", async () => {
		const cfg = loadTenantConfig({
			TENANT_DATABASES: JSON.stringify({ default: testUrl }),
		});

		// Applied twice: the fresh-database run above plus this one, which must
		// be a no-op (every statement is IF NOT EXISTS / DROP POLICY IF EXISTS).
		await runMigrations(cfg);
		await runMigrations(cfg);

		const sql = postgres(testUrl, { prepare: false, max: 1 });
		try {
			const security = await sql<{ relname: string; rls: boolean; forced: boolean }[]>`
				SELECT relname, relrowsecurity AS rls, relforcerowsecurity AS forced
				FROM pg_class
				WHERE relname IN ('package_manifests', 'package_manifest_files', 'sandbox_packages')
				ORDER BY relname
			`;
			expect(security).toEqual([
				// Tenant-global CAS, like blobs: no sandbox_id, so no policy.
				{ relname: "package_manifest_files", rls: false, forced: false },
				{ relname: "package_manifests", rls: false, forced: false },
				// Sandbox-scoped ledger: enabled AND forced, as inodes in 0005.
				{ relname: "sandbox_packages", rls: true, forced: true },
			]);

			const policies = await sql<{ n: string }[]>`
				SELECT count(*)::text AS n FROM pg_policy
				WHERE polrelid = 'sandbox_packages'::regclass AND polname = 'sandbox_isolation'
			`;
			expect(policies[0]?.n).toBe("1");

			// confdeltype: 'c' = CASCADE, 'r' = RESTRICT.
			const fks = await sql<{ tbl: string; col: string; action: string }[]>`
				SELECT c.conrelid::regclass::text AS tbl,
				       a.attname AS col,
				       c.confdeltype AS action
				FROM pg_constraint c
				JOIN unnest(c.conkey) AS k(attnum) ON true
				JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
				WHERE c.contype = 'f'
				AND c.conrelid IN ('package_manifest_files'::regclass, 'sandbox_packages'::regclass)
				ORDER BY tbl, col
			`;
			expect(fks).toEqual([
				{ tbl: "package_manifest_files", col: "blob_sha256", action: "r" },
				{ tbl: "package_manifest_files", col: "wheel_sha256", action: "c" },
				{ tbl: "sandbox_packages", col: "sandbox_id", action: "c" },
				{ tbl: "sandbox_packages", col: "wheel_sha256", action: "r" },
			]);
		} finally {
			await sql.end({ timeout: 5 });
		}
	});
});

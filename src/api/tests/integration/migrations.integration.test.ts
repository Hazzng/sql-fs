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
	const scratchDbs: string[] = [];

	/** Create an extra ephemeral database and return its connection string. */
	async function createScratchDb(): Promise<string> {
		const base = process.env.DATABASE_URL;
		if (base === undefined || admin === undefined) {
			throw new Error("DATABASE_URL required for this suite");
		}
		const name = `vfs_mig_${randomBytes(8).toString("hex")}`;
		await admin.unsafe(`CREATE DATABASE ${name}`);
		scratchDbs.push(name);
		return withDatabase(base, name);
	}

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
			for (const name of [dbName, ...scratchDbs]) {
				await admin`
					SELECT pg_terminate_backend(pid)
					FROM pg_stat_activity
					WHERE datname = ${name} AND pid <> pg_backend_pid()
				`;
				await admin.unsafe(`DROP DATABASE IF EXISTS ${name}`);
			}
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

			// #131: the fencing epoch. Shape matters — a nullable column or a
			// non-zero default would let a brand-new sandbox start off an epoch no
			// writer ever pinned.
			const version = await sql<{ data_type: string; is_nullable: string; column_default: string | null }[]>`
				SELECT data_type, is_nullable, column_default FROM information_schema.columns
				WHERE table_schema = 'public' AND table_name = 'sandboxes' AND column_name = 'version'
			`;
			expect(version[0]).toEqual({ data_type: "bigint", is_nullable: "NO", column_default: "0" });
		} finally {
			await sql.end({ timeout: 5 });
		}

		await expect(runMigrations(cfg)).resolves.toBeUndefined();
	});

	/**
	 * #164: the whole run must be one transaction, because that is what lets the
	 * advisory lock be transaction-scoped and therefore survive a transaction
	 * pooler. A view named `blobs` is skipped by 0000's CREATE TABLE IF NOT EXISTS
	 * and then fails 0006's ALTER TABLE, so the failure lands in the last file —
	 * after every earlier file would have committed under the old per-file loop.
	 */
	it("commits nothing when a later migration fails", async () => {
		const url = await createScratchDb();
		const seed = postgres(url, { prepare: false, max: 1 });
		try {
			await seed.unsafe("CREATE VIEW blobs AS SELECT 1 AS sha256");
		} finally {
			await seed.end({ timeout: 5 });
		}

		const cfg = loadTenantConfig({ TENANT_DATABASES: JSON.stringify({ default: url }) });
		await expect(runMigrations(cfg)).rejects.toThrow(/blobs.*is not a table|Migration failed/);

		const sql = postgres(url, { prepare: false, max: 1 });
		try {
			const tables = await sql<{ name: string }[]>`
				SELECT table_name AS name FROM information_schema.tables
				WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
				ORDER BY table_name
			`;
			expect(tables.map((r) => r.name)).toEqual([]);
		} finally {
			await sql.end({ timeout: 5 });
		}
	});
});

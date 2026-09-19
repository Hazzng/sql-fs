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

	it("applies migrations to an empty database and second run preserves epoch state", async () => {
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

			const versionColumn = await sql<{ data_type: string; is_nullable: string; column_default: string | null }[]>`
				SELECT data_type, is_nullable, column_default
				FROM information_schema.columns
				WHERE table_schema = 'public' AND table_name = 'sandboxes' AND column_name = 'version'
			`;
			expect(versionColumn).toEqual([{ data_type: "bigint", is_nullable: "NO", column_default: "0" }]);

			const epochColumns = await sql<
				{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }[]
			>`
				SELECT column_name, data_type, is_nullable, column_default
				FROM information_schema.columns
				WHERE table_schema = 'public' AND table_name = 'sandbox_epochs'
				ORDER BY ordinal_position
			`;
			expect(epochColumns).toEqual([
				{ column_name: "sandbox_id", data_type: "text", is_nullable: "NO", column_default: null },
				{ column_name: "epoch", data_type: "bigint", is_nullable: "NO", column_default: "0" },
				{
					column_name: "deleted_at",
					data_type: "timestamp with time zone",
					is_nullable: "NO",
					column_default: "now()",
				},
			]);

			const sandboxId = "migration-epoch-sandbox";
			await sql`INSERT INTO sandboxes (id, root_inode) VALUES (${sandboxId}, NULL)`;
			const initial = await sql<{ version: string }[]>`
				SELECT version::text FROM sandboxes WHERE id = ${sandboxId}
			`;
			expect(initial[0]?.version).toBe("0");

			await sql`
				INSERT INTO sandbox_epochs (sandbox_id, epoch)
				VALUES (${sandboxId}, 1)
			`;
			await sql`DELETE FROM sandboxes WHERE id = ${sandboxId}`;
			const tombstone = await sql<{ sandbox_id: string; epoch: string }[]>`
				SELECT sandbox_id, epoch::text FROM sandbox_epochs WHERE sandbox_id = ${sandboxId}
			`;
			expect(tombstone).toEqual([{ sandbox_id: sandboxId, epoch: "1" }]);
		} finally {
			await sql.end({ timeout: 5 });
		}

		await expect(runMigrations(cfg)).resolves.toBeUndefined();

		const afterRerun = postgres(testUrl, { prepare: false, max: 1 });
		try {
			const versionColumn = await afterRerun<{ data_type: string; is_nullable: string }[]>`
				SELECT data_type, is_nullable
				FROM information_schema.columns
				WHERE table_schema = 'public' AND table_name = 'sandboxes' AND column_name = 'version'
			`;
			expect(versionColumn).toEqual([{ data_type: "bigint", is_nullable: "NO" }]);

			const tombstone = await afterRerun<{ epoch: string }[]>`
				SELECT epoch::text FROM sandbox_epochs WHERE sandbox_id = 'migration-epoch-sandbox'
			`;
			expect(tombstone).toEqual([{ epoch: "1" }]);
		} finally {
			await afterRerun.end({ timeout: 5 });
		}
	}, 60_000);
});

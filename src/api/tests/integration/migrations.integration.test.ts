/**
 * Integration tests for startup Postgres migrations (Phase 4).
 *
 * Creates an ephemeral database on the same server as DATABASE_URL so the test
 * does not drop tables on a shared dev database. Skips when DATABASE_URL is unset.
 */

import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../migrations.js";
import { loadTenantConfig } from "../../tenants.js";

const SKIP = !process.env.DATABASE_URL;
const MIGRATION_DIR = fileURLToPath(new URL("../../../sql-fs/migrations/postgres/", import.meta.url));
const MIGRATION_FILES = readdirSync(MIGRATION_DIR)
	.filter((file) => file.endsWith(".sql"))
	.sort();

async function migrationLedger(sql: postgres.Sql): Promise<{ filename: string; sha256: string; applied_at: string }[]> {
	return sql<{ filename: string; sha256: string; applied_at: string }[]>`
		SELECT filename, sha256, applied_at::text FROM public.sql_fs_migrations ORDER BY filename
	`;
}

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
				// `usename = current_user`: an autovacuum worker attached to the scratch
				// database runs as superuser, and a non-superuser test role terminating
				// it raises — failing the suite in teardown. Only our own connections
				// need evicting before the DROP.
				await admin`
					SELECT pg_terminate_backend(pid)
					FROM pg_stat_activity
					WHERE datname = ${name} AND pid <> pg_backend_pid() AND usename = current_user
				`;
				await admin.unsafe(`DROP DATABASE IF EXISTS ${name}`);
			}
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

	it("records each file checksum and preserves history for each tenant on later boots", async () => {
		const urls = [await createScratchDb(), await createScratchDb()];
		const cfg = loadTenantConfig({ TENANT_DATABASES: JSON.stringify({ first: urls[0], second: urls[1] }) });
		await runMigrations(cfg);
		for (const url of urls) {
			const sql = postgres(url, { prepare: false, max: 1 });
			try {
				const before = await migrationLedger(sql);
				expect(before.map(({ filename, sha256 }) => ({ filename, sha256 }))).toEqual(
					MIGRATION_FILES.map((filename) => ({
						filename,
						sha256: createHash("sha256")
							.update(readFileSync(join(MIGRATION_DIR, filename)))
							.digest("hex"),
					})),
				);
				expect(before.every(({ applied_at }) => Number.isFinite(Date.parse(applied_at)))).toBe(true);
				await runMigrations(cfg);
				expect(await migrationLedger(sql)).toEqual(before);
			} finally {
				await sql.end({ timeout: 5 });
			}
		}
	});

	it("bootstraps migration history for a legacy database", async () => {
		const url = await createScratchDb();
		const sql = postgres(url, { prepare: false, max: 1 });
		try {
			await sql.begin(async (tx) => {
				for (const file of MIGRATION_FILES) {
					await tx.unsafe(readFileSync(join(MIGRATION_DIR, file), "utf8"));
				}
			});
			const before = await sql<{ ledger: string | null }[]>`
				SELECT to_regclass('public.sql_fs_migrations')::text AS ledger
			`;
			expect(before).toEqual([{ ledger: null }]);
			const cfg = loadTenantConfig({ TENANT_DATABASES: JSON.stringify({ default: url }) });
			await runMigrations(cfg);
			expect((await migrationLedger(sql)).map(({ filename }) => filename)).toEqual(MIGRATION_FILES);
		} finally {
			await sql.end({ timeout: 5 });
		}
	});

	it("rejects changed applied checksums before executing pending migrations", async () => {
		const url = await createScratchDb();
		const cfg = loadTenantConfig({ TENANT_DATABASES: JSON.stringify({ default: url }) });
		await runMigrations(cfg);
		const sql = postgres(url, { prepare: false, max: 1 });
		try {
			await sql`UPDATE public.sql_fs_migrations SET sha256 = ${"0".repeat(64)} WHERE filename = '0000_create_tables.sql'`;
			await sql`DELETE FROM public.sql_fs_migrations WHERE filename = '0008_resolve_relative_symlinks.sql'`;
			await sql`DROP FUNCTION fs_resolve_internal(text, boolean, integer)`;
			await expect(runMigrations(cfg)).rejects.toThrow(/Checksum mismatch.*0000_create_tables.sql/);
			const after = await sql<{ resolver: string | null }[]>`
				SELECT to_regprocedure('fs_resolve_internal(text,boolean,integer)')::text AS resolver
			`;
			expect(after).toEqual([{ resolver: null }]);
			expect((await migrationLedger(sql)).map(({ filename }) => filename)).toEqual(MIGRATION_FILES.slice(0, -1));
		} finally {
			await sql.end({ timeout: 5 });
		}
	});

	it("preserves unknown newer migration history", async () => {
		const url = await createScratchDb();
		const cfg = loadTenantConfig({ TENANT_DATABASES: JSON.stringify({ default: url }) });
		await runMigrations(cfg);
		const sql = postgres(url, { prepare: false, max: 1 });
		try {
			await sql`
				INSERT INTO public.sql_fs_migrations (filename, sha256)
				VALUES ('9999_newer_image.sql', ${"1".repeat(64)})
			`;
			const before = await migrationLedger(sql);
			await runMigrations(cfg);
			expect(await migrationLedger(sql)).toEqual(before);
		} finally {
			await sql.end({ timeout: 5 });
		}
	});

	it("rolls back pending DDL and ledger entries together after a later failure", async () => {
		const url = await createScratchDb();
		const cfg = loadTenantConfig({ TENANT_DATABASES: JSON.stringify({ default: url }) });
		await runMigrations(cfg);
		const sql = postgres(url, { prepare: false, max: 1 });
		try {
			await sql`DELETE FROM public.sql_fs_migrations WHERE filename >= '0007_fence_sandbox_epochs.sql'`;
			await sql`DROP TABLE sandbox_epochs`;
			await sql`ALTER TABLE sandboxes DROP COLUMN version`;
			await sql`DROP FUNCTION fs_resolve_internal(text, boolean, integer)`;
			await sql`CREATE FUNCTION fs_resolve_internal(text, boolean, integer) RETURNS text LANGUAGE sql AS 'SELECT NULL::text'`;
			const before = await migrationLedger(sql);
			await expect(runMigrations(cfg)).rejects.toThrow(/cannot change return type of existing function/);
			expect(await migrationLedger(sql)).toEqual(before);
			const rolledBack = await sql<{ epochs: string | null; has_version: boolean }[]>`
				SELECT to_regclass('public.sandbox_epochs')::text AS epochs,
					EXISTS (
						SELECT 1 FROM information_schema.columns
						WHERE table_schema = 'public' AND table_name = 'sandboxes' AND column_name = 'version'
					) AS has_version
			`;
			expect(rolledBack).toEqual([{ epochs: null, has_version: false }]);
			await sql`DROP FUNCTION fs_resolve_internal(text, boolean, integer)`;
			await runMigrations(cfg);
			const after = await migrationLedger(sql);
			expect(after.slice(0, before.length)).toEqual(before);
			expect(after.map(({ filename }) => filename)).toEqual(MIGRATION_FILES);
			const applied = await sql<{ epochs: string | null; has_version: boolean }[]>`
				SELECT to_regclass('public.sandbox_epochs')::text AS epochs,
					EXISTS (
						SELECT 1 FROM information_schema.columns
						WHERE table_schema = 'public' AND table_name = 'sandboxes' AND column_name = 'version'
					) AS has_version
			`;
			expect(applied).toEqual([{ epochs: "sandbox_epochs", has_version: true }]);
		} finally {
			await sql.end({ timeout: 5 });
		}
	});

	it("boots a migrated database while live writers hold filesystem table locks", async () => {
		const url = await createScratchDb();
		const cfg = loadTenantConfig({ TENANT_DATABASES: JSON.stringify({ default: url }) });
		await runMigrations(cfg);
		const bootUrl = new URL(url);
		bootUrl.searchParams.set("options", "-c lock_timeout=2s");
		const bootCfg = loadTenantConfig({ TENANT_DATABASES: JSON.stringify({ default: bootUrl.toString() }) });
		const writer = postgres(url, { prepare: false, max: 1 });
		try {
			await writer.begin(async (tx) => {
				await tx`LOCK TABLE sandboxes, inodes, dirents, blobs IN ROW EXCLUSIVE MODE`;
				await expect(runMigrations(bootCfg)).resolves.toBeUndefined();
			});
		} finally {
			await writer.end({ timeout: 5 });
		}
	});

	it("concurrent cold boots skip DDL while filesystem table locks are held", async () => {
		const url = await createScratchDb();
		const cfg = loadTenantConfig({ TENANT_DATABASES: JSON.stringify({ default: url }) });
		await runMigrations(cfg);
		const bootUrl = new URL(url);
		bootUrl.searchParams.set("options", "-c lock_timeout=2s");
		const bootCfg = loadTenantConfig({ TENANT_DATABASES: JSON.stringify({ default: bootUrl.toString() }) });
		const writer = postgres(url, { prepare: false, max: 1 });
		try {
			await writer.begin(async (tx) => {
				await tx`LOCK TABLE sandboxes, inodes, dirents, blobs IN ROW EXCLUSIVE MODE`;
				const boots = await Promise.allSettled(Array.from({ length: 4 }, () => runMigrations(bootCfg)));
				expect(boots).toEqual(Array.from({ length: 4 }, () => ({ status: "fulfilled", value: undefined })));
			});
		} finally {
			await writer.end({ timeout: 5 });
		}
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

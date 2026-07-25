/**
 * Integration tests for startup Postgres migrations (Phase 4).
 *
 * Creates ephemeral databases on the same server as DATABASE_URL so the test
 * does not drop tables on a shared dev database. Skips when DATABASE_URL is unset.
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../migrations.js";
import { loadTenantConfig } from "../../tenants.js";

const SKIP = !process.env.DATABASE_URL;
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

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

function migrationNames(directory: string): string[] {
	return readdirSync(directory)
		.filter((name) => name.endsWith(".sql"))
		.sort();
}

describe("built Postgres migrations", () => {
	it("retains the later version migration in the runtime migration directory", () => {
		execFileSync(process.execPath, ["scripts/copy-postgres-migrations.mjs"], {
			cwd: REPO_ROOT,
			stdio: "pipe",
		});

		const sourceDirectory = join(REPO_ROOT, "src/sql-fs/migrations/postgres");
		const runtimeDirectory = join(REPO_ROOT, "dist/sql-fs/migrations/postgres");
		const sourceNames = migrationNames(sourceDirectory);
		const laterVersionMigrations = sourceNames.filter((name) => {
			if (name <= "0006_blob_last_referenced_at.sql") {
				return false;
			}
			const body = readFileSync(join(sourceDirectory, name), "utf8");
			return /ALTER\s+TABLE\s+['\"]?sandboxes['\"]?[\s\S]*?version\s+BIGINT\s+NOT\s+NULL\s+DEFAULT\s+0/i.test(body);
		});
		expect(laterVersionMigrations).toHaveLength(1);
		const versionMigration = laterVersionMigrations[0];
		if (versionMigration === undefined) {
			throw new Error("No later sandbox version migration found");
		}
		const previousMigration = "0006_blob_last_referenced_at.sql";
		const runtimeNames = migrationNames(runtimeDirectory);

		expect(sourceNames.indexOf(versionMigration)).toBeGreaterThan(sourceNames.indexOf(previousMigration));
		expect(runtimeNames).toContain(versionMigration);

		const sourceBody = readFileSync(join(sourceDirectory, versionMigration), "utf8");
		const builtBody = readFileSync(join(runtimeDirectory, versionMigration), "utf8");
		expect(builtBody).toBe(sourceBody);
	});
});

describe.skipIf(SKIP)("runMigrations (integration)", () => {
	let dbName: string;
	let legacyDbName: string;
	let testUrl: string;
	let legacyUrl: string;
	let admin: postgres.Sql | undefined;

	beforeAll(async () => {
		const base = process.env.DATABASE_URL;
		if (!base) {
			throw new Error("DATABASE_URL required for this suite");
		}
		dbName = `vfs_mig_${randomBytes(8).toString("hex")}`;
		legacyDbName = `vfs_mig_legacy_${randomBytes(8).toString("hex")}`;
		const adminUrl = adminConnectionString(base);
		testUrl = withDatabase(base, dbName);
		legacyUrl = withDatabase(base, legacyDbName);
		admin = postgres(adminUrl, { prepare: false, max: 1 });
		await admin.unsafe(`CREATE DATABASE ${dbName}`);
		await admin.unsafe(`CREATE DATABASE ${legacyDbName}`);
	});

	afterAll(async () => {
		if (admin === undefined) {
			return;
		}
		try {
			for (const database of [dbName, legacyDbName]) {
				await admin`
					SELECT pg_terminate_backend(pid)
					FROM pg_stat_activity
					WHERE datname = ${database} AND pid <> pg_backend_pid()
				`;
				await admin.unsafe(`DROP DATABASE IF EXISTS ${database}`);
			}
		} finally {
			await admin.end({ timeout: 5 });
		}
	});

	it("applies migrations to an empty database with the durable version schema", async () => {
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

			const columns = await sql<{ dataType: string; udtName: string; isNullable: string }[]>`
				SELECT data_type AS "dataType", udt_name AS "udtName", is_nullable AS "isNullable"
				FROM information_schema.columns
				WHERE table_schema = 'public' AND table_name = 'sandboxes' AND column_name = 'version'
			`;
			expect(columns).toEqual([
				{
					dataType: "bigint",
					udtName: "int8",
					isNullable: "NO",
				},
			]);

			await sql`INSERT INTO sandboxes (id) VALUES ('fresh-version-sandbox')`;
			const defaults = await sql<{ version: string }[]>`
				SELECT version::text FROM sandboxes WHERE id = 'fresh-version-sandbox'
			`;
			expect(defaults).toEqual([{ version: "0" }]);
		} finally {
			await sql.end({ timeout: 5 });
		}

		await expect(runMigrations(cfg)).resolves.toBeUndefined();
	});

	it("backfills an existing sandbox row with version zero", async () => {
		const legacy = postgres(legacyUrl, { prepare: false, max: 1 });
		try {
			await legacy.unsafe(`
				CREATE TABLE sandboxes (
					id TEXT PRIMARY KEY,
					root_inode BIGINT,
					owner TEXT,
					created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
				)
			`);
			await legacy.unsafe(`INSERT INTO sandboxes (id) VALUES ('legacy-sandbox')`);
		} finally {
			await legacy.end({ timeout: 5 });
		}

		const cfg = loadTenantConfig({
			TENANT_DATABASES: JSON.stringify({ default: legacyUrl }),
		});
		await runMigrations(cfg);

		const sql = postgres(legacyUrl, { prepare: false, max: 1 });
		try {
			const rows = await sql<{ version: string }[]>`
				SELECT version::text FROM sandboxes WHERE id = 'legacy-sandbox'
			`;
			expect(rows).toEqual([{ version: "0" }]);
		} finally {
			await sql.end({ timeout: 5 });
		}
	});
});

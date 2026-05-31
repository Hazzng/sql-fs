/**
 * Integration tests for Row-Level Security (audit H1, migration 0005).
 *
 * Proves the DB-level sandbox-isolation backstop:
 *   1. With a sandbox context set, a query CANNOT reach another sandbox's rows
 *      even when it explicitly filters for that other sandbox_id.
 *   2. With NO sandbox context (the trusted-global path used by blob GC,
 *      blob-cache warming, and the sandboxes meta plane) all rows remain
 *      visible, so those operations are not broken by RLS.
 *
 * Skipped when DATABASE_URL is not set so CI without a DB still passes.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresDialect } from "../../dialects/postgres.js";

const RLS_MIGRATION = fileURLToPath(new URL("../../migrations/postgres/0005_enable_rls.sql", import.meta.url));

describe.skipIf(!process.env.DATABASE_URL)("PostgresDialect — RLS sandbox isolation (0005)", () => {
	const dialect = new PostgresDialect(process.env.DATABASE_URL!);
	const suffix = `${Date.now()}`;
	const sandboxA = `rls-a-${suffix}`;
	const sandboxB = `rls-b-${suffix}`;

	beforeAll(async () => {
		await dialect.connect();
		// Apply the RLS migration idempotently so the test is valid even on a DB
		// that was migrated before 0005 existed.
		const ddl = readFileSync(RLS_MIGRATION, "utf8");
		await dialect.transaction(async (tx) => {
			await tx.unsafe(ddl);
		});
		await dialect.transaction((tx) => dialect.createSandbox(tx, sandboxA, "owner-a"));
		await dialect.transaction((tx) => dialect.createSandbox(tx, sandboxB, "owner-b"));
	});

	afterAll(async () => {
		try {
			await dialect.transaction((tx) => dialect.deleteSandbox(tx, sandboxA));
			await dialect.transaction((tx) => dialect.deleteSandbox(tx, sandboxB));
		} finally {
			await dialect.disconnect();
		}
	});

	it("createSandbox succeeds under FORCE RLS (context-free insert path)", async () => {
		// If create were broken by the policy, beforeAll would have thrown; assert
		// both sandboxes have inodes when viewed from their own context.
		const aCount = await dialect.transaction(async (tx) => {
			await dialect.setSandboxContext(tx, sandboxA);
			const rows = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM inodes`;
			return rows[0]!.n;
		});
		expect(aCount).toBeGreaterThan(0);
	});

	it("a query under sandbox A's context cannot see sandbox B's inodes (explicit filter)", async () => {
		const n = await dialect.transaction(async (tx) => {
			await dialect.setSandboxContext(tx, sandboxA);
			const rows = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM inodes WHERE sandbox_id = ${sandboxB}`;
			return rows[0]!.n;
		});
		expect(n).toBe(0);
	});

	it("an unfiltered query under sandbox A's context returns only sandbox A's inodes", async () => {
		const distinctSandboxes = await dialect.transaction(async (tx) => {
			await dialect.setSandboxContext(tx, sandboxA);
			const rows = await tx<{ sandbox_id: string }[]>`SELECT DISTINCT sandbox_id FROM inodes`;
			return rows.map((r) => r.sandbox_id);
		});
		expect(distinctSandboxes).toEqual([sandboxA]);
	});

	it("sandbox A's context cannot see sandbox B's row in the sandboxes table", async () => {
		const n = await dialect.transaction(async (tx) => {
			await dialect.setSandboxContext(tx, sandboxA);
			const rows = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM sandboxes WHERE id = ${sandboxB}`;
			return rows[0]!.n;
		});
		expect(n).toBe(0);
	});

	it("a context-free query (GC / meta plane) still sees every sandbox's rows", async () => {
		const { inodesB, sandboxesB } = await dialect.transaction(async (tx) => {
			// No setSandboxContext — mirrors gcOrphanBlobs / listSandboxes.
			const inodeRows = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM inodes WHERE sandbox_id = ${sandboxB}`;
			const sbRows = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM sandboxes WHERE id = ${sandboxB}`;
			return { inodesB: inodeRows[0]!.n, sandboxesB: sbRows[0]!.n };
		});
		expect(inodesB).toBeGreaterThan(0);
		expect(sandboxesB).toBe(1);
	});
});

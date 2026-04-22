/**
 * Unit tests for PostgresDialect advisory-lock SQL composition.
 * Phase B: asserts setSandboxContext appends pg_advisory_xact_lock after set_config,
 * and deleteSandbox prepends it before DELETE.
 *
 * Uses a fake transaction handle that records each tagged-template call so we can
 * verify the exact SQL composition without hitting a real database.
 */

import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import { PostgresDialect } from "./postgres.js";

interface RecordedCall {
	readonly sql: string;
	readonly values: readonly unknown[];
}

function makeFakeTx(): { tx: postgres.TransactionSql; calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
	const fn = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
		const sql = strings.join("?");
		calls.push({ sql, values });
		return Promise.resolve([]);
	};
	return { tx: fn as unknown as postgres.TransactionSql, calls };
}

describe("PostgresDialect.setSandboxContext — advisory lock", () => {
	it("issues set_config then pg_advisory_xact_lock(hashtextextended) in that order", async () => {
		const dialect = new PostgresDialect("postgres://stub");
		const { tx, calls } = makeFakeTx();
		const sandboxId = "sandbox-abc-123";

		await dialect.setSandboxContext(tx, sandboxId);

		expect(calls).toHaveLength(2);

		expect(calls[0]!.sql).toContain("set_config");
		expect(calls[0]!.sql).toContain("app.sandbox_id");
		expect(calls[0]!.values).toEqual([sandboxId]);

		expect(calls[1]!.sql).toContain("pg_advisory_xact_lock");
		expect(calls[1]!.sql).toContain("hashtextextended");
		expect(calls[1]!.values).toEqual([sandboxId]);
	});

	it("binds the sandboxId as a parameter (no string interpolation)", async () => {
		const dialect = new PostgresDialect("postgres://stub");
		const { tx, calls } = makeFakeTx();
		const sandboxId = "sandbox'; DROP TABLE sandboxes; --";

		await dialect.setSandboxContext(tx, sandboxId);

		expect(calls[1]!.sql).not.toContain(sandboxId);
		expect(calls[1]!.values).toEqual([sandboxId]);
	});
});

describe("PostgresDialect.deleteSandbox — advisory lock", () => {
	it("acquires pg_advisory_xact_lock before the DELETE statement", async () => {
		const dialect = new PostgresDialect("postgres://stub");
		const { tx, calls } = makeFakeTx();
		const sandboxId = "sandbox-xyz-456";

		await dialect.deleteSandbox(tx, sandboxId);

		expect(calls).toHaveLength(2);

		expect(calls[0]!.sql).toContain("pg_advisory_xact_lock");
		expect(calls[0]!.sql).toContain("hashtextextended");
		expect(calls[0]!.values).toEqual([sandboxId]);

		expect(calls[1]!.sql).toContain("DELETE FROM sandboxes");
		expect(calls[1]!.values).toEqual([sandboxId]);
	});

	it("uses the same hash key derivation on both lock acquisitions (write and destroy paths)", async () => {
		const dialect = new PostgresDialect("postgres://stub");
		const sandboxId = "sandbox-parity";

		const writePath = makeFakeTx();
		await dialect.setSandboxContext(writePath.tx, sandboxId);

		const destroyPath = makeFakeTx();
		await dialect.deleteSandbox(destroyPath.tx, sandboxId);

		const normalize = (sql: string): string => sql.replace(/\s+/g, " ").trim();
		const writeLockSql = normalize(writePath.calls[1]!.sql);
		const destroyLockSql = normalize(destroyPath.calls[0]!.sql);

		expect(writeLockSql).toBe(destroyLockSql);
	});
});

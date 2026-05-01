/**
 * Unit tests for PostgresDialect advisory-lock SQL composition.
 *
 * Invariant: writers must acquire `pg_advisory_xact_lock`, read-only paths
 * must NOT (so cross-replica reads don't serialize against unrelated writers).
 *
 * - `setSandboxContext` (read-only) → only SET LOCAL app.sandbox_id.
 * - `setSandboxContextWithLock` (writer) → SET LOCAL + advisory-lock.
 * - `deleteSandbox` → advisory-lock then DELETE.
 *
 * Uses a fake transaction handle that records each tagged-template call so we can
 * verify the exact SQL composition without hitting a real database.
 */

import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import { PostgresDialect } from "../postgres.js";

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

function makeRejectingTx(error: Error & { code?: string }): postgres.TransactionSql {
	const fn = (): Promise<never> => Promise.reject(error);
	return fn as unknown as postgres.TransactionSql;
}

describe("PostgresDialect.setSandboxContext — read-only, no advisory lock", () => {
	it("issues only SET LOCAL app.sandbox_id and does NOT acquire the advisory lock", async () => {
		const dialect = new PostgresDialect("postgres://stub");
		const { tx, calls } = makeFakeTx();
		const sandboxId = "sandbox-abc-123";

		await dialect.setSandboxContext(tx, sandboxId);

		expect(calls).toHaveLength(1);
		expect(calls[0]!.sql).toContain("set_config");
		expect(calls[0]!.sql).toContain("app.sandbox_id");
		expect(calls[0]!.values).toEqual([sandboxId]);
		expect(calls[0]!.sql).not.toContain("pg_advisory_xact_lock");
	});

	it("binds the sandboxId as a parameter (no string interpolation)", async () => {
		const dialect = new PostgresDialect("postgres://stub");
		const { tx, calls } = makeFakeTx();
		const sandboxId = "sandbox'; DROP TABLE sandboxes; --";

		await dialect.setSandboxContext(tx, sandboxId);

		expect(calls[0]!.sql).not.toContain(sandboxId);
		expect(calls[0]!.values).toEqual([sandboxId]);
	});
});

describe("PostgresDialect.setSandboxContextWithLock — writer path", () => {
	it("issues set_config then pg_advisory_xact_lock(hashtextextended) in that order", async () => {
		const dialect = new PostgresDialect("postgres://stub");
		const { tx, calls } = makeFakeTx();
		const sandboxId = "sandbox-abc-123";

		await dialect.setSandboxContextWithLock(tx, sandboxId);

		expect(calls).toHaveLength(2);

		expect(calls[0]!.sql).toContain("set_config");
		expect(calls[0]!.sql).toContain("app.sandbox_id");
		expect(calls[0]!.values).toEqual([sandboxId]);

		expect(calls[1]!.sql).toContain("pg_advisory_xact_lock");
		expect(calls[1]!.sql).toContain("hashtextextended");
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
		await dialect.setSandboxContextWithLock(writePath.tx, sandboxId);

		const destroyPath = makeFakeTx();
		await dialect.deleteSandbox(destroyPath.tx, sandboxId);

		const normalize = (sql: string): string => sql.replace(/\s+/g, " ").trim();
		const writeLockSql = normalize(writePath.calls[1]!.sql);
		const destroyLockSql = normalize(destroyPath.calls[0]!.sql);

		expect(writeLockSql).toBe(destroyLockSql);
	});
});

describe("PostgresDialect metadata helpers — SQL error translation", () => {
	it("sandboxExists translates raw SQL errors", async () => {
		const dialect = new PostgresDialect("postgres://stub");
		const tx = makeRejectingTx(Object.assign(new Error("duplicate key"), { code: "23505" }));

		await expect(dialect.sandboxExists(tx, "sandbox-meta")).rejects.toMatchObject({ code: "EEXIST" });
	});

	it("getSandboxMeta translates raw SQL errors", async () => {
		const dialect = new PostgresDialect("postgres://stub");
		const tx = makeRejectingTx(new Error("failed to connect: postgres://user:secret@db.example.com:5432/app"));

		await expect(dialect.getSandboxMeta(tx, "sandbox-meta")).rejects.toMatchObject({
			message: expect.stringContaining("[redacted]"),
		});
	});

	it("updateSandboxMeta preserves ENOENT when no row was updated", async () => {
		const dialect = new PostgresDialect("postgres://stub");
		const { tx } = makeFakeTx();

		await expect(
			dialect.updateSandboxMeta(tx, "sandbox-missing", { owner: null, name: null, python: false, javascript: false }),
		).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("updateSandboxMeta translates raw SQL errors", async () => {
		const dialect = new PostgresDialect("postgres://stub");
		const tx = makeRejectingTx(new Error("permission denied on /var/lib/postgresql/data/base"));

		await expect(
			dialect.updateSandboxMeta(tx, "sandbox-meta", { owner: null, name: null, python: false, javascript: false }),
		).rejects.toMatchObject({
			message: expect.stringContaining("[redacted]"),
		});
	});
});

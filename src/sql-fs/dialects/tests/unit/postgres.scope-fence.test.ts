import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import { PostgresDialect } from "../../postgres.js";

interface RecordedCall {
	readonly sql: string;
	readonly values: readonly unknown[];
}

function makeFakeTx(): { tx: postgres.TransactionSql; calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
	const fn = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
		calls.push({ sql: strings.join("?"), values });
		return Promise.resolve([]);
	};
	return { tx: fn as unknown as postgres.TransactionSql, calls };
}

describe("PostgresDialect.fenceSandboxWrite", () => {
	it("uses RLS context and compare-and-bump semantics, rejecting a stale epoch", async () => {
		const dialect = new PostgresDialect("postgres://stub");
		const { tx, calls } = makeFakeTx();

		await expect(dialect.fenceSandboxWrite(tx, "sandbox-fence", 7n)).rejects.toMatchObject({ code: "ESTALE" });
		expect(calls).toHaveLength(1);
		expect(calls[0]!.sql).toContain("set_config");
		expect(calls[0]!.sql).toContain("UPDATE sandboxes");
		expect(calls[0]!.sql).toContain("version = version + 1");
		expect(calls[0]!.sql).toContain("pg_advisory_xact_lock");
		expect(calls[0]!.values).toEqual(["sandbox-fence", "sandbox-fence", "sandbox-fence", "7"]);
	});
});

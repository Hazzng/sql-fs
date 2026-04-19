/**
 * Integration tests for PostgresDialect — connection and sandbox context.
 * US-004: connect, setSandboxContext, verify current_setting.
 *
 * Skipped when DATABASE_URL is not set so that CI without a DB still passes.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresDialect } from "../dialects/postgres.js";

describe.skipIf(!process.env.DATABASE_URL)("PostgresDialect — connection and sandbox context", () => {
	const dialect = new PostgresDialect(process.env.DATABASE_URL!);

	beforeAll(async () => {
		await dialect.connect();
	});

	afterAll(async () => {
		await dialect.disconnect();
	});

	it("sets sandbox context within a transaction and reads it back via current_setting", async () => {
		const sandboxId = `test-sandbox-${Date.now()}`;

		const result = await dialect.transaction(async (tx) => {
			await dialect.setSandboxContext(tx, sandboxId);
			const rows = await tx<{ sandbox_id: string }[]>`
				SELECT current_setting('app.sandbox_id') AS sandbox_id
			`;
			const first = rows[0];
			if (!first) throw new Error("expected one row from current_setting query");
			return first.sandbox_id;
		});

		expect(result).toBe(sandboxId);
	});

	it("sandbox context is transaction-local (SET LOCAL) and not visible outside the transaction", async () => {
		const sandboxId = `test-sandbox-local-${Date.now()}`;

		// Set context inside one transaction
		await dialect.transaction(async (tx) => {
			await dialect.setSandboxContext(tx, sandboxId);
		});

		// After transaction commits, a new transaction should NOT see that setting
		// (default_transaction_isolation does not inherit SET LOCAL values)
		const result = await dialect.transaction(async (tx) => {
			const rows = await tx<{ sandbox_id: string }[]>`
				SELECT current_setting('app.sandbox_id', true) AS sandbox_id
			`;
			const first = rows[0];
			if (!first) throw new Error("expected one row");
			return first.sandbox_id;
		});

		// current_setting with missing_ok=true returns '' when not set
		expect(result).not.toBe(sandboxId);
	});
});

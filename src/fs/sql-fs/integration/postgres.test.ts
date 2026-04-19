/**
 * Integration tests for PostgresDialect — connection, sandbox context,
 * createSandbox, and deleteSandbox.
 * US-004: connect, setSandboxContext, verify current_setting.
 * US-005: createSandbox, deleteSandbox.
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

describe.skipIf(!process.env.DATABASE_URL)("PostgresDialect — createSandbox and deleteSandbox", () => {
	const dialect = new PostgresDialect(process.env.DATABASE_URL!);

	beforeAll(async () => {
		await dialect.connect();
	});

	afterAll(async () => {
		await dialect.disconnect();
	});

	it("creates sandbox with root inode and 4 default directories", async () => {
		const sandboxId = `test-create-sandbox-${Date.now()}`;

		try {
			const { rootInodeId } = await dialect.transaction(async (tx) => {
				return dialect.createSandbox(tx, sandboxId);
			});

			// Verify sandbox row has correct root_inode
			const sandboxRows = await dialect.transaction(async (tx) => {
				return await tx<{ root_inode: string }[]>`
					SELECT root_inode FROM sandboxes WHERE id = ${sandboxId}
				`;
			});
			expect(sandboxRows).toHaveLength(1);
			expect(BigInt(sandboxRows[0]!.root_inode)).toBe(rootInodeId);

			// Verify 5 inodes exist: root + /home + /home/user + /tmp + /bin
			const inodeCountRows = await dialect.transaction(async (tx) => {
				return await tx<{ count: string }[]>`
					SELECT COUNT(*) AS count FROM inodes WHERE sandbox_id = ${sandboxId}
				`;
			});
			expect(Number(inodeCountRows[0]!.count)).toBe(5);

			// Verify 4 dirents exist: root→/home, root→/tmp, root→/bin, /home→/user
			const direntCountRows = await dialect.transaction(async (tx) => {
				return await tx<{ count: string }[]>`
					SELECT COUNT(*) AS count FROM dirents WHERE sandbox_id = ${sandboxId}
				`;
			});
			expect(Number(direntCountRows[0]!.count)).toBe(4);

			// Verify expected dirent names under root
			const rootDirents = await dialect.transaction(async (tx) => {
				return await tx<{ name: string }[]>`
					SELECT name FROM dirents
					WHERE parent_inode_id = ${String(rootInodeId)} AND sandbox_id = ${sandboxId}
					ORDER BY name
				`;
			});
			expect(rootDirents.map((r: { name: string }) => r.name)).toEqual(["bin", "home", "tmp"]);
		} finally {
			await dialect.transaction(async (tx) => {
				await dialect.deleteSandbox(tx, sandboxId);
			});
		}
	});

	it("deleteSandbox removes all inodes and dirents via CASCADE", async () => {
		const sandboxId = `test-delete-sandbox-${Date.now()}`;

		// Create sandbox
		await dialect.transaction(async (tx) => {
			await dialect.createSandbox(tx, sandboxId);
		});

		// Delete sandbox
		await dialect.transaction(async (tx) => {
			await dialect.deleteSandbox(tx, sandboxId);
		});

		// Verify sandbox row is gone
		const sandboxRows = await dialect.transaction(async (tx) => {
			return await tx<{ id: string }[]>`SELECT id FROM sandboxes WHERE id = ${sandboxId}`;
		});
		expect(sandboxRows).toHaveLength(0);

		// Verify no orphaned inodes
		const inodeRows = await dialect.transaction(async (tx) => {
			return await tx<{ count: string }[]>`
				SELECT COUNT(*) AS count FROM inodes WHERE sandbox_id = ${sandboxId}
			`;
		});
		expect(Number(inodeRows[0]!.count)).toBe(0);

		// Verify no orphaned dirents
		const direntRows = await dialect.transaction(async (tx) => {
			return await tx<{ count: string }[]>`
				SELECT COUNT(*) AS count FROM dirents WHERE sandbox_id = ${sandboxId}
			`;
		});
		expect(Number(direntRows[0]!.count)).toBe(0);
	});
});

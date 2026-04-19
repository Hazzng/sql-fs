/**
 * Integration tests for PostgresDialect — connection, sandbox context,
 * createSandbox, deleteSandbox, inode CRUD, and nlink operations.
 * US-004: connect, setSandboxContext, verify current_setting.
 * US-005: createSandbox, deleteSandbox.
 * US-006: createInode, getInode, updateInode, deleteInode.
 * US-007: incrementNlink, decrementNlink.
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

describe.skipIf(!process.env.DATABASE_URL)("PostgresDialect — inode CRUD", () => {
	const dialect = new PostgresDialect(process.env.DATABASE_URL!);
	let sandboxId: string;

	beforeAll(async () => {
		await dialect.connect();
		sandboxId = `test-inode-crud-${Date.now()}`;
		await dialect.transaction(async (tx) => {
			await dialect.createSandbox(tx, sandboxId);
		});
	});

	afterAll(async () => {
		await dialect.transaction(async (tx) => {
			await dialect.deleteSandbox(tx, sandboxId);
		});
		await dialect.disconnect();
	});

	it("creates a file inode with content_sha256 and retrieves all fields via getInode", async () => {
		const sha256 = new Uint8Array(32).fill(1);
		const inodeId = await dialect.transaction(async (tx) => {
			return await dialect.createInode(tx, {
				sandboxId,
				kind: 1,
				mode: 0o644,
				size: 42,
				contentSha256: sha256,
				symlinkTarget: null,
			});
		});

		const inode = await dialect.transaction(async (tx) => {
			return await dialect.getInode(tx, inodeId);
		});

		expect(inode).not.toBeNull();
		expect(inode!.id).toBe(inodeId);
		expect(inode!.sandboxId).toBe(sandboxId);
		expect(inode!.kind).toBe(1);
		expect(inode!.mode).toBe(0o644);
		expect(inode!.size).toBe(42);
		expect(inode!.nlink).toBe(1);
		expect(inode!.contentSha256).toEqual(sha256);
		expect(inode!.symlinkTarget).toBeNull();
	});

	it("creates a directory inode with kind=2", async () => {
		const inodeId = await dialect.transaction(async (tx) => {
			return await dialect.createInode(tx, {
				sandboxId,
				kind: 2,
				mode: 0o755,
				size: 0,
			});
		});

		const inode = await dialect.transaction(async (tx) => {
			return await dialect.getInode(tx, inodeId);
		});

		expect(inode).not.toBeNull();
		expect(inode!.kind).toBe(2);
		expect(inode!.mode).toBe(0o755);
	});

	it("updates mode and mtime, verifies changes persist via getInode", async () => {
		const inodeId = await dialect.transaction(async (tx) => {
			return await dialect.createInode(tx, {
				sandboxId,
				kind: 1,
				mode: 0o644,
				size: 0,
			});
		});

		const newMtime = new Date("2025-06-15T12:00:00.000Z");
		await dialect.transaction(async (tx) => {
			await dialect.updateInode(tx, inodeId, { mode: 0o600, mtime: newMtime });
		});

		const inode = await dialect.transaction(async (tx) => {
			return await dialect.getInode(tx, inodeId);
		});

		expect(inode!.mode).toBe(0o600);
		expect(inode!.mtime.toISOString()).toBe(newMtime.toISOString());
	});

	it("deletes an inode and getInode returns null", async () => {
		const inodeId = await dialect.transaction(async (tx) => {
			return await dialect.createInode(tx, {
				sandboxId,
				kind: 1,
				mode: 0o644,
				size: 0,
			});
		});

		await dialect.transaction(async (tx) => {
			await dialect.deleteInode(tx, inodeId);
		});

		const inode = await dialect.transaction(async (tx) => {
			return await dialect.getInode(tx, inodeId);
		});

		expect(inode).toBeNull();
	});
});

describe.skipIf(!process.env.DATABASE_URL)("PostgresDialect — incrementNlink and decrementNlink", () => {
	const dialect = new PostgresDialect(process.env.DATABASE_URL!);
	let sandboxId: string;

	beforeAll(async () => {
		await dialect.connect();
		sandboxId = `test-nlink-${Date.now()}`;
		await dialect.transaction(async (tx) => {
			await dialect.createSandbox(tx, sandboxId);
		});
	});

	afterAll(async () => {
		await dialect.transaction(async (tx) => {
			await dialect.deleteSandbox(tx, sandboxId);
		});
		await dialect.disconnect();
	});

	it("incrementNlink increases nlink from 1 to 2", async () => {
		const inodeId = await dialect.transaction(async (tx) => {
			return await dialect.createInode(tx, { sandboxId, kind: 1, mode: 0o644, size: 0 });
		});

		await dialect.transaction(async (tx) => {
			await dialect.incrementNlink(tx, inodeId);
		});

		const inode = await dialect.transaction(async (tx) => {
			return await dialect.getInode(tx, inodeId);
		});

		expect(inode!.nlink).toBe(2);
	});

	it("decrementNlink from 2 to 1 returns 1", async () => {
		const inodeId = await dialect.transaction(async (tx) => {
			return await dialect.createInode(tx, { sandboxId, kind: 1, mode: 0o644, size: 0 });
		});

		// Increment to nlink=2 first
		await dialect.transaction(async (tx) => {
			await dialect.incrementNlink(tx, inodeId);
		});

		const newNlink = await dialect.transaction(async (tx) => {
			return await dialect.decrementNlink(tx, inodeId);
		});

		expect(newNlink).toBe(1);
	});

	it("decrementNlink from 1 to 0 returns 0", async () => {
		const inodeId = await dialect.transaction(async (tx) => {
			return await dialect.createInode(tx, { sandboxId, kind: 1, mode: 0o644, size: 0 });
		});

		const newNlink = await dialect.transaction(async (tx) => {
			return await dialect.decrementNlink(tx, inodeId);
		});

		expect(newNlink).toBe(0);
	});
});

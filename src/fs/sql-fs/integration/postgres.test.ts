/**
 * Integration tests for PostgresDialect — connection, sandbox context,
 * createSandbox, deleteSandbox, inode CRUD, nlink operations, and dirent insert/upsert/delete/move/list.
 * US-004: connect, setSandboxContext, verify current_setting.
 * US-005: createSandbox, deleteSandbox.
 * US-006: createInode, getInode, updateInode, deleteInode.
 * US-007: incrementNlink, decrementNlink.
 * US-008: insertDirent.
 * US-009: upsertDirent.
 * US-010: deleteDirent.
 * US-011: listDirents.
 * US-012: moveDirent.
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

describe.skipIf(!process.env.DATABASE_URL)("PostgresDialect — insertDirent", () => {
	const dialect = new PostgresDialect(process.env.DATABASE_URL!);
	let sandboxId: string;
	let rootInodeId: bigint;

	beforeAll(async () => {
		await dialect.connect();
		sandboxId = `test-insert-dirent-${Date.now()}`;
		const result = await dialect.transaction(async (tx) => {
			return await dialect.createSandbox(tx, sandboxId);
		});
		rootInodeId = result.rootInodeId;
	});

	afterAll(async () => {
		await dialect.transaction(async (tx) => {
			await dialect.deleteSandbox(tx, sandboxId);
		});
		await dialect.disconnect();
	});

	it("inserts a dirent and it appears in dirents table", async () => {
		const name = `file-${Date.now()}.txt`;
		const inodeId = await dialect.transaction(async (tx) => {
			return await dialect.createInode(tx, { sandboxId, kind: 1, mode: 0o644, size: 0 });
		});

		await dialect.transaction(async (tx) => {
			await dialect.insertDirent(tx, rootInodeId, name, inodeId);
		});

		// Verify via raw SQL since listDirents is not implemented yet
		const rows = await dialect.transaction(async (tx) => {
			return await tx<{ inode_id: string }[]>`
				SELECT inode_id FROM dirents
				WHERE parent_inode_id = ${String(rootInodeId)} AND name = ${name} AND sandbox_id = ${sandboxId}
			`;
		});
		expect(rows).toHaveLength(1);
		expect(BigInt(rows[0]!.inode_id)).toBe(inodeId);
	});

	it("throws on duplicate (parentId, name) — PK violation maps to EEXIST", async () => {
		const name = `dup-${Date.now()}.txt`;
		const inodeId = await dialect.transaction(async (tx) => {
			return await dialect.createInode(tx, { sandboxId, kind: 1, mode: 0o644, size: 0 });
		});

		// First insert succeeds
		await dialect.transaction(async (tx) => {
			await dialect.insertDirent(tx, rootInodeId, name, inodeId);
		});

		// Second insert on same (parentId, name) must throw
		await expect(
			dialect.transaction(async (tx) => {
				await dialect.insertDirent(tx, rootInodeId, name, inodeId);
			}),
		).rejects.toThrow();
	});
});

describe.skipIf(!process.env.DATABASE_URL)("PostgresDialect — upsertDirent", () => {
	const dialect = new PostgresDialect(process.env.DATABASE_URL!);
	let sandboxId: string;
	let rootInodeId: bigint;

	beforeAll(async () => {
		await dialect.connect();
		sandboxId = `test-upsert-dirent-${Date.now()}`;
		const result = await dialect.transaction(async (tx) => {
			return await dialect.createSandbox(tx, sandboxId);
		});
		rootInodeId = result.rootInodeId;
	});

	afterAll(async () => {
		await dialect.transaction(async (tx) => {
			await dialect.deleteSandbox(tx, sandboxId);
		});
		await dialect.disconnect();
	});

	it("upserts a new entry and returns null (no previous entry)", async () => {
		const name = `new-file-${Date.now()}.txt`;
		const inodeId = await dialect.transaction(async (tx) => {
			return await dialect.createInode(tx, { sandboxId, kind: 1, mode: 0o644, size: 0 });
		});

		const oldInodeId = await dialect.transaction(async (tx) => {
			return await dialect.upsertDirent(tx, rootInodeId, name, inodeId);
		});

		expect(oldInodeId).toBeNull();

		// Verify the dirent was inserted
		const rows = await dialect.transaction(async (tx) => {
			return await tx<{ inode_id: string }[]>`
				SELECT inode_id FROM dirents
				WHERE parent_inode_id = ${String(rootInodeId)} AND name = ${name} AND sandbox_id = ${sandboxId}
			`;
		});
		expect(rows).toHaveLength(1);
		expect(BigInt(rows[0]!.inode_id)).toBe(inodeId);
	});

	it("upserts over an existing entry and returns the old inodeId", async () => {
		const name = `replace-file-${Date.now()}.txt`;

		const oldInodeId = await dialect.transaction(async (tx) => {
			return await dialect.createInode(tx, { sandboxId, kind: 1, mode: 0o644, size: 0 });
		});
		const newInodeId = await dialect.transaction(async (tx) => {
			return await dialect.createInode(tx, { sandboxId, kind: 1, mode: 0o644, size: 10 });
		});

		// First upsert: new entry
		await dialect.transaction(async (tx) => {
			await dialect.upsertDirent(tx, rootInodeId, name, oldInodeId);
		});

		// Second upsert: replace with newInodeId, should return oldInodeId
		const returned = await dialect.transaction(async (tx) => {
			return await dialect.upsertDirent(tx, rootInodeId, name, newInodeId);
		});

		expect(returned).toBe(oldInodeId);

		// Verify the dirent now points to newInodeId
		const rows = await dialect.transaction(async (tx) => {
			return await tx<{ inode_id: string }[]>`
				SELECT inode_id FROM dirents
				WHERE parent_inode_id = ${String(rootInodeId)} AND name = ${name} AND sandbox_id = ${sandboxId}
			`;
		});
		expect(rows).toHaveLength(1);
		expect(BigInt(rows[0]!.inode_id)).toBe(newInodeId);
	});
});

describe.skipIf(!process.env.DATABASE_URL)("PostgresDialect — deleteDirent", () => {
	const dialect = new PostgresDialect(process.env.DATABASE_URL!);
	let sandboxId: string;
	let rootInodeId: bigint;

	beforeAll(async () => {
		await dialect.connect();
		sandboxId = `test-delete-dirent-${Date.now()}`;
		const result = await dialect.transaction(async (tx) => {
			return await dialect.createSandbox(tx, sandboxId);
		});
		rootInodeId = result.rootInodeId;
	});

	afterAll(async () => {
		await dialect.transaction(async (tx) => {
			await dialect.deleteSandbox(tx, sandboxId);
		});
		await dialect.disconnect();
	});

	it("inserts then deletes a dirent, verifying it is removed", async () => {
		const name = `delete-me-${Date.now()}.txt`;
		const inodeId = await dialect.transaction(async (tx) => {
			return await dialect.createInode(tx, { sandboxId, kind: 1, mode: 0o644, size: 0 });
		});

		await dialect.transaction(async (tx) => {
			await dialect.insertDirent(tx, rootInodeId, name, inodeId);
		});

		const removedInodeId = await dialect.transaction(async (tx) => {
			return await dialect.deleteDirent(tx, rootInodeId, name);
		});

		expect(removedInodeId).toBe(inodeId);

		// Verify dirent is gone
		const rows = await dialect.transaction(async (tx) => {
			return await tx<{ inode_id: string }[]>`
				SELECT inode_id FROM dirents
				WHERE parent_inode_id = ${String(rootInodeId)} AND name = ${name} AND sandbox_id = ${sandboxId}
			`;
		});
		expect(rows).toHaveLength(0);
	});

	it("throws ENOENT when deleting a non-existent dirent", async () => {
		const name = `does-not-exist-${Date.now()}.txt`;

		await expect(
			dialect.transaction(async (tx) => {
				return await dialect.deleteDirent(tx, rootInodeId, name);
			}),
		).rejects.toMatchObject({ code: "ENOENT" });
	});
});

describe.skipIf(!process.env.DATABASE_URL)("PostgresDialect — listDirents", () => {
	const dialect = new PostgresDialect(process.env.DATABASE_URL!);
	let sandboxId: string;
	let rootInodeId: bigint;

	beforeAll(async () => {
		await dialect.connect();
		sandboxId = `test-list-dirents-${Date.now()}`;
		const result = await dialect.transaction(async (tx) => {
			return await dialect.createSandbox(tx, sandboxId);
		});
		rootInodeId = result.rootInodeId;
	});

	afterAll(async () => {
		await dialect.transaction(async (tx) => {
			await dialect.deleteSandbox(tx, sandboxId);
		});
		await dialect.disconnect();
	});

	it("returns all children with correct inodeIds ordered by name", async () => {
		// Create a sub-directory to use as parent (isolate from root's default dirs)
		const parentId = await dialect.transaction(async (tx) => {
			return await dialect.createInode(tx, { sandboxId, kind: 2, mode: 0o755, size: 0 });
		});
		await dialect.transaction(async (tx) => {
			await dialect.insertDirent(tx, rootInodeId, `parent-${Date.now()}`, parentId);
		});

		// Create 3 children: a file, a dir, and a symlink
		const fileId = await dialect.transaction(async (tx) => {
			return await dialect.createInode(tx, { sandboxId, kind: 1, mode: 0o644, size: 0 });
		});
		const dirId = await dialect.transaction(async (tx) => {
			return await dialect.createInode(tx, { sandboxId, kind: 2, mode: 0o755, size: 0 });
		});
		const symlinkId = await dialect.transaction(async (tx) => {
			return await dialect.createInode(tx, { sandboxId, kind: 3, mode: 0o777, size: 0, symlinkTarget: "/tmp" });
		});

		await dialect.transaction(async (tx) => {
			await dialect.insertDirent(tx, parentId, "aaa-file.txt", fileId);
			await dialect.insertDirent(tx, parentId, "bbb-dir", dirId);
			await dialect.insertDirent(tx, parentId, "ccc-link", symlinkId);
		});

		const dirents = await dialect.transaction(async (tx) => {
			return await dialect.listDirents(tx, parentId);
		});

		expect(dirents).toHaveLength(3);
		expect(dirents[0]).toEqual({ parentInodeId: parentId, name: "aaa-file.txt", inodeId: fileId });
		expect(dirents[1]).toEqual({ parentInodeId: parentId, name: "bbb-dir", inodeId: dirId });
		expect(dirents[2]).toEqual({ parentInodeId: parentId, name: "ccc-link", inodeId: symlinkId });

		// Verify kinds via getInode
		const fileInode = await dialect.transaction(async (tx) => dialect.getInode(tx, fileId));
		const dirInode = await dialect.transaction(async (tx) => dialect.getInode(tx, dirId));
		const symlinkInode = await dialect.transaction(async (tx) => dialect.getInode(tx, symlinkId));
		expect(fileInode!.kind).toBe(1);
		expect(dirInode!.kind).toBe(2);
		expect(symlinkInode!.kind).toBe(3);
	});

	it("returns empty array for an empty directory", async () => {
		const emptyDirId = await dialect.transaction(async (tx) => {
			return await dialect.createInode(tx, { sandboxId, kind: 2, mode: 0o755, size: 0 });
		});

		const dirents = await dialect.transaction(async (tx) => {
			return await dialect.listDirents(tx, emptyDirId);
		});

		expect(dirents).toEqual([]);
	});
});

describe.skipIf(!process.env.DATABASE_URL)("PostgresDialect — moveDirent", () => {
	const dialect = new PostgresDialect(process.env.DATABASE_URL!);
	let sandboxId: string;
	let rootInodeId: bigint;

	beforeAll(async () => {
		await dialect.connect();
		sandboxId = `test-move-dirent-${Date.now()}`;
		const result = await dialect.transaction(async (tx) => {
			return await dialect.createSandbox(tx, sandboxId);
		});
		rootInodeId = result.rootInodeId;
	});

	afterAll(async () => {
		await dialect.transaction(async (tx) => {
			await dialect.deleteSandbox(tx, sandboxId);
		});
		await dialect.disconnect();
	});

	it("renames a file within the same directory", async () => {
		const inodeId = await dialect.transaction(async (tx) => {
			return await dialect.createInode(tx, { sandboxId, kind: 1, mode: 0o644, size: 0 });
		});
		await dialect.transaction(async (tx) => {
			await dialect.insertDirent(tx, rootInodeId, "old-name.txt", inodeId);
		});

		await dialect.transaction(async (tx) => {
			await dialect.moveDirent(tx, rootInodeId, "old-name.txt", rootInodeId, "new-name.txt");
		});

		// old name should be gone, new name should resolve to same inodeId
		const dirents = await dialect.transaction(async (tx) => {
			return await dialect.listDirents(tx, rootInodeId);
		});
		const names = dirents.map((d) => d.name);
		expect(names).not.toContain("old-name.txt");
		const moved = dirents.find((d) => d.name === "new-name.txt");
		expect(moved).toBeDefined();
		expect(moved!.inodeId).toBe(inodeId);
	});

	it("moves a file to a different directory", async () => {
		// Create a sub-directory to move into
		const destDirId = await dialect.transaction(async (tx) => {
			return await dialect.createInode(tx, { sandboxId, kind: 2, mode: 0o755, size: 0 });
		});
		await dialect.transaction(async (tx) => {
			await dialect.insertDirent(tx, rootInodeId, "dest-dir", destDirId);
		});

		const inodeId = await dialect.transaction(async (tx) => {
			return await dialect.createInode(tx, { sandboxId, kind: 1, mode: 0o644, size: 0 });
		});
		await dialect.transaction(async (tx) => {
			await dialect.insertDirent(tx, rootInodeId, "move-me.txt", inodeId);
		});

		await dialect.transaction(async (tx) => {
			await dialect.moveDirent(tx, rootInodeId, "move-me.txt", destDirId, "moved.txt");
		});

		// old location should be gone
		const rootDirents = await dialect.transaction(async (tx) => {
			return await dialect.listDirents(tx, rootInodeId);
		});
		expect(rootDirents.map((d) => d.name)).not.toContain("move-me.txt");

		// new location should exist and point to same inode
		const destDirents = await dialect.transaction(async (tx) => {
			return await dialect.listDirents(tx, destDirId);
		});
		const moved = destDirents.find((d) => d.name === "moved.txt");
		expect(moved).toBeDefined();
		expect(moved!.inodeId).toBe(inodeId);
	});

	it("moves over an existing file, removing the old destination dirent", async () => {
		const srcInodeId = await dialect.transaction(async (tx) => {
			return await dialect.createInode(tx, { sandboxId, kind: 1, mode: 0o644, size: 10 });
		});
		const dstInodeId = await dialect.transaction(async (tx) => {
			return await dialect.createInode(tx, { sandboxId, kind: 1, mode: 0o644, size: 20 });
		});

		await dialect.transaction(async (tx) => {
			await dialect.insertDirent(tx, rootInodeId, "src-file.txt", srcInodeId);
			await dialect.insertDirent(tx, rootInodeId, "dst-file.txt", dstInodeId);
		});

		await dialect.transaction(async (tx) => {
			await dialect.moveDirent(tx, rootInodeId, "src-file.txt", rootInodeId, "dst-file.txt");
		});

		// There should be exactly one dirent named dst-file.txt, pointing to srcInodeId
		const dirents = await dialect.transaction(async (tx) => {
			return await dialect.listDirents(tx, rootInodeId);
		});
		const dstDirents = dirents.filter((d) => d.name === "dst-file.txt");
		expect(dstDirents).toHaveLength(1);
		expect(dstDirents[0]!.inodeId).toBe(srcInodeId);

		// src-file.txt should be gone
		expect(dirents.map((d) => d.name)).not.toContain("src-file.txt");
	});

	it("throws ENOENT when moving a non-existent source dirent", async () => {
		await expect(
			dialect.transaction(async (tx) => {
				await dialect.moveDirent(tx, rootInodeId, "does-not-exist.txt", rootInodeId, "target.txt");
			}),
		).rejects.toMatchObject({ code: "ENOENT" });
	});
});

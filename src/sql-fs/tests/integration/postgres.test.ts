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
 * US-013: upsertBlob, getBlob.
 * US-014: gcOrphanBlobs.
 * US-015: loadAllPaths.
 * US-016: loadSubtreeInodes.
 * US-017: bulkIngest.
 * US-018: resolvePath (fs_resolve stored procedure).
 *
 * Skipped when DATABASE_URL is not set so that CI without a DB still passes.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresDialect } from "../../dialects/postgres.js";
import type { BulkIngestFile } from "../../types.js";

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
		expect(new Uint8Array(inode!.contentSha256 as Buffer)).toEqual(sha256);
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

describe.skipIf(!process.env.DATABASE_URL)("PostgresDialect — upsertBlob and getBlob", () => {
	const dialect = new PostgresDialect(process.env.DATABASE_URL!);
	// Track inserted sha256s so we can clean up in afterAll
	const insertedSha256s: Uint8Array[] = [];

	beforeAll(async () => {
		await dialect.connect();
	});

	afterAll(async () => {
		for (const sha256 of insertedSha256s) {
			await dialect.transaction(async (tx) => {
				await tx`DELETE FROM blobs WHERE sha256 = ${sha256}`;
			});
		}
		await dialect.disconnect();
	});

	it("inserts a blob and retrieves it by sha256", async () => {
		const sha256 = new Uint8Array(32).fill(0x01);
		const data = new TextEncoder().encode("hello world");
		insertedSha256s.push(sha256);

		await dialect.transaction(async (tx) => {
			await dialect.upsertBlob(tx, sha256, data);
		});

		const result = await dialect.transaction(async (tx) => {
			return await dialect.getBlob(tx, sha256);
		});

		expect(result).not.toBeNull();
		expect(result).toEqual(data);
	});

	it("inserts the same sha256 twice and only one row exists (dedup)", async () => {
		const sha256 = new Uint8Array(32).fill(0x02);
		const data = new TextEncoder().encode("deduplicated content");
		insertedSha256s.push(sha256);

		await dialect.transaction(async (tx) => {
			await dialect.upsertBlob(tx, sha256, data);
		});
		// Second upsert with same sha256 — ON CONFLICT DO NOTHING, no error
		await dialect.transaction(async (tx) => {
			await dialect.upsertBlob(tx, sha256, data);
		});

		const rows = await dialect.transaction(async (tx) => {
			return await tx<{ count: string }[]>`SELECT COUNT(*) AS count FROM blobs WHERE sha256 = ${sha256}`;
		});
		expect(Number(rows[0]!.count)).toBe(1);
	});

	it("returns null for a non-existent sha256", async () => {
		const sha256 = new Uint8Array(32).fill(0xff);

		const result = await dialect.transaction(async (tx) => {
			return await dialect.getBlob(tx, sha256);
		});

		expect(result).toBeNull();
	});
});

describe.skipIf(!process.env.DATABASE_URL)("PostgresDialect — gcOrphanBlobs", () => {
	const dialect = new PostgresDialect(process.env.DATABASE_URL!);
	let sandboxId: string;

	beforeAll(async () => {
		await dialect.connect();
		sandboxId = `test-gc-blobs-${Date.now()}`;
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

	it("blob referenced by an inode survives GC", async () => {
		const sha256 = new Uint8Array(32).fill(0xaa);
		const data = new TextEncoder().encode("referenced content");

		await dialect.transaction(async (tx) => {
			await dialect.upsertBlob(tx, sha256, data);
		});

		// Create an inode that references this blob
		await dialect.transaction(async (tx) => {
			await dialect.createInode(tx, { sandboxId, kind: 1, mode: 0o644, size: data.length, contentSha256: sha256 });
		});

		// Run GC
		await dialect.transaction(async (tx) => {
			await dialect.gcOrphanBlobs(tx, 0);
		});

		// Blob should still exist (referenced by the inode)
		const result = await dialect.transaction(async (tx) => {
			return await dialect.getBlob(tx, sha256);
		});
		expect(result).not.toBeNull();
		expect(result).toEqual(data);
	});

	it("orphan blob (inode deleted) is removed by GC", async () => {
		const sha256 = new Uint8Array(32).fill(0xbb);
		const data = new TextEncoder().encode("orphan content");

		await dialect.transaction(async (tx) => {
			await dialect.upsertBlob(tx, sha256, data);
		});

		// Create and then delete an inode that references this blob
		const inodeId = await dialect.transaction(async (tx) => {
			return await dialect.createInode(tx, {
				sandboxId,
				kind: 1,
				mode: 0o644,
				size: data.length,
				contentSha256: sha256,
			});
		});
		await dialect.transaction(async (tx) => {
			await dialect.deleteInode(tx, inodeId);
		});

		// Run GC — should delete the orphan blob
		const deleted = await dialect.transaction(async (tx) => {
			return await dialect.gcOrphanBlobs(tx, 0);
		});

		expect(deleted.length).toBeGreaterThanOrEqual(1);

		// Blob should be gone
		const result = await dialect.transaction(async (tx) => {
			return await dialect.getBlob(tx, sha256);
		});
		expect(result).toBeNull();
	});

	it("blob referenced by two inodes survives GC after one inode is deleted", async () => {
		const sha256 = new Uint8Array(32).fill(0xcc);
		const data = new TextEncoder().encode("shared content");

		await dialect.transaction(async (tx) => {
			await dialect.upsertBlob(tx, sha256, data);
		});

		// Two inodes reference the same blob
		const inodeId1 = await dialect.transaction(async (tx) => {
			return await dialect.createInode(tx, {
				sandboxId,
				kind: 1,
				mode: 0o644,
				size: data.length,
				contentSha256: sha256,
			});
		});
		const inodeId2 = await dialect.transaction(async (tx) => {
			return await dialect.createInode(tx, {
				sandboxId,
				kind: 1,
				mode: 0o644,
				size: data.length,
				contentSha256: sha256,
			});
		});

		// Delete one inode
		await dialect.transaction(async (tx) => {
			await dialect.deleteInode(tx, inodeId1);
		});

		// Run GC — blob should survive (still referenced by inodeId2)
		await dialect.transaction(async (tx) => {
			await dialect.gcOrphanBlobs(tx, 0);
		});

		const result = await dialect.transaction(async (tx) => {
			return await dialect.getBlob(tx, sha256);
		});
		expect(result).not.toBeNull();
		expect(result).toEqual(data);

		// Cleanup: delete second inode (blob becomes orphan, will be cleaned by sandbox delete cascade for inodes)
		await dialect.transaction(async (tx) => {
			await dialect.deleteInode(tx, inodeId2);
		});
	});

	it("re-referencing an existing blob bumps last_referenced_at", async () => {
		const sha256 = new Uint8Array(32).fill(0xdd);
		const data = new TextEncoder().encode("rereferenced content");

		// First upsert: inserts the row with last_referenced_at = now().
		await dialect.transaction(async (tx) => {
			await dialect.upsertBlob(tx, sha256, data);
		});

		const firstRows = await dialect.transaction(async (tx) => {
			return await tx<{ last_referenced_at: Date }[]>`
				SELECT last_referenced_at FROM blobs WHERE sha256 = ${sha256}
			`;
		});
		const first = firstRows[0]!.last_referenced_at;

		// now() is the transaction start time; the two upserts run in separate
		// transactions, so this sleep guarantees the second is strictly later.
		await new Promise((r) => setTimeout(r, 5));

		// Second upsert: ON CONFLICT DO UPDATE bumps last_referenced_at to now().
		await dialect.transaction(async (tx) => {
			await dialect.upsertBlob(tx, sha256, data);
		});

		const secondRows = await dialect.transaction(async (tx) => {
			return await tx<{ last_referenced_at: Date }[]>`
				SELECT last_referenced_at FROM blobs WHERE sha256 = ${sha256}
			`;
		});
		const second = secondRows[0]!.last_referenced_at;

		expect(second.getTime()).toBeGreaterThan(first.getTime());

		// Cleanup: blob is unreferenced; remove it directly.
		await dialect.transaction(async (tx) => {
			await tx`DELETE FROM blobs WHERE sha256 = ${sha256}`;
		});
	});

	// Compares a sha256 against the Uint8Array[] returned by gcOrphanBlobs.
	const includesSha = (deleted: Uint8Array[], sha: Uint8Array): boolean => {
		const target = Buffer.from(sha).toString("hex");
		return deleted.some((d) => Buffer.from(d).toString("hex") === target);
	};

	it("orphan inside the grace window survives, then is collected once grace is zero", async () => {
		const sha256 = new Uint8Array(32).fill(0x11);
		const data = new TextEncoder().encode("grace window content");

		// Upsert blob (last_referenced_at = now()), reference it, then orphan it.
		await dialect.transaction(async (tx) => {
			await dialect.upsertBlob(tx, sha256, data);
		});
		const inodeId = await dialect.transaction(async (tx) => {
			return await dialect.createInode(tx, {
				sandboxId,
				kind: 1,
				mode: 0o644,
				size: data.length,
				contentSha256: sha256,
			});
		});
		await dialect.transaction(async (tx) => {
			await dialect.deleteInode(tx, inodeId);
		});

		// 1h grace window: the orphan is fresh, so it must survive.
		const survived = await dialect.transaction(async (tx) => {
			return await dialect.gcOrphanBlobs(tx, 3_600_000);
		});
		expect(includesSha(survived, sha256)).toBe(false);
		const stillThere = await dialect.transaction(async (tx) => {
			return await dialect.getBlob(tx, sha256);
		});
		expect(stillThere).toEqual(data);

		// Zero grace window: the orphan is now eligible and gets collected.
		const collected = await dialect.transaction(async (tx) => {
			return await dialect.gcOrphanBlobs(tx, 0);
		});
		expect(includesSha(collected, sha256)).toBe(true);
		const gone = await dialect.transaction(async (tx) => {
			return await dialect.getBlob(tx, sha256);
		});
		expect(gone).toBeNull();
	});

	it("orphan with NULL last_referenced_at is collected even under a long grace window", async () => {
		const sha256 = new Uint8Array(32).fill(0x22);
		const data = new TextEncoder().encode("legacy null content");

		// Insert directly with an explicit NULL last_referenced_at and no inode.
		await dialect.transaction(async (tx) => {
			await tx`
				INSERT INTO blobs (sha256, data, size, last_referenced_at)
				VALUES (${sha256}, ${data}, ${data.length}, NULL)
			`;
		});

		// Long grace window — NULL is treated as ancient, so it is still collected.
		const collected = await dialect.transaction(async (tx) => {
			return await dialect.gcOrphanBlobs(tx, 3_600_000);
		});
		expect(includesSha(collected, sha256)).toBe(true);

		const gone = await dialect.transaction(async (tx) => {
			return await dialect.getBlob(tx, sha256);
		});
		expect(gone).toBeNull();
	});

	it("blob referenced only by another sandbox survives no-context GC (RLS escape)", async () => {
		const sha256 = new Uint8Array(32).fill(0x33);
		const data = new TextEncoder().encode("cross sandbox content");
		const otherSandboxId = `${sandboxId}-other`;

		await dialect.transaction(async (tx) => {
			await dialect.createSandbox(tx, otherSandboxId);
		});

		try {
			await dialect.transaction(async (tx) => {
				await dialect.upsertBlob(tx, sha256, data);
			});
			// The referencing inode lives in the OTHER sandbox.
			await dialect.transaction(async (tx) => {
				await dialect.setSandboxContext(tx, otherSandboxId);
				await dialect.createInode(tx, {
					sandboxId: otherSandboxId,
					kind: 1,
					mode: 0o644,
					size: data.length,
					contentSha256: sha256,
				});
			});

			// GC runs with NO setSandboxContext — the RLS escape lets the
			// context-less tx see the other sandbox's inode, so the anti-join
			// keeps this blob alive.
			const deleted = await dialect.transaction(async (tx) => {
				return await dialect.gcOrphanBlobs(tx, 0);
			});
			expect(includesSha(deleted, sha256)).toBe(false);

			const survived = await dialect.transaction(async (tx) => {
				return await dialect.getBlob(tx, sha256);
			});
			expect(survived).toEqual(data);
		} finally {
			// deleteSandbox cascades the inode, but blobs are global (no sandbox_id),
			// so the now-orphan blob must be removed explicitly to avoid leaking.
			await dialect.transaction(async (tx) => {
				await dialect.deleteSandbox(tx, otherSandboxId);
				await tx`DELETE FROM blobs WHERE sha256 = ${sha256}`;
			});
		}
	});
});

describe.skipIf(!process.env.DATABASE_URL)("PostgresDialect — nlink=0 tombstone fix (rm/overwrite/GC)", () => {
	const dialect = new PostgresDialect(process.env.DATABASE_URL!);
	let sandboxId: string;
	let rootInodeId: bigint;

	beforeAll(async () => {
		await dialect.connect();
		sandboxId = `test-tombstone-${Date.now()}`;
		const res = await dialect.transaction(async (tx) => dialect.createSandbox(tx, sandboxId));
		rootInodeId = res.rootInodeId;
	});

	afterAll(async () => {
		await dialect.transaction(async (tx) => {
			await dialect.deleteSandbox(tx, sandboxId);
		});
		await dialect.disconnect();
	});

	const countInode = (id: bigint): Promise<number> =>
		dialect.transaction(async (tx) => {
			const rows = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM inodes WHERE id = ${String(id)}`;
			return rows[0]!.n;
		});

	it("rmComposite hard-deletes a single-linked inode (no nlink=0 tombstone left behind)", async () => {
		const sha = new Uint8Array(32).fill(0x51);
		const inodeId = await dialect.transaction(async (tx) =>
			dialect.createInode(tx, { sandboxId, kind: 1, mode: 0o644, size: 3, contentSha256: sha }),
		);
		await dialect.transaction(async (tx) => dialect.insertDirent(tx, rootInodeId, "single.txt", inodeId));

		await dialect.transaction(async (tx) => dialect.rmComposite(tx, sandboxId, rootInodeId, "single.txt"));

		// Regression: the inode ROW must be gone, not lingering at nlink=0.
		expect(await countInode(inodeId)).toBe(0);
	});

	it("rmComposite decrements a hardlinked inode instead of deleting it", async () => {
		const sha = new Uint8Array(32).fill(0x52);
		const inodeId = await dialect.transaction(async (tx) =>
			dialect.createInode(tx, { sandboxId, kind: 1, mode: 0o644, size: 3, contentSha256: sha }),
		);
		await dialect.transaction(async (tx) => {
			await dialect.insertDirent(tx, rootInodeId, "link1.txt", inodeId);
			await dialect.insertDirent(tx, rootInodeId, "link2.txt", inodeId);
			await dialect.incrementNlink(tx, inodeId); // two links → nlink = 2
		});

		await dialect.transaction(async (tx) => dialect.rmComposite(tx, sandboxId, rootInodeId, "link2.txt"));

		const inode = await dialect.transaction(async (tx) => dialect.getInode(tx, inodeId));
		expect(inode).not.toBeNull();
		expect(inode!.nlink).toBe(1); // survives with the remaining link

		// removing the last link now hard-deletes it
		await dialect.transaction(async (tx) => dialect.rmComposite(tx, sandboxId, rootInodeId, "link1.txt"));
		expect(await countInode(inodeId)).toBe(0);
	});

	it("writeFileComposite overwrite hard-deletes the replaced inode and frees its blob for GC", async () => {
		const shaA = new Uint8Array(32).fill(0x53);
		const shaB = new Uint8Array(32).fill(0x54);
		const dataA = new TextEncoder().encode("AAA");
		const dataB = new TextEncoder().encode("BBBB");

		// F6: the blob is now committed in its own short tx BEFORE the composite,
		// which no longer carries the blob_insert CTE — mirror the SqlFs write path.
		await dialect.commitBlob(shaA, dataA);
		const inodeA = await dialect.transaction(async (tx) =>
			dialect.writeFileComposite(tx, sandboxId, rootInodeId, "ow.txt", 0o644, dataA.length, shaA, dataA),
		);
		await dialect.commitBlob(shaB, dataB);
		const inodeB = await dialect.transaction(async (tx) =>
			dialect.writeFileComposite(tx, sandboxId, rootInodeId, "ow.txt", 0o644, dataB.length, shaB, dataB),
		);
		expect(inodeB).not.toBe(inodeA);
		// Regression: the replaced inode must be deleted, not left as an nlink=0 tombstone.
		expect(await countInode(inodeA)).toBe(0);

		// Old blob is now a true orphan → collected; the new blob survives.
		await dialect.transaction(async (tx) => dialect.gcOrphanBlobs(tx, 0));
		const blobA = await dialect.transaction(async (tx) => dialect.getBlob(tx, shaA));
		const blobB = await dialect.transaction(async (tx) => dialect.getBlob(tx, shaB));
		expect(blobA).toBeNull();
		expect(blobB).toEqual(dataB);

		// cleanup
		await dialect.transaction(async (tx) => dialect.rmComposite(tx, sandboxId, rootInodeId, "ow.txt"));
		await dialect.transaction(async (tx) => {
			await tx`DELETE FROM blobs WHERE sha256 = ${shaB}`;
		});
	});

	it("gcOrphanBlobs ignores an nlink=0 inode tombstone (legacy backlog) and collects its blob", async () => {
		const sha = new Uint8Array(32).fill(0x55);
		const data = new TextEncoder().encode("tomb");
		await dialect.transaction(async (tx) => dialect.upsertBlob(tx, sha, data));
		// Simulate a tombstone left by an older buggy build: nlink=0 but still references the blob.
		const inodeId = await dialect.transaction(async (tx) =>
			dialect.createInode(tx, { sandboxId, kind: 1, mode: 0o644, size: data.length, contentSha256: sha }),
		);
		await dialect.transaction(async (tx) => {
			await tx`UPDATE inodes SET nlink = 0 WHERE id = ${String(inodeId)}`;
		});

		await dialect.transaction(async (tx) => dialect.gcOrphanBlobs(tx, 0));

		const blob = await dialect.transaction(async (tx) => dialect.getBlob(tx, sha));
		expect(blob).toBeNull(); // collected despite the tombstone reference

		// cleanup the tombstone inode
		await dialect.transaction(async (tx) => {
			await tx`DELETE FROM inodes WHERE id = ${String(inodeId)}`;
		});
	});

	it("mvComposite over a single-linked destination hard-deletes the replaced inode (no tombstone)", async () => {
		const shaSrc = new Uint8Array(32).fill(0x56);
		const shaDst = new Uint8Array(32).fill(0x57);
		const dataSrc = new TextEncoder().encode("SRC");
		const dataDst = new TextEncoder().encode("DST");

		const srcInode = await dialect.transaction(async (tx) => {
			await dialect.upsertBlob(tx, shaSrc, dataSrc);
			const id = await dialect.createInode(tx, {
				sandboxId,
				kind: 1,
				mode: 0o644,
				size: dataSrc.length,
				contentSha256: shaSrc,
			});
			await dialect.insertDirent(tx, rootInodeId, "mvsrc.txt", id);
			return id;
		});
		const dstInode = await dialect.transaction(async (tx) => {
			await dialect.upsertBlob(tx, shaDst, dataDst);
			const id = await dialect.createInode(tx, {
				sandboxId,
				kind: 1,
				mode: 0o644,
				size: dataDst.length,
				contentSha256: shaDst,
			});
			await dialect.insertDirent(tx, rootInodeId, "mvdst.txt", id);
			return id;
		});

		// Move src onto the existing dst, overwriting it.
		await dialect.transaction(async (tx) =>
			dialect.mvComposite(tx, sandboxId, rootInodeId, "mvsrc.txt", rootInodeId, "mvdst.txt"),
		);

		// Regression: the overwritten destination inode must be deleted, not an nlink=0 tombstone.
		expect(await countInode(dstInode)).toBe(0);
		expect(await countInode(srcInode)).toBe(1); // src inode now lives at mvdst.txt

		// The dest's old blob is freed for GC; the moved src blob survives.
		await dialect.transaction(async (tx) => dialect.gcOrphanBlobs(tx, 0));
		expect(await dialect.transaction(async (tx) => dialect.getBlob(tx, shaDst))).toBeNull();
		expect(await dialect.transaction(async (tx) => dialect.getBlob(tx, shaSrc))).toEqual(dataSrc);

		// cleanup
		await dialect.transaction(async (tx) => dialect.rmComposite(tx, sandboxId, rootInodeId, "mvdst.txt"));
		await dialect.transaction(async (tx) => {
			await tx`DELETE FROM blobs WHERE sha256 = ${shaSrc}`;
		});
	});
});

describe.skipIf(!process.env.DATABASE_URL)("PostgresDialect — loadAllPaths", () => {
	const dialect = new PostgresDialect(process.env.DATABASE_URL!);
	let sandboxId: string;
	let rootInodeId: bigint;

	beforeAll(async () => {
		await dialect.connect();
		sandboxId = `test-load-all-paths-${Date.now()}`;
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

	it("loads all paths including root and nested files/dirs with correct metadata", async () => {
		// Add a nested structure: /home/user/file.txt and /tmp/dir/sub.txt
		const fileData = new TextEncoder().encode("hello");
		const sha256 = new Uint8Array(32).fill(0xde);

		await dialect.transaction(async (tx) => {
			await dialect.upsertBlob(tx, sha256, fileData);
		});

		// Get /home/user inode id by listing dirents under /home then /home/user
		const rootDirents = await dialect.transaction(async (tx) => {
			return await dialect.listDirents(tx, rootInodeId);
		});
		const homeEntry = rootDirents.find((d) => d.name === "home");
		if (!homeEntry) throw new Error("expected /home in sandbox root");

		const homeDirents = await dialect.transaction(async (tx) => {
			return await dialect.listDirents(tx, homeEntry.inodeId);
		});
		const userEntry = homeDirents.find((d) => d.name === "user");
		if (!userEntry) throw new Error("expected /home/user in sandbox");

		// Create /home/user/file.txt
		const fileInodeId = await dialect.transaction(async (tx) => {
			return await dialect.createInode(tx, {
				sandboxId,
				kind: 1,
				mode: 0o644,
				size: fileData.length,
				contentSha256: sha256,
			});
		});
		await dialect.transaction(async (tx) => {
			await dialect.insertDirent(tx, userEntry.inodeId, "file.txt", fileInodeId);
		});

		// Call loadAllPaths — must setSandboxContext first
		const entries = await dialect.transaction(async (tx) => {
			await dialect.setSandboxContext(tx, sandboxId);
			return await dialect.loadAllPaths(tx);
		});

		const paths = entries.map((e) => e.path).sort();

		// Default sandbox creates: /, /bin, /home, /home/user, /tmp — plus our /home/user/file.txt
		expect(paths).toContain("/");
		expect(paths).toContain("/bin");
		expect(paths).toContain("/home");
		expect(paths).toContain("/home/user");
		expect(paths).toContain("/tmp");
		expect(paths).toContain("/home/user/file.txt");

		// Verify root entry metadata
		const rootEntry = entries.find((e) => e.path === "/");
		expect(rootEntry).toBeDefined();
		expect(rootEntry!.inodeId).toBe(rootInodeId);
		expect(rootEntry!.kind).toBe(2);

		// Verify file entry metadata
		const fileEntry = entries.find((e) => e.path === "/home/user/file.txt");
		expect(fileEntry).toBeDefined();
		expect(fileEntry!.inodeId).toBe(fileInodeId);
		expect(fileEntry!.kind).toBe(1);
		expect(fileEntry!.mode).toBe(0o644);
		expect(fileEntry!.size).toBe(fileData.length);
		expect(new Uint8Array(fileEntry!.contentSha256 as Buffer)).toEqual(sha256);
	});
});

describe.skipIf(!process.env.DATABASE_URL)("PostgresDialect — loadSubtreeInodes", () => {
	const dialect = new PostgresDialect(process.env.DATABASE_URL!);
	let sandboxId: string;
	let rootInodeId: bigint;

	beforeAll(async () => {
		await dialect.connect();
		sandboxId = `test-subtree-${Date.now()}`;
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

	it("collects all descendant inode IDs including root for a 3-level-deep nested structure", async () => {
		// Build a 3-level subtree under a fresh directory (isolated from sandbox defaults)
		//   subtreeRoot
		//     child1
		//       grandchild1
		//       grandchild2
		//     child2
		//       grandchild3

		const subtreeRootId = await dialect.transaction(async (tx) => {
			return await dialect.createInode(tx, { sandboxId, kind: 2, mode: 0o755, size: 0 });
		});
		await dialect.transaction(async (tx) => {
			await dialect.insertDirent(tx, rootInodeId, "subtree-root", subtreeRootId);
		});

		const child1Id = await dialect.transaction(async (tx) => {
			return await dialect.createInode(tx, { sandboxId, kind: 2, mode: 0o755, size: 0 });
		});
		const child2Id = await dialect.transaction(async (tx) => {
			return await dialect.createInode(tx, { sandboxId, kind: 2, mode: 0o755, size: 0 });
		});

		await dialect.transaction(async (tx) => {
			await dialect.insertDirent(tx, subtreeRootId, "child1", child1Id);
			await dialect.insertDirent(tx, subtreeRootId, "child2", child2Id);
		});

		const grandchild1Id = await dialect.transaction(async (tx) => {
			return await dialect.createInode(tx, { sandboxId, kind: 1, mode: 0o644, size: 0 });
		});
		const grandchild2Id = await dialect.transaction(async (tx) => {
			return await dialect.createInode(tx, { sandboxId, kind: 1, mode: 0o644, size: 0 });
		});
		const grandchild3Id = await dialect.transaction(async (tx) => {
			return await dialect.createInode(tx, { sandboxId, kind: 1, mode: 0o644, size: 0 });
		});

		await dialect.transaction(async (tx) => {
			await dialect.insertDirent(tx, child1Id, "grandchild1.txt", grandchild1Id);
			await dialect.insertDirent(tx, child1Id, "grandchild2.txt", grandchild2Id);
			await dialect.insertDirent(tx, child2Id, "grandchild3.txt", grandchild3Id);
		});

		const inodeIds = await dialect.transaction(async (tx) => {
			return await dialect.loadSubtreeInodes(tx, subtreeRootId);
		});

		// All 6 inodes (root + 2 children + 3 grandchildren) must be present
		expect(inodeIds).toHaveLength(6);
		const idSet = new Set(inodeIds.map((id) => String(id)));
		expect(idSet.has(String(subtreeRootId))).toBe(true);
		expect(idSet.has(String(child1Id))).toBe(true);
		expect(idSet.has(String(child2Id))).toBe(true);
		expect(idSet.has(String(grandchild1Id))).toBe(true);
		expect(idSet.has(String(grandchild2Id))).toBe(true);
		expect(idSet.has(String(grandchild3Id))).toBe(true);
	});
});

describe.skipIf(!process.env.DATABASE_URL)("PostgresDialect — bulkIngest", () => {
	const dialect = new PostgresDialect(process.env.DATABASE_URL!);
	let sandboxId: string;
	let rootInodeId: bigint;

	beforeAll(async () => {
		await dialect.connect();
		sandboxId = `test-bulk-ingest-${Date.now()}`;
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

	it("bulk ingests 50 files across 5 directories and all are accessible via listDirents", async () => {
		const dirs = ["dir1", "dir2", "dir3", "dir4", "dir5"];
		const files: BulkIngestFile[] = [];
		for (const dir of dirs) {
			for (let i = 0; i < 10; i++) {
				files.push({
					path: `/${dir}/file${i}.txt`,
					content: new TextEncoder().encode(`content-${dir}-${i}`),
					mode: 0o644,
				});
			}
		}

		await dialect.transaction(async (tx) => {
			await dialect.setSandboxContext(tx, sandboxId);
			await dialect.bulkIngest(tx, files);
		});

		// Verify all 5 directories exist under root and each contains 10 files
		const rootDirents = await dialect.transaction(async (tx) => {
			return await dialect.listDirents(tx, rootInodeId);
		});

		for (const dir of dirs) {
			const dirEntry = rootDirents.find((d) => d.name === dir);
			expect(dirEntry, `expected directory ${dir} in root`).toBeDefined();

			const dirFiles = await dialect.transaction(async (tx) => {
				return await dialect.listDirents(tx, dirEntry!.inodeId);
			});
			expect(dirFiles).toHaveLength(10);

			for (let i = 0; i < 10; i++) {
				const fileEntry = dirFiles.find((d) => d.name === `file${i}.txt`);
				expect(fileEntry, `expected file${i}.txt in ${dir}`).toBeDefined();
			}
		}
	});
});

describe.skipIf(!process.env.DATABASE_URL)("PostgresDialect — resolvePath (fs_resolve)", () => {
	const dialect = new PostgresDialect(process.env.DATABASE_URL!);
	const sandboxId = `test-resolve-${Date.now()}`;
	let rootInodeId: bigint;
	let fileInodeId: bigint;
	let userInodeId: bigint;
	let symlinkInodeId: bigint;

	beforeAll(async () => {
		await dialect.connect();

		// Apply stored procedure DDL (idempotent via CREATE OR REPLACE)
		const migrationSql = readFileSync(
			fileURLToPath(new URL("../../migrations/postgres/0001_rls_and_procs.sql", import.meta.url)),
			"utf8",
		);
		await dialect.transaction(async (tx) => {
			await tx.unsafe(migrationSql);
		});

		// Create sandbox and populate test fixtures
		await dialect.transaction(async (tx) => {
			await dialect.setSandboxContext(tx, sandboxId);
			const result = await dialect.createSandbox(tx, sandboxId);
			rootInodeId = result.rootInodeId;

			// Locate /home and /home/user (created by createSandbox)
			const rootDirents = await dialect.listDirents(tx, rootInodeId);
			const homeEntry = rootDirents.find((d) => d.name === "home");
			if (!homeEntry) throw new Error("home dir not found after createSandbox");

			const homeDirents = await dialect.listDirents(tx, homeEntry.inodeId);
			const userEntry = homeDirents.find((d) => d.name === "user");
			if (!userEntry) throw new Error("user dir not found after createSandbox");
			userInodeId = userEntry.inodeId;

			// Create /home/user/file.txt
			fileInodeId = await dialect.createInode(tx, { sandboxId, kind: 1, mode: 0o644, size: 5 });
			await dialect.insertDirent(tx, userInodeId, "file.txt", fileInodeId);

			// Create /link_to_user → /home/user (symlink)
			symlinkInodeId = await dialect.createInode(tx, {
				sandboxId,
				kind: 3,
				mode: 0o777,
				size: 0,
				symlinkTarget: "/home/user",
			});
			await dialect.insertDirent(tx, rootInodeId, "link_to_user", symlinkInodeId);

			// Create /loop_a → /loop_b and /loop_b → /loop_a (circular)
			const loopAId = await dialect.createInode(tx, {
				sandboxId,
				kind: 3,
				mode: 0o777,
				size: 0,
				symlinkTarget: "/loop_b",
			});
			await dialect.insertDirent(tx, rootInodeId, "loop_a", loopAId);

			const loopBId = await dialect.createInode(tx, {
				sandboxId,
				kind: 3,
				mode: 0o777,
				size: 0,
				symlinkTarget: "/loop_a",
			});
			await dialect.insertDirent(tx, rootInodeId, "loop_b", loopBId);
		});
	});

	afterAll(async () => {
		try {
			await dialect.transaction(async (tx) => {
				await dialect.deleteSandbox(tx, sandboxId);
			});
		} finally {
			await dialect.disconnect();
		}
	});

	it("resolves simple path /home/user/file.txt to the correct inode", async () => {
		const inodeId = await dialect.transaction(async (tx) => {
			await dialect.setSandboxContext(tx, sandboxId);
			return dialect.resolvePath(tx, "/home/user/file.txt", true);
		});
		expect(inodeId).toBe(fileInodeId);
	});

	it("resolves path with '.' and '..' components correctly", async () => {
		const inodeId = await dialect.transaction(async (tx) => {
			await dialect.setSandboxContext(tx, sandboxId);
			return dialect.resolvePath(tx, "/home/user/../user/./file.txt", true);
		});
		expect(inodeId).toBe(fileInodeId);
	});

	it("follows symlink on final component when followLast=true", async () => {
		const inodeId = await dialect.transaction(async (tx) => {
			await dialect.setSandboxContext(tx, sandboxId);
			return dialect.resolvePath(tx, "/link_to_user", true);
		});
		// /link_to_user → /home/user; should resolve to the /home/user directory inode
		expect(inodeId).toBe(userInodeId);
	});

	it("returns symlink inode itself when followLast=false", async () => {
		const inodeId = await dialect.transaction(async (tx) => {
			await dialect.setSandboxContext(tx, sandboxId);
			return dialect.resolvePath(tx, "/link_to_user", false);
		});
		expect(inodeId).toBe(symlinkInodeId);
	});

	it("throws ELOOP when resolving a circular symlink chain", async () => {
		await expect(
			dialect.transaction(async (tx) => {
				await dialect.setSandboxContext(tx, sandboxId);
				return dialect.resolvePath(tx, "/loop_a", true);
			}),
		).rejects.toMatchObject({ code: "ELOOP" });
	});

	it("throws ENOENT when path does not exist", async () => {
		await expect(
			dialect.transaction(async (tx) => {
				await dialect.setSandboxContext(tx, sandboxId);
				return dialect.resolvePath(tx, "/nonexistent/path", true);
			}),
		).rejects.toMatchObject({ code: "ENOENT" });
	});
});

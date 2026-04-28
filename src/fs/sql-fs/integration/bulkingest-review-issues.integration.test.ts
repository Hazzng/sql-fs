/**
 * Integration tests that reproduce three code-review issues found in
 * the optimized bulkIngest implementation:
 *
 * 1. Directory/symlink at target path gets silently overwritten as a file
 * 2. File dirent linking is N sequential round trips (perf regression)
 * 3. Hardlink nlink counts are wrong when the same old inode appears twice
 *
 * Skipped when DATABASE_URL is not set.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PostgresDialect } from "../dialects/postgres.js";
import { SqlFs } from "../sql-fs.js";
import type { BulkIngestFile } from "../types.js";

describe.skipIf(!process.env.DATABASE_URL)("bulkIngest review issues — integration", () => {
	const dialect = new PostgresDialect(process.env.DATABASE_URL!);
	const sandboxes: string[] = [];

	async function makeSandbox(): Promise<{ fs: SqlFs<unknown>; id: string }> {
		const id = `test-review-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		await dialect.transaction(async (tx) => {
			await dialect.createSandbox(tx, id);
		});
		sandboxes.push(id);
		const fs = new SqlFs({ dialect, sandboxId: id });
		await fs.ready();
		return { fs, id };
	}

	beforeAll(async () => {
		await dialect.connect();
	});

	afterEach(async () => {
		for (const id of sandboxes) {
			try {
				await dialect.transaction(async (tx) => {
					await dialect.deleteSandbox(tx, id);
				});
			} catch {}
		}
		sandboxes.length = 0;
	});

	afterAll(async () => {
		await dialect.disconnect();
	});

	// ── Issue 1: overwriting a directory as a file ────────────────────────────

	it("issue 1: ingesting a file at a path that is currently a directory throws EISDIR", async () => {
		const { fs } = await makeSandbox();

		// Create a directory with children
		await fs.mkdir("/home/user/mydir", { recursive: true });
		await fs.writeFile("/home/user/mydir/child.txt", "hello");

		// Attempt to ingest a file at /home/user/mydir — should reject
		await expect(
			fs.bulkIngest([{ path: "/home/user/mydir", content: new TextEncoder().encode("i am a file now"), mode: 0o644 }]),
		).rejects.toMatchObject({ code: "EISDIR" });

		// Directory and child must survive
		const stat = await fs.stat("/home/user/mydir");
		expect(stat.isDirectory).toBe(true);
		const childContent = await fs.readFile("/home/user/mydir/child.txt");
		expect(childContent).toBe("hello");
	});

	// ── Issue 2: file overwrite works correctly (regression from batching) ───

	it("issue 2: overwriting existing files updates content correctly", async () => {
		const { fs } = await makeSandbox();

		// Seed 20 files
		const initial: BulkIngestFile[] = [];
		for (let i = 0; i < 20; i++) {
			initial.push({
				path: `/home/user/file${i}.txt`,
				content: new TextEncoder().encode(`original-${i}`),
				mode: 0o644,
			});
		}
		await fs.bulkIngest(initial);

		// Overwrite all 20 files
		const overwrite: BulkIngestFile[] = [];
		for (let i = 0; i < 20; i++) {
			overwrite.push({
				path: `/home/user/file${i}.txt`,
				content: new TextEncoder().encode(`updated-${i}`),
				mode: 0o644,
			});
		}
		await fs.bulkIngest(overwrite);

		// All files should have updated content
		for (let i = 0; i < 20; i++) {
			const content = await fs.readFile(`/home/user/file${i}.txt`);
			expect(content).toBe(`updated-${i}`);
		}
	});

	// ── Issue 3: hardlink nlink correctness ──────────────────────────────────

	it("issue 3: overwriting two hardlinks to the same inode decrements nlink correctly", async () => {
		const { fs, id } = await makeSandbox();

		// Create a file
		await fs.writeFile("/home/user/original.txt", "shared content");
		// Hardlink it
		await fs.link("/home/user/original.txt", "/home/user/linked.txt");

		// Both should exist and share the same inode
		const cache = fs._getPathCache();
		const origInode = cache.get("/home/user/original.txt")!.inodeId;
		const linkInode = cache.get("/home/user/linked.txt")!.inodeId;
		expect(origInode).toBe(linkInode);

		// Overwrite both via bulkIngest — should decrement nlink twice and delete the old inode
		await fs.bulkIngest([
			{ path: "/home/user/original.txt", content: new TextEncoder().encode("new-orig"), mode: 0o644 },
			{ path: "/home/user/linked.txt", content: new TextEncoder().encode("new-link"), mode: 0o644 },
		]);

		// Both should have new content
		expect(await fs.readFile("/home/user/original.txt")).toBe("new-orig");
		expect(await fs.readFile("/home/user/linked.txt")).toBe("new-link");

		// Verify the old inode is fully cleaned up (nlink should be 0 → deleted)
		const oldInodeStillExists = await dialect.transaction(async (tx) => {
			await dialect.setSandboxContext(tx, id);
			return await dialect.getInode(tx, origInode);
		});
		expect(oldInodeStillExists).toBeNull();
	});

	// ── Verify the happy path still works ────────────────────────────────────

	it("mixed batch: new files + overwrites + nested dirs all in one call", async () => {
		const { fs } = await makeSandbox();

		// Seed some existing files
		await fs.bulkIngest([
			{ path: "/home/user/keep.txt", content: new TextEncoder().encode("keep"), mode: 0o644 },
			{ path: "/home/user/overwrite.txt", content: new TextEncoder().encode("old"), mode: 0o644 },
		]);

		// Mixed ingest: overwrite one, add new nested ones
		await fs.bulkIngest([
			{ path: "/home/user/overwrite.txt", content: new TextEncoder().encode("new"), mode: 0o644 },
			{ path: "/home/user/deep/a/b/c/new.txt", content: new TextEncoder().encode("deep"), mode: 0o644 },
			{ path: "/home/user/another.txt", content: new TextEncoder().encode("another"), mode: 0o644 },
		]);

		expect(await fs.readFile("/home/user/keep.txt")).toBe("keep");
		expect(await fs.readFile("/home/user/overwrite.txt")).toBe("new");
		expect(await fs.readFile("/home/user/deep/a/b/c/new.txt")).toBe("deep");
		expect(await fs.readFile("/home/user/another.txt")).toBe("another");
	});
});

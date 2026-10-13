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

import { Bash } from "just-bash";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PostgresDialect } from "../../dialects/postgres.js";
import { SqlFs } from "../../sql-fs.js";
import type { BulkIngestFile } from "../../types.js";

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
					await tx`DELETE FROM sandbox_epochs WHERE sandbox_id = ${id}`;
				});
			} catch {}
		}
		sandboxes.length = 0;
	});

	afterAll(async () => {
		await dialect.disconnect();
	});

	it("rejects root ingestion with EISDIR and preserves its children", async () => {
		const { fs, id } = await makeSandbox();
		const before = fs.getAllPaths();
		const file = { path: "/", content: new TextEncoder().encode("root overwrite"), mode: 0o644 };
		await expect(fs.bulkIngest([file])).rejects.toMatchObject({ code: "EISDIR" });
		await expect(dialect.transaction((tx) => dialect.bulkIngest(tx, [file], id))).rejects.toMatchObject({
			code: "EISDIR",
		});
		expect(fs.getAllPaths()).toEqual(before);
		expect((await fs.stat("/")).isDirectory).toBe(true);
	});

	it("supports ln -s by default and bounds cyclic resolution", async () => {
		const { fs } = await makeSandbox();
		await fs.writeFile("/home/user/target", "linked bytes");
		const bash = new Bash({ fs, cwd: "/home/user" });
		const result = await bash.exec("ln -s target alias; cat alias");
		expect({ exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }).toEqual({
			exitCode: 0,
			stdout: "linked bytes",
			stderr: "",
		});
		expect(await fs.readlink("/home/user/alias")).toBe("target");
		await fs.symlink("/home/user/cycle", "/home/user/cycle");
		await expect(fs.readFile("/home/user/cycle")).rejects.toMatchObject({ code: "ELOOP" });
	});

	it("resolves nested relative targets and clamps parent traversal to the sandbox root", async () => {
		const { fs } = await makeSandbox();
		await fs.mkdir("/home/user/sub");
		await fs.writeFile("/home/user/target", "nested target");
		await fs.writeFile("/root-target", "sandbox root");
		await fs.symlink("../target", "/home/user/sub/link");
		await fs.symlink("sub", "/home/user/directory-alias");
		expect(await fs.readFile("/home/user/directory-alias/link")).toBe("nested target");
		await fs.symlink("../../../../root-target", "/home/user/up");
		expect(await fs.readFile("/home/user/up")).toBe("sandbox root");
	});

	it("caps total SQL symlink hops across separate path components", async () => {
		const { fs, id } = await makeSandbox();
		await fs.writeFile("/home/user/target", "reachable");
		const names = Array.from({ length: 41 }, (_, index) => `hop${index}`);
		for (const name of names) await fs.symlink(".", `/home/user/${name}`);
		await dialect.transaction(async (tx) => {
			await dialect.setSandboxContext(tx, id);
			const allowed = `/home/user/${names.slice(0, 40).join("/")}/target`;
			expect(await dialect.resolvePath(tx, allowed, true)).toBe(fs._getPathCache().get("/home/user/target")?.inodeId);
		});
		await expect(
			dialect.transaction(async (tx) => {
				await dialect.setSandboxContext(tx, id);
				return dialect.resolvePath(tx, `/home/user/${names.join("/")}/target`, true);
			}),
		).rejects.toMatchObject({ code: "ELOOP" });
	});

	it.each(["/dev/null", "/dev/null/child", "/dev/./null"])(
		"rejects direct dialect ingestion of virtual device %s",
		async (path) => {
			const { fs, id } = await makeSandbox();
			const before = fs.getAllPaths();
			await expect(
				dialect.transaction((tx) => dialect.bulkIngest(tx, [{ path, content: new Uint8Array(1), mode: 0o644 }], id)),
			).rejects.toMatchObject({ code: path === "/dev/null/child" ? "ENOTDIR" : "EPERM" });
			await fs.reload();
			expect(fs.getAllPaths()).toEqual(before);
		},
	);

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

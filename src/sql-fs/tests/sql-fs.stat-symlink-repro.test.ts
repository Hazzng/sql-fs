import { beforeEach, describe, expect, it, vi } from "vitest";
import { SqlFs } from "../sql-fs.js";
import type { PathCacheEntry, SqlDialect } from "../types.js";

const now = new Date("2026-01-01T00:00:00Z");

function dirEntry(path: string, inodeId: bigint): { path: string } & PathCacheEntry {
	return { path, inodeId, kind: 2, mode: 0o755, size: 0, mtime: now, contentSha256: null, symlinkTarget: null };
}
function fileEntry(path: string, inodeId: bigint, size = 5): { path: string } & PathCacheEntry {
	return {
		path,
		inodeId,
		kind: 1,
		mode: 0o644,
		size,
		mtime: now,
		contentSha256: new Uint8Array(32).fill(0xab),
		symlinkTarget: null,
	};
}

// A dialect whose resolvePath mirrors fs_resolve: it walks the adjacency list and
// resolves symlinks (relative + multi-hop) to the final non-symlink inode id.
// This is exactly the resolver readFile/realpath use via #resolveReadEntry/#withReadTx.
function makeDialect(): SqlDialect<unknown> {
	let nextInodeId = 100n;
	// inodeId -> {kind, target?} for the resolver to walk.
	// Layout we will build at runtime via symlink():
	//   /home/actual.txt        file   (id 5)
	//   /home/user/link         -> "../actual.txt"   (relative target)
	//   /home/user/hop1         -> "/home/user/hop2"
	//   /home/user/hop2         -> "/home/actual.txt"
	const inodes = new Map<bigint, { kind: number; target?: string }>([
		[1n, { kind: 2 }],
		[2n, { kind: 2 }],
		[3n, { kind: 2 }],
		[5n, { kind: 1 }],
	]);
	// name table to resolve absolute paths -> inode id
	const byPath = new Map<string, bigint>([
		["/", 1n],
		["/home", 2n],
		["/home/user", 3n],
		["/home/actual.txt", 5n],
	]);

	function normalize(p: string): string {
		const parts: string[] = [];
		for (const seg of p.split("/")) {
			if (seg === "" || seg === ".") continue;
			if (seg === "..") parts.pop();
			else parts.push(seg);
		}
		return `/${parts.join("/")}`;
	}

	return {
		connect: vi.fn(),
		disconnect: vi.fn(),
		transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
		setSandboxContext: vi.fn(),
		setSandboxContextWithLock: vi.fn(),
		loadAllPaths: vi.fn(async () => [
			dirEntry("/", 1n),
			dirEntry("/home", 2n),
			dirEntry("/home/user", 3n),
			fileEntry("/home/actual.txt", 5n),
		]),
		createSandbox: vi.fn(),
		deleteSandbox: vi.fn(),
		createInode: vi.fn(async (_tx: unknown, args: { kind: number; symlinkTarget?: string }) => {
			nextInodeId += 1n;
			inodes.set(nextInodeId, { kind: args.kind, target: args.symlinkTarget });
			return nextInodeId;
		}),
		getInode: vi.fn(),
		updateInode: vi.fn(),
		deleteInode: vi.fn(),
		incrementNlink: vi.fn(),
		decrementNlink: vi.fn(async () => 0),
		// record the absolute path -> inode so resolvePath can walk it
		insertDirent: vi.fn(async (_tx: unknown, parentId: bigint, name: string, inodeId: bigint) => {
			// find parent's absolute path
			let parentPath = "/";
			for (const [p, id] of byPath) if (id === parentId) parentPath = p;
			const full = parentPath === "/" ? `/${name}` : `${parentPath}/${name}`;
			byPath.set(full, inodeId);
		}),
		upsertDirent: vi.fn(async () => null),
		deleteDirent: vi.fn(async () => 4n),
		listDirents: vi.fn(),
		moveDirent: vi.fn(),
		upsertBlob: vi.fn(),
		getBlob: vi.fn(async () => new Uint8Array(0)),
		getBlobNoTx: vi.fn(async () => new Uint8Array(32).fill(0xab)),
		gcOrphanBlobs: vi.fn(),
		getBlobsForSandbox: vi.fn(async () => []),
		loadSubtreeInodes: vi.fn(async () => [3n, 5n]),
		bulkIngest: vi.fn(),
		// Correct fs_resolve semantics: follow symlinks (relative + chained) to final inode.
		resolvePath: vi.fn(async (_tx: unknown, path: string, followLast: boolean) => {
			let cur = normalize(path);
			let hops = 0;
			while (true) {
				if (hops++ > 40) throw new Error("ELOOP: too many levels of symbolic links");
				const id = byPath.get(cur);
				if (id === undefined) throw new Error(`ENOENT: ${cur}`);
				const node = inodes.get(id)!;
				if (node.kind !== 3 || !followLast) return id;
				// resolve symlink target relative to its own directory
				const dir = cur.slice(0, cur.lastIndexOf("/")) || "/";
				const t = node.target ?? "";
				cur = t.startsWith("/") ? normalize(t) : normalize(`${dir}/${t}`);
			}
		}),
	} as unknown as SqlDialect<unknown>;
}

describe("SqlFs.stat() symlink resolution (M7 regression)", () => {
	let dialect: SqlDialect<unknown>;
	let fs: SqlFs;

	beforeEach(async () => {
		dialect = makeDialect();
		fs = new SqlFs({ dialect, sandboxId: "s-repro", allowSymlinks: true });
		await fs.ready();
	});

	it("relative target: stat follows the link to the real file (matches readFile/realpath)", async () => {
		// bash: ln -s ../actual.txt /home/user/link
		await fs.symlink("../actual.txt", "/home/user/link");

		await expect(fs.realpath("/home/user/link")).resolves.toBe("/home/actual.txt");
		await expect(fs.readFile("/home/user/link")).resolves.toBeTypeOf("string");

		// stat() now resolves the relative target through fs_resolve and reports the
		// real file's metadata (was: ENOENT from a raw pathCache lookup).
		const st = await fs.stat("/home/user/link");
		expect(st.isFile).toBe(true);
		expect(st.isDirectory).toBe(false);
		expect(st.isSymbolicLink).toBe(false);
	});

	it("chained link: stat follows the full chain to the real file", async () => {
		// bash: ln -s /home/actual.txt /home/user/hop2 ; ln -s /home/user/hop2 /home/user/hop1
		await fs.symlink("/home/actual.txt", "/home/user/hop2");
		await fs.symlink("/home/user/hop2", "/home/user/hop1");

		await expect(fs.realpath("/home/user/hop1")).resolves.toBe("/home/actual.txt");

		// stat() follows the multi-hop chain to the regular file (was: stopped at the
		// intermediate symlink with isFile=isDirectory=false).
		const st = await fs.stat("/home/user/hop1");
		expect(st.isFile).toBe(true);
		expect(st.isDirectory).toBe(false);
	});

	it("CONTROL — absolute single-hop target works", async () => {
		// bash: ln -s /home/actual.txt /home/user/abslink
		await fs.symlink("/home/actual.txt", "/home/user/abslink");
		const st = await fs.stat("/home/user/abslink");
		expect(st.isFile).toBe(true);
		expect(st.isDirectory).toBe(false);
	});
});

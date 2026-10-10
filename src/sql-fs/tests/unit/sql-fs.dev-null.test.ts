/**
 * SqlFs serves `/dev/null` as a virtual device (vercel-labs/just-bash#558): writes
 * vanish, reads are empty, and nothing reaches the journal, the caches or the DB.
 */

import type { Redis } from "ioredis";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readOnlyContext } from "../../../api/read-only-context.js";
import type { RedisPathSnapshot } from "../../redis-path-snapshot.js";
import { SqlFs } from "../../sql-fs.js";
import { BUFFER_ON, DEFAULT_TREE, type DialectProbe, makeProbeDialect } from "../fixtures/buffered-dialect.js";

describe("SqlFs — virtual /dev/null", () => {
	let probe: DialectProbe;
	let fs: SqlFs;

	beforeEach(async () => {
		probe = makeProbeDialect();
		fs = new SqlFs({ dialect: probe.dialect, sandboxId: "s-devnull", scriptTxBuffer: BUFFER_ON, allowSymlinks: true });
		await fs.ready();
		probe.calls.length = 0;
	});

	it("discards writeFile without a dialect call", async () => {
		await fs.writeFile("/dev/null", "data");
		expect(probe.calls).toEqual([]);
		expect(await fs.readFile("/dev/null")).toBe("");
	});

	it("discards appendFile without a dialect call", async () => {
		await fs.appendFile("/dev/null", "data");
		expect(probe.calls).toEqual([]);
		expect(await fs.readFileBuffer("/dev/null")).toEqual(new Uint8Array(0));
	});

	it("leaves a script scope with nothing to flush", async () => {
		probe.windows.length = 0;
		fs.beginScriptScope();
		await fs.writeFile("/dev/null", "data");
		await fs.appendFile("/dev/null", "more");
		await fs.endScriptScope();
		expect(fs.wasDirty()).toBe(false);
		expect(probe.windows).toEqual([]);
		expect(probe.calls).toEqual([]);
	});

	it("accepts writes inside a read-only scope", async () => {
		fs.beginReadOnlyScope();
		const ctx = { violated: false };
		try {
			await readOnlyContext.run(ctx, () => fs.writeFile("/dev/null", "data"));
		} finally {
			fs.endReadOnlyScope();
		}
		expect(ctx.violated).toBe(false);
	});

	it("stats as an empty file", async () => {
		const st = await fs.stat("/dev/null");
		expect({
			isFile: st.isFile,
			isDirectory: st.isDirectory,
			isSymbolicLink: st.isSymbolicLink,
			size: st.size,
		}).toEqual({
			isFile: true,
			isDirectory: false,
			isSymbolicLink: false,
			size: 0,
		});
		expect(await fs.lstat("/dev/null")).toEqual(st);
	});

	it("exists and resolves to itself", async () => {
		expect(await fs.exists("/dev/null")).toBe(true);
		expect(await fs.realpath("/dev/null")).toBe("/dev/null");
	});

	it("is not listed among the sandbox's paths", () => {
		expect(fs.getAllPaths()).not.toContain("/dev/null");
		expect(fs.getAllPaths()).not.toContain("/dev");
	});

	it.each([
		["mkdir", (fs: SqlFs) => fs.mkdir("/dev/null"), "EEXIST"],
		["recursive mkdir", (fs: SqlFs) => fs.mkdir("/dev/null", { recursive: true }), "ENOTDIR"],
		["exclusive create", (fs: SqlFs) => fs.createExclusive("/dev/null", { mode: 0o600 }), "EEXIST"],
		[
			"ingest",
			(fs: SqlFs) => fs.bulkIngest([{ path: "/dev/null", content: new Uint8Array([1]), mode: 0o644 }]),
			"EPERM",
		],
		["move into device", (fs: SqlFs) => fs.mv("/home/user/file.txt", "/dev/null"), "EPERM"],
		["move device", (fs: SqlFs) => fs.mv("/dev/null", "/home/user/null"), "EPERM"],
		["symlink", (fs: SqlFs) => fs.symlink("/home/user/file.txt", "/dev/null"), "EEXIST"],
		["hardlink into device", (fs: SqlFs) => fs.link("/home/user/file.txt", "/dev/null"), "EEXIST"],
		["hardlink device", (fs: SqlFs) => fs.link("/dev/null", "/home/user/null"), "EPERM"],
		["remove", (fs: SqlFs) => fs.rm("/dev/null", { recursive: true, force: true }), "EPERM"],
		["chmod", (fs: SqlFs) => fs.chmod("/dev/null", 0o600), "EPERM"],
		["utimes", (fs: SqlFs) => fs.utimes("/dev/null", new Date(), new Date()), "EPERM"],
	] as const)("reserves the virtual entry during %s", async (_name, mutate, code) => {
		await fs.mkdir("/dev");
		fs.clearDirty();
		probe.calls.length = 0;
		await expect(mutate(fs)).rejects.toMatchObject({ code });
		expect(probe.calls).toEqual([]);
		expect(fs.wasDirty()).toBe(false);
		expect(fs.getAllPaths()).not.toContain("/dev/null");
		expect((await fs.stat("/dev/null")).mode).toBe(0o666);
	});

	it.each([
		["write", (fs: SqlFs) => fs.writeFile("/dev/null/child", "x")],
		["append", (fs: SqlFs) => fs.appendFile("/dev/null/child", "x")],
		["mkdir", (fs: SqlFs) => fs.mkdir("/dev/null/child", { recursive: true })],
		["exclusive create", (fs: SqlFs) => fs.createExclusive("/dev/null/child", { mode: 0o600 })],
		["ingest", (fs: SqlFs) => fs.bulkIngest([{ path: "/dev/null/child", content: new Uint8Array([1]), mode: 0o644 }])],
		["copy", (fs: SqlFs) => fs.cp("/home/user/file.txt", "/dev/null/child")],
		["move", (fs: SqlFs) => fs.mv("/home/user/file.txt", "/dev/null/child")],
		["symlink", (fs: SqlFs) => fs.symlink("/home/user/file.txt", "/dev/null/child")],
		["hardlink", (fs: SqlFs) => fs.link("/home/user/file.txt", "/dev/null/child")],
		["remove", (fs: SqlFs) => fs.rm("/dev/null/child", { recursive: true, force: true })],
		["chmod", (fs: SqlFs) => fs.chmod("/dev/null/child", 0o600)],
		["utimes", (fs: SqlFs) => fs.utimes("/dev/null/child", new Date(), new Date())],
	] as const)("rejects descendants during %s before a database call", async (_name, mutate) => {
		await expect(mutate(fs)).rejects.toMatchObject({ code: "ENOTDIR" });
		expect(probe.calls).toEqual([]);
		expect(fs.wasDirty()).toBe(false);
		expect(fs.getAllPaths()).not.toContain("/dev");
	});

	it.each(["cp", "mv"] as const)("rejects an indirect device collision during subtree %s", async (operation) => {
		await fs.mkdir("/source");
		await fs.writeFile("/source/null", "hidden");
		fs.clearDirty();
		probe.calls.length = 0;
		const mutation = operation === "cp" ? fs.cp("/source", "/dev", { recursive: true }) : fs.mv("/source", "/dev");
		await expect(mutation).rejects.toMatchObject({ code: "EPERM" });
		expect(probe.calls).toEqual([]);
		expect(fs.wasDirty()).toBe(false);
		expect(await fs.readFile("/source/null")).toBe("hidden");
		expect(fs.getAllPaths()).not.toContain("/dev");
	});

	it("validates the complete ingest batch before writing ordinary paths", async () => {
		await expect(
			fs.bulkIngest([
				{ path: "/home/user/ordinary", content: new Uint8Array([1]), mode: 0o644 },
				{ path: "/dev/./null/../null/child", content: new Uint8Array([2]), mode: 0o644 },
			]),
		).rejects.toMatchObject({ code: "ENOTDIR" });
		expect(probe.calls).toEqual([]);
		expect(await fs.exists("/home/user/ordinary")).toBe(false);
	});

	it("copies the virtual device as an empty file and truncates a cached destination", async () => {
		await fs.writeFile("/home/user/destination", "cached content");
		expect(fs._getContentCache().calculatedSize).toBeGreaterThan(0);
		probe.calls.length = 0;
		await fs.cp("/dev/null", "/home/user/destination");
		expect(await fs.readFile("/home/user/destination")).toBe("");
		expect((await fs.stat("/home/user/destination")).size).toBe(0);
		expect(probe.calls).not.toContain("commitBlob");
		expect(fs._getContentCache().calculatedSize).toBe(0);
	});

	it("copies files to the virtual sink without database writes", async () => {
		await fs.cp("/home/user/file.txt", "/dev/null");
		await fs.cp("/dev/null", "/dev/null");
		expect(probe.calls).toEqual([]);
		expect(fs.wasDirty()).toBe(false);
		await expect(fs.cp("/missing", "/dev/null")).rejects.toMatchObject({ code: "ENOENT" });
		await expect(fs.cp("/home", "/dev/null", { recursive: true })).rejects.toMatchObject({ code: "ENOTDIR" });
	});

	it("rejects directory reads at the virtual file", async () => {
		await expect(fs.readdir("/dev/null")).rejects.toMatchObject({ code: "ENOTDIR" });
		await expect(fs.readdirWithFileTypes("/dev/null")).rejects.toMatchObject({ code: "ENOTDIR" });
		await expect(fs.readlink("/dev/null")).rejects.toMatchObject({ code: "EINVAL" });
		expect(probe.calls).toEqual([]);
	});

	it.each([
		["/dev/null", "EPERM"],
		["/dev/null/child", "ENOTDIR"],
	] as const)("rejects persisted %s before populating the cache", async (path, code) => {
		const legacy = { ...DEFAULT_TREE[3]!, path, inodeId: 99n };
		const loaded = new SqlFs({ dialect: makeProbeDialect([...DEFAULT_TREE, legacy]).dialect, sandboxId: "legacy" });
		await expect(loaded.ready()).rejects.toMatchObject({ code });
		expect(loaded.getAllPaths()).toEqual([]);
	});

	it("keeps the old tree and cached bytes when reload finds a reserved persisted entry", async () => {
		await fs.writeFile("/home/user/cached", "old bytes");
		const paths = fs.getAllPaths();
		const cacheBytes = fs._getContentCache().calculatedSize;
		vi.mocked(probe.dialect.loadAllPaths).mockResolvedValueOnce([
			...DEFAULT_TREE,
			{ ...DEFAULT_TREE[3]!, path: "/dev/null", inodeId: 99n },
		]);
		await expect(fs.reload()).rejects.toMatchObject({ code: "EPERM" });
		expect(fs.getAllPaths()).toEqual(paths);
		expect(fs._getContentCache().calculatedSize).toBe(cacheBytes);
		expect(await fs.readFile("/home/user/cached")).toBe("old bytes");
	});

	it("rejects a snapshot that contains the reserved device", async () => {
		const entries = new Map(DEFAULT_TREE.map(({ path, ...entry }) => [path, entry]));
		entries.set("/dev/null", { ...DEFAULT_TREE[3]!, inodeId: 99n });
		const snapshotFs = new SqlFs({
			dialect: probe.dialect,
			sandboxId: "legacy-snapshot",
			redis: { get: vi.fn(async () => "0") } as unknown as Redis,
			pathSnapshot: { read: vi.fn(async () => ({ version: 0, entries })) } as unknown as RedisPathSnapshot,
		});
		await expect(snapshotFs.ready()).rejects.toMatchObject({ code: "EPERM" });
		expect(snapshotFs.getAllPaths()).toEqual([]);
	});
});

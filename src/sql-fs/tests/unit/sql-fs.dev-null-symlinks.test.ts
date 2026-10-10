import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqlFs } from "../../sql-fs.js";
import { BUFFER_ON, type DialectProbe, makeProbeDialect } from "../fixtures/buffered-dialect.js";

const READS = ["readFile", "readFileBuffer", "stat", "realpath"] as const;

describe.each([false, true])("virtual /dev/null symlinks with buffering=%s", (buffered) => {
	let probe: DialectProbe;
	let fs: SqlFs;

	beforeEach(async () => {
		probe = makeProbeDialect();
		fs = new SqlFs({
			dialect: probe.dialect,
			sandboxId: "s-null-alias",
			allowSymlinks: true,
			scriptTxBuffer: BUFFER_ON,
		});
		await fs.ready();
		if (buffered) fs.beginScriptScope();
	});

	afterEach(async () => {
		if (buffered) await fs.endScriptScope();
	});

	async function expectDevice(alias: string): Promise<void> {
		probe.calls.length = 0;
		fs.clearDirty();
		expect(await fs.readFile(alias)).toBe("");
		expect(await fs.readFileBuffer(alias)).toEqual(new Uint8Array(0));
		expect(await fs.stat(alias)).toEqual(await fs.stat("/dev/null"));
		expect(await fs.realpath(alias)).toBe("/dev/null");
		expect(probe.dialect.resolvePath).not.toHaveBeenCalled();
		expect(probe.calls).toEqual([]);
		expect(fs.wasDirty()).toBe(false);
		expect(fs.getAllPaths()).not.toContain("/dev/null");
		expect(fs.getAllPaths()).not.toContain("/dev");
	}

	it.each(["/dev/null", "../../dev/null", "/dev/./null", "../../dev/null/../null"])(
		"reads and resolves an alias targeting %s without a stored device inode",
		async (target) => {
			await fs.symlink(target, "/home/user/null");
			await expectDevice("/home/user/null");
			expect((await fs.lstat("/home/user/null")).isSymbolicLink).toBe(true);
			expect(await fs.readlink("/home/user/null")).toBe(target);
		},
	);

	it("follows a chain of relative aliases", async () => {
		await fs.symlink("../../dev/null", "/home/user/end");
		await fs.symlink("end", "/home/user/middle");
		await fs.symlink("middle", "/home/user/start");
		await expectDevice("/home/user/start");
	});

	it("resolves a directory alias leading to the virtual-only /dev path", async () => {
		await fs.symlink("/dev", "/home/user/dev");
		await expectDevice("/home/user/dev/null");
	});

	it("resolves a root directory alias before the virtual device", async () => {
		await fs.symlink("../..", "/home/user/root");
		await expectDevice("/home/user/root/dev/null");
	});

	it("follows an ordinary directory alias before the device alias", async () => {
		await fs.symlink("/dev/null", "/home/user/null");
		await fs.symlink("/home/user", "/home/user/dir");
		await expectDevice("/home/user/dir/null");
	});

	it.each(READS)("%s rejects descendants reached through device aliases with ENOTDIR", async (operation) => {
		await fs.symlink("/dev/null", "/home/user/null");
		await fs.symlink("/dev", "/home/user/dev");
		await fs.symlink("/dev/null/child", "/home/user/child");
		probe.calls.length = 0;
		for (const path of ["/home/user/null/child", "/home/user/dev/null/child", "/home/user/child"]) {
			await expect(fs[operation](path)).rejects.toMatchObject({ code: "ENOTDIR" });
		}
		expect(probe.dialect.resolvePath).not.toHaveBeenCalled();
		expect(probe.calls).toEqual([]);
	});

	it.each(READS)("%s retains ELOOP for cyclic aliases", async (operation) => {
		await fs.symlink("b", "/home/user/a");
		await fs.symlink("a", "/home/user/b");
		await expect(fs[operation]("/home/user/a")).rejects.toMatchObject({ code: "ELOOP" });
	});

	it.each(READS)("%s retains ENOENT for an ordinary broken symlink", async (operation) => {
		await fs.symlink("missing", "/home/user/broken");
		await expect(fs[operation]("/home/user/broken")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("keeps ordinary symlink reads and metadata on their existing resolution path", async () => {
		await fs.writeFile("/home/user/ordinary", "ordinary bytes");
		await fs.symlink("ordinary", "/home/user/link");
		const entry = fs._getPathCache().get("/home/user/ordinary")!;
		vi.mocked(probe.dialect.resolvePath).mockResolvedValue(entry.inodeId);
		expect(await fs.readFile("/home/user/link")).toBe("ordinary bytes");
		expect(await fs.stat("/home/user/link")).toEqual(await fs.stat("/home/user/ordinary"));
		expect(await fs.realpath("/home/user/link")).toBe("/home/user/ordinary");
		if (buffered) expect(probe.dialect.resolvePath).not.toHaveBeenCalled();
		else expect(probe.dialect.resolvePath).toHaveBeenCalledWith(expect.anything(), "/home/user/link", true);
	});
});

/**
 * `createExclusive` — just-bash 3.6's `mktemp` creates through it and refuses (ENOSYS) on a
 * filesystem without it, so `t=$(mktemp)` failed in every sandbox.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SqlFs } from "../../sql-fs.js";
import { type BashOverSqlFs, bashOverSqlFs } from "../fixtures/bash-over-sqlfs.js";
import { BUFFER_ON, makeProbeDialect } from "../fixtures/buffered-dialect.js";

describe("SqlFs — createExclusive", () => {
	let env: BashOverSqlFs;

	beforeEach(async () => {
		env = await bashOverSqlFs();
	});

	it("creates an empty file with the requested mode", async () => {
		await env.fs.createExclusive("/home/user/t", { mode: 0o600 });
		const st = await env.fs.stat("/home/user/t");
		expect({ isFile: st.isFile, size: st.size, mode: st.mode }).toEqual({ isFile: true, size: 0, mode: 0o600 });
	});

	it("creates a directory with the requested mode", async () => {
		await env.fs.createExclusive("/home/user/td", { mode: 0o700, directory: true });
		const st = await env.fs.stat("/home/user/td");
		expect({ isDirectory: st.isDirectory, mode: st.mode }).toEqual({ isDirectory: true, mode: 0o700 });
		expect(env.probe.dialect.mkdirComposite).toHaveBeenCalledWith(expect.anything(), "s-redirect", 3n, "td", 0o700);
		expect(env.probe.calls.filter((call) => call === "mkdirComposite")).toHaveLength(1);
		expect(env.probe.calls).not.toContain("updateInode");
	});

	it("throws EEXIST when the path exists", async () => {
		await expect(env.fs.createExclusive("/home/user/file.txt", { mode: 0o600 })).rejects.toMatchObject({
			code: "EEXIST",
		});
	});

	it("throws ENOENT when the parent is missing", async () => {
		await expect(env.fs.createExclusive("/home/user/nope/t", { mode: 0o600 })).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("lets only one of two concurrent creates of the same path succeed", async () => {
		const results = await Promise.allSettled([
			env.fs.createExclusive("/home/user/race", { mode: 0o600 }),
			env.fs.createExclusive("/home/user/race", { mode: 0o600 }),
		]);
		expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
	});
});

describe.each([false, true])("SqlFs — exclusive creation with buffering=%s", (buffered) => {
	async function makeFs() {
		const probe = makeProbeDialect();
		const fs = new SqlFs({
			dialect: probe.dialect,
			sandboxId: "s-exclusive-race",
			allowSymlinks: true,
			scriptTxBuffer: buffered ? BUFFER_ON : undefined,
		});
		await fs.ready();
		if (buffered) fs.beginScriptScope();
		return { fs, probe };
	}

	it.each([
		["write", (fs: SqlFs) => fs.writeFile("/home/user/race", "ordinary")],
		["append", (fs: SqlFs) => fs.appendFile("/home/user/race", "ordinary")],
		["mkdir", (fs: SqlFs) => fs.mkdir("/home/user/race")],
		["recursive mkdir", (fs: SqlFs) => fs.mkdir("/home/user/race/child", { recursive: true })],
		["copy", (fs: SqlFs) => fs.cp("/home/user/file.txt", "/home/user/race")],
		["move", (fs: SqlFs) => fs.mv("/home/user/file.txt", "/home/user/race")],
		["symlink", (fs: SqlFs) => fs.symlink("file.txt", "/home/user/race")],
		["hardlink", (fs: SqlFs) => fs.link("/home/user/file.txt", "/home/user/race")],
	] as const)("waits for an ordinary %s before the exclusive existence check", async (_name, create) => {
		const { fs } = await makeFs();
		const [ordinary, exclusive] = await Promise.allSettled([
			create(fs),
			fs.createExclusive("/home/user/race", { mode: 0o600 }),
		]);
		expect(ordinary.status).toBe("fulfilled");
		expect(exclusive).toMatchObject({ status: "rejected", reason: { code: "EEXIST" } });
		if (buffered) await fs.endScriptScope();
	});

	it("does not block an independent sibling while a blob commit is pending", async () => {
		const { fs, probe } = await makeFs();
		let unblock!: () => void;
		let entered!: () => void;
		const waiting = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			unblock = resolve;
		});
		vi.mocked(probe.dialect.commitBlob!).mockImplementationOnce(async () => {
			entered();
			await gate;
		});
		const ordinary = fs.writeFile("/home/user/pending", "ordinary");
		await waiting;
		try {
			await fs.createExclusive("/home/user/sibling", { mode: 0o600 });
			expect(await fs.exists("/home/user/pending")).toBe(false);
			expect((await fs.stat("/home/user/sibling")).mode).toBe(0o600);
		} finally {
			unblock();
			await ordinary;
		}
		if (buffered) await fs.endScriptScope();
	});

	it("releases a failed ordinary creation so a queued exclusive creation can succeed", async () => {
		const { fs, probe } = await makeFs();
		vi.mocked(probe.dialect.commitBlob!).mockRejectedValueOnce(new Error("blob rejected"));
		const results = await Promise.allSettled([
			fs.writeFile("/home/user/race", "ordinary"),
			fs.createExclusive("/home/user/race", { mode: 0o600 }),
		]);
		expect(results.map((result) => result.status)).toEqual(["rejected", "fulfilled"]);
		expect((await fs.stat("/home/user/race")).mode).toBe(0o600);
		if (buffered) await fs.endScriptScope();
	});

	it("serializes overlapping copies without a lock-order deadlock", async () => {
		const { fs } = await makeFs();
		await fs.writeFile("/home/user/a", "a");
		await fs.writeFile("/home/user/b", "b");
		const results = await Promise.allSettled([
			fs.cp("/home/user/a", "/home/user/b"),
			fs.cp("/home/user/b", "/home/user/a"),
		]);
		expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
		if (buffered) await fs.endScriptScope();
	});

	it.each([false, true])(
		"rejects pending and queued writes after scope abort, replacement scope=%s",
		async (replace) => {
			const { fs, probe } = await makeFs();
			if (!buffered) fs.beginScriptScope();
			let unblock!: () => void;
			let entered!: () => void;
			const waiting = new Promise<void>((resolve) => {
				entered = resolve;
			});
			const gate = new Promise<void>((resolve) => {
				unblock = resolve;
			});
			vi.mocked(probe.dialect.commitBlob!).mockImplementationOnce(async () => {
				entered();
				await gate;
			});
			const ordinary = fs.writeFile("/home/user/race", "ordinary");
			await waiting;
			const results = Promise.allSettled([ordinary, fs.createExclusive("/home/user/race", { mode: 0o600 })]);
			await fs.abortScriptScope();
			if (replace) fs.beginScriptScope();
			unblock();
			expect(await results).toMatchObject([
				{ status: "rejected", reason: { code: "ESTALE" } },
				{ status: "rejected", reason: { code: "ESTALE" } },
			]);
			expect(probe.calls).not.toContain("writeFileComposite");
			expect(probe.calls).not.toContain("createInode");
			expect(await fs.exists("/home/user/race")).toBe(false);
			// Both failed operations release their reservations for the next caller.
			await fs.createExclusive("/home/user/race", { mode: 0o600 });
			if (replace) await fs.endScriptScope();
		},
	);

	it.each([false, true])("creates private directories in one mutation, composite=%s", async (composite) => {
		const { fs, probe } = await makeFs();
		if (!composite) probe.dialect.mkdirComposite = undefined;
		await fs.createExclusive("/home/user/private", { mode: 0o700, directory: true });
		expect((await fs.stat("/home/user/private")).mode).toBe(0o700);
		if (buffered) await fs.endScriptScope();
		if (composite) {
			expect(probe.dialect.mkdirComposite).toHaveBeenCalledTimes(1);
			expect(vi.mocked(probe.dialect.mkdirComposite!).mock.calls[0]![4]).toBe(0o700);
		} else {
			expect(probe.dialect.createInode).toHaveBeenCalledTimes(1);
			expect(vi.mocked(probe.dialect.createInode).mock.calls[0]![1]).toMatchObject({ mode: 0o700, kind: 2 });
		}
		expect(probe.dialect.updateInode).not.toHaveBeenCalled();
	});
});

it("waits for bulk ingest before an exclusive existence check", async () => {
	const env = await bashOverSqlFs();
	const entry = { ...env.fs._getPathCache().get("/home/user/file.txt")!, inodeId: 9000n };
	vi.mocked(env.probe.dialect.bulkIngest).mockResolvedValueOnce(new Map([["/home/user/race", entry]]));
	const results = await Promise.allSettled([
		env.fs.bulkIngest([{ path: "/home/user/race", content: new Uint8Array([1]), mode: 0o644 }]),
		env.fs.createExclusive("/home/user/race", { mode: 0o600 }),
	]);
	expect(results[0]!.status).toBe("fulfilled");
	expect(results[1]).toMatchObject({ status: "rejected", reason: { code: "EEXIST" } });
});

describe("bash over SqlFs — mktemp", () => {
	let env: BashOverSqlFs;

	beforeEach(async () => {
		env = await bashOverSqlFs();
	});

	it("creates a private temp file", async () => {
		const r = await env.bash.exec("mkdir -p /tmp; t=$(mktemp); echo data > $t; cat $t; stat -c %a $t");
		expect({ stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode }).toEqual({
			stdout: "data\n600\n",
			stderr: "",
			exitCode: 0,
		});
	});

	it("creates a private temp directory", async () => {
		const r = await env.bash.exec("mkdir -p /tmp; d=$(mktemp -d); test -d $d && stat -c %a $d");
		expect({ stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode }).toEqual({
			stdout: "700\n",
			stderr: "",
			exitCode: 0,
		});
	});
});

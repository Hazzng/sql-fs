/**
 * `createExclusive` — just-bash 3.6's `mktemp` creates through it and refuses (ENOSYS) on a
 * filesystem without it, so `t=$(mktemp)` failed in every sandbox.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { type BashOverSqlFs, bashOverSqlFs } from "../fixtures/bash-over-sqlfs.js";

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

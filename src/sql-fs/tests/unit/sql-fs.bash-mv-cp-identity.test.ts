/**
 * `mv`/`cp` over an existing file. just-bash 3.6 refuses to replace a target unless the
 * backend can prove the two paths are different files, which it reads from `stat().identity`
 * (or `dev`/`ino`). Without it, `jq ... > tmp && mv tmp file` failed with "cannot safely
 * determine whether ... are the same file".
 */

import { beforeEach, describe, expect, it } from "vitest";
import { type BashOverSqlFs, bashOverSqlFs } from "../fixtures/bash-over-sqlfs.js";

describe("bash over SqlFs — mv and cp onto an existing file", () => {
	let env: BashOverSqlFs;

	beforeEach(async () => {
		env = await bashOverSqlFs();
	});

	it("replaces an existing file with mv", async () => {
		const r = await env.bash.exec("echo old > f; echo new > t; mv t f; cat f; test -e t || echo gone");
		expect({ stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode }).toEqual({
			stdout: "new\ngone\n",
			stderr: "",
			exitCode: 0,
		});
	});

	// The probe dialect stores no blob bytes, so this checks the copy happened, not its content.
	it("replaces an existing file with cp", async () => {
		const r = await env.bash.exec("echo old > f; echo newer > t; cp t f; echo rc=$?; stat -c %s f");
		expect({ stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode }).toEqual({
			stdout: "rc=0\n6\n",
			stderr: "",
			exitCode: 0,
		});
	});

	// just-bash follows POSIX rename here (success, no change), not GNU mv's error.
	it("leaves a file unchanged when it is moved onto itself", async () => {
		const r = await env.bash.exec("echo a > f; mv f ./f; echo rc=$?; cat f");
		expect({ stdout: r.stdout, stderr: r.stderr }).toEqual({ stdout: "rc=0\na\n", stderr: "" });
	});

	it("gives a file the same identity through stat and lstat", async () => {
		await env.bash.exec("echo a > f");
		const st = await env.fs.stat("/home/user/f");
		expect(st.identity).toBeDefined();
		expect((await env.fs.lstat("/home/user/f")).identity).toBe(st.identity);
	});

	it("gives two files different identities", async () => {
		await env.bash.exec("echo a > f; echo b > g");
		expect((await env.fs.stat("/home/user/f")).identity).not.toBe((await env.fs.stat("/home/user/g")).identity);
	});
});

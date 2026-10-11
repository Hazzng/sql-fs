/**
 * `/dev/null` redirects on a filesystem without `/dev` (vercel-labs/just-bash#558).
 *
 * just-bash writes `> /dev/null` through the filesystem and only seeds `/dev` on a
 * filesystem with sync methods, so on SqlFs every stdout redirect to it rejected
 * `bash.exec()` with ENOENT and the API answered 404. SqlFs serves `/dev/null` as
 * a virtual device instead.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { type BashOverSqlFs, bashOverSqlFs } from "../fixtures/bash-over-sqlfs.js";

describe("bash over SqlFs — /dev/null redirects (just-bash#558)", () => {
	let env: BashOverSqlFs;

	beforeEach(async () => {
		env = await bashOverSqlFs();
	});

	it("discards stdout with > /dev/null and runs the next command", async () => {
		const r = await env.bash.exec("echo x > /dev/null; echo after");
		expect({ stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode }).toEqual({
			stdout: "after\n",
			stderr: "",
			exitCode: 0,
		});
	});

	it("discards stdout with >> /dev/null", async () => {
		const r = await env.bash.exec("echo x >> /dev/null; echo after");
		expect({ stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode }).toEqual({
			stdout: "after\n",
			stderr: "",
			exitCode: 0,
		});
	});

	it("discards both streams with &> /dev/null", async () => {
		const r = await env.bash.exec("ls /nope &> /dev/null; echo after rc=$?");
		expect({ stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode }).toEqual({
			stdout: "after rc=2\n",
			stderr: "",
			exitCode: 0,
		});
	});

	it("discards both streams with > /dev/null 2>&1", async () => {
		const r = await env.bash.exec("ls /nope > /dev/null 2>&1; echo after rc=$?");
		expect({ stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode }).toEqual({
			stdout: "after rc=2\n",
			stderr: "",
			exitCode: 0,
		});
	});

	it("discards stderr with 2>> /dev/null", async () => {
		const r = await env.bash.exec("ls /nope 2>> /dev/null; echo after rc=$?");
		expect({ stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode }).toEqual({
			stdout: "after rc=2\n",
			stderr: "",
			exitCode: 0,
		});
	});

	it("keeps the exit status of a command whose output went to /dev/null", async () => {
		const r = await env.bash.exec("if command -v ls > /dev/null; then echo has_ls; fi");
		expect({ stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode }).toEqual({
			stdout: "has_ls\n",
			stderr: "",
			exitCode: 0,
		});
	});

	it("discards the output of a loop redirected to /dev/null", async () => {
		const r = await env.bash.exec("for c in a b; do echo $c; done > /dev/null; echo after");
		expect({ stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode }).toEqual({
			stdout: "after\n",
			stderr: "",
			exitCode: 0,
		});
	});

	it("reads < /dev/null as empty input", async () => {
		const r = await env.bash.exec("wc -c < /dev/null");
		expect({ stdout: r.stdout.trim(), stderr: r.stderr, exitCode: r.exitCode }).toEqual({
			stdout: "0",
			stderr: "",
			exitCode: 0,
		});
	});

	it("reads /dev/null as an empty file argument", async () => {
		const r = await env.bash.exec("cat /dev/null; echo rc=$?");
		expect({ stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode }).toEqual({
			stdout: "rc=0\n",
			stderr: "",
			exitCode: 0,
		});
	});

	it("reports /dev/null as existing", async () => {
		const r = await env.bash.exec("test -e /dev/null && echo yes || echo no");
		expect(r.stdout).toBe("yes\n");
	});

	it("never writes /dev/null into the filesystem", async () => {
		await env.bash.exec("echo x > /dev/null; echo y >> /dev/null; echo z &> /dev/null");
		expect(env.probe.calls).toEqual([]);
		expect(env.fs.getAllPaths()).not.toContain("/dev/null");
	});
});

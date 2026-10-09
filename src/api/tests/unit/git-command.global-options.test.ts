/**
 * Global options before the subcommand (blindmansion/just-git#11).
 *
 * just-git takes `args[0]` as the subcommand, so `git -c user.name=x commit -m m` printed the
 * help text and exited 0 without committing, and `git -C dir status` / `git --no-pager log` did
 * the same. The wrapper handles the options agents actually use and refuses the rest loudly.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { type BashOverSqlFs, bashOverSqlFs } from "../../../sql-fs/tests/fixtures/bash-over-sqlfs.js";
import { createGitCommand } from "../../commands/git-command.js";

const IDENTITY = {
	GIT_AUTHOR_NAME: "a",
	GIT_AUTHOR_EMAIL: "a@b.c",
	GIT_COMMITTER_NAME: "a",
	GIT_COMMITTER_EMAIL: "a@b.c",
};

describe("git wrapper — global options", () => {
	let env: BashOverSqlFs;

	async function sh(script: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		const r = await env.bash.exec(script);
		return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
	}

	beforeEach(async () => {
		env = await bashOverSqlFs({ env: IDENTITY, customCommands: [createGitCommand({ network: false })] });
		expect((await sh("mkdir r && cd r && git init -q && echo a > f && git add f")).exitCode).toBe(0);
	});

	it("commits with the identity given by -c user.name and -c user.email", async () => {
		const r = await sh(
			"cd r && git -c user.name=x -c user.email=x@y.z commit -q -m m; echo rc=$?; git log --format='%an <%ae>'",
		);
		expect(r.stdout).toBe("rc=0\nx <x@y.z>\n");
	});

	it("runs the command when -c names a key with no effect in the sandbox", async () => {
		const r = await sh(
			"cd r && git -c commit.gpgsign=false -c core.pager=cat commit -q -m m; echo rc=$?; git log --oneline | wc -l",
		);
		expect(r.stdout.replace(/ +/g, "")).toBe("rc=0\n1\n");
	});

	it("refuses -c for a key it cannot apply, without running the command", async () => {
		const r = await sh(
			"cd r && git -c core.autocrlf=true commit -q -m m; echo rc=$?; git log --oneline 2>/dev/null | wc -l",
		);
		expect(r.stdout.replace(/ +/g, "")).toBe("rc=129\n0\n");
		expect(r.stderr).toBe(
			"git: -c core.autocrlf is not supported here; set it with `git config core.autocrlf <value>` instead\n",
		);
	});

	it("refuses -c without a name=value argument", async () => {
		const r = await sh("cd r && git -c; echo rc=$?");
		expect(r.stdout).toBe("rc=129\n");
		expect(r.stderr).toBe("git: -c needs a name=value argument\n");
	});

	it("runs in the directory given by -C", async () => {
		const r = await sh("git -C r commit -q -m m; echo rc=$?; git -C r log --oneline | wc -l");
		expect(r.stdout.replace(/ +/g, "")).toBe("rc=0\n1\n");
	});

	it("accepts --no-pager", async () => {
		const r = await sh("cd r && git commit -q -m m && git --no-pager log --format=%s");
		expect(r).toEqual({ stdout: "m\n", stderr: "", exitCode: 0 });
	});

	it("refuses an unknown global option with exit 129", async () => {
		const r = await sh("cd r && git --bogus status; echo rc=$?");
		expect(r.stdout).toBe("rc=129\n");
		expect(r.stderr).toBe("git: unknown option: --bogus\n");
	});

	it("still answers --version", async () => {
		const r = await sh("git --version");
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toMatch(/^just-git version /);
	});
});

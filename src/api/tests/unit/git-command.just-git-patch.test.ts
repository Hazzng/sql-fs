/**
 * Behaviour carried by `patches/just-git@1.9.1.patch` until upstream releases it.
 *
 * - blindmansion/just-git#15 (fixes #10): status and diff report a chmod-only change, and a branch
 *   switch where a file differs only in mode rewrites the mode.
 * - blindmansion/just-git#14 (fixes #12): `git ls-tree`.
 *
 * When a just-git release includes both PRs, drop the patch and keep these tests.
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

/** `main` has an executable `run.sh`; `plain` records the same content as 100644. */
const SEED = [
	"mkdir repo && cd repo && git init -q",
	"printf 'echo ran\\n' > run.sh && chmod 755 run.sh",
	"git add -A && git commit -q -m init",
	"git checkout -q -b plain && chmod 644 run.sh && git commit -q -am plain && git checkout -q main",
].join(" && ");

describe("git wrapper — patched just-git behaviour", () => {
	let env: BashOverSqlFs;

	async function sh(script: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		const r = await env.bash.exec(script);
		return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
	}

	beforeEach(async () => {
		env = await bashOverSqlFs({ env: IDENTITY, customCommands: [createGitCommand({ network: false })] });
		expect((await sh(SEED)).exitCode).toBe(0);
	});

	it("reports a chmod-only change in status and diff", async () => {
		const r = await sh("cd repo && chmod 644 run.sh && git status --short && git diff");
		expect(r).toEqual({
			stdout: " M run.sh\ndiff --git a/run.sh b/run.sh\nold mode 100755\nnew mode 100644\n",
			stderr: "",
			exitCode: 0,
		});
	});

	it("applies the mode when switching to a branch where only the mode differs", async () => {
		expect((await sh("cd repo && stat -c %a run.sh")).stdout).toBe("755\n");
		await sh("cd repo && git checkout -q plain");
		expect((await sh("cd repo && stat -c %a run.sh && git status --short")).stdout).toBe("644\n");
		await sh("cd repo && git checkout -q main");
		expect((await sh("cd repo && stat -c %a run.sh && git status --short")).stdout).toBe("755\n");
	});

	it("refuses to switch over a local chmod-only change", async () => {
		const r = await sh("cd repo && chmod 644 run.sh && git checkout plain");
		expect(r.exitCode).toBe(1);
		expect(r.stderr).toContain("Your local changes to the following files would be overwritten by checkout:");
		expect((await sh("cd repo && git branch --show-current")).stdout).toBe("main\n");
	});

	it("lists a tree with git ls-tree", async () => {
		expect(await sh("cd repo && git ls-tree --name-only plain && git ls-tree HEAD | cut -d' ' -f1-2")).toEqual({
			stdout: "run.sh\n100755 blob\n",
			stderr: "",
			exitCode: 0,
		});
	});
});

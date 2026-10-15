import { beforeEach, describe, expect, it } from "vitest";
import { type BashOverSqlFs, bashOverSqlFs } from "../../../sql-fs/tests/fixtures/bash-over-sqlfs.js";
import { createGitCommand } from "../../commands/git-command.js";

const IDENTITY = {
	GIT_AUTHOR_NAME: "a",
	GIT_AUTHOR_EMAIL: "a@b.c",
	GIT_COMMITTER_NAME: "a",
	GIT_COMMITTER_EMAIL: "a@b.c",
};

const SEED = [
	"mkdir repo && cd repo && git init -q",
	"printf 'echo ran\\n' > run.sh && chmod 755 run.sh",
	"git add -A && git commit -q -m init",
	"git checkout -q -b plain && chmod 644 run.sh && git commit -q -am plain && git checkout -q main",
].join(" && ");

describe("git wrapper with just-git 1.10 regressions", () => {
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

	it("recurses, filters by path and resolves <rev>:<path> in git ls-tree", async () => {
		await sh(
			"cd repo && mkdir -p src/lib && echo a > src/a && echo b > src/lib/b && git add src && git commit -q -m src",
		);
		const r = await sh(
			"cd repo && git ls-tree --name-only HEAD && git ls-tree -r --name-only HEAD && " +
				"git ls-tree --name-only HEAD src/lib && git ls-tree -r --name-only HEAD:src",
		);
		expect(r).toEqual({
			stdout: "run.sh\nsrc\n" + "run.sh\nsrc/a\nsrc/lib/b\n" + "src/lib\n" + "a\nlib/b\n",
			stderr: "",
			exitCode: 0,
		});
	});

	it("keeps a mode-only change from the merged branch", async () => {
		await sh("cd repo && git checkout -q -b side plain && chmod 755 run.sh && git commit -q -am exec");
		await sh("cd repo && git checkout -q plain && echo n > n && git add n && git commit -q -m n");
		const r = await sh("cd repo && git merge -q -m mg side && git ls-files -s run.sh | cut -c1-6 && stat -c %a run.sh");
		expect(r).toEqual({ stdout: "100755\n755\n", stderr: "", exitCode: 0 });
	});

	it("gives a conflicted file the merged mode", async () => {
		await sh(
			"cd repo && git checkout -q -b side plain && echo theirs > run.sh && chmod 755 run.sh && git commit -q -am t",
		);
		await sh("cd repo && git checkout -q plain && echo ours > run.sh && git commit -q -am o");
		const r = await sh(
			"cd repo && git merge -q side; echo rc=$?; git ls-files -s run.sh | cut -c1-6 && stat -c %a run.sh",
		);
		expect(r.stdout.split("\n").slice(-6)).toEqual(["rc=1", "100644", "100644", "100755", "755", ""]);
	});

	it("prints git show --summary", async () => {
		await sh("cd repo && git mv run.sh go.sh && echo n > n && git add n && git commit -q -m sum");
		expect(await sh("cd repo && git show --summary --format=%s HEAD")).toEqual({
			stdout: "sum\n\n rename run.sh => go.sh (100%)\n create mode 100644 n\n",
			stderr: "",
			exitCode: 0,
		});
	});
});

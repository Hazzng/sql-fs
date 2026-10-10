/**
 * Files git writes get the mode their index entry records (blindmansion/just-git#10).
 *
 * just-git's checkout never sets the executable bit: a cloned `run.sh` lands 0644, so `./run.sh`
 * fails with "Permission denied", and the next `git add -A` records `100755 -> 100644` for a file
 * nobody touched. The wrapper applies the index mode to every file git wrote, in both directions,
 * and leaves files git did not write alone.
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

/** A source repo whose `main` has an executable `run.sh` and a plain `README.md`. */
const SEED = [
	"mkdir src && cd src && git init -q",
	"printf '#!/bin/bash\\necho ran\\n' > run.sh && chmod 755 run.sh",
	"echo readme > README.md",
	"git add -A && git commit -q -m init",
].join(" && ");

describe("git wrapper — index modes on files git writes", () => {
	let env: BashOverSqlFs;

	async function sh(script: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		const r = await env.bash.exec(script);
		return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
	}

	beforeEach(async () => {
		env = await bashOverSqlFs({ env: IDENTITY, customCommands: [createGitCommand({ network: false })] });
		expect((await sh(SEED)).exitCode).toBe(0);
	});

	it("checks out an executable file as 755 on clone", async () => {
		await sh("git clone -q src dst");
		expect((await sh("stat -c '%a %n' dst/run.sh dst/README.md")).stdout).toBe("755 dst/run.sh\n644 dst/README.md\n");
	});

	it("lets a cloned script run", async () => {
		await sh("git clone -q src dst");
		expect(await sh("cd dst && ./run.sh")).toEqual({ stdout: "ran\n", stderr: "", exitCode: 0 });
	});

	it("records no mode change when committing a fresh clone", async () => {
		await sh("git clone -q src dst");
		const r = await sh("cd dst && git add -A && git commit -q -m again; git log --oneline | wc -l");
		expect(r.stdout.trim().split("\n").at(-1)?.trim()).toBe("1");
	});

	it("restores 755 when checking out a deleted executable", async () => {
		await sh("git clone -q src dst");
		await sh("cd dst && rm run.sh && git checkout -- run.sh");
		expect((await sh("stat -c %a dst/run.sh")).stdout).toBe("755\n");
	});

	it("drops the exec bit when a branch records the file as 100644", async () => {
		// Content changes too: just-git rewrites a file only when its blob changes (see applyIndexModes).
		await sh(
			"cd src && git checkout -q -b plain && echo 'echo plain' > run.sh && chmod 644 run.sh && git add run.sh && git commit -q -m plain",
		);
		await sh("git clone -q src dst && cd dst && git checkout -q main");
		expect((await sh("stat -c %a dst/run.sh")).stdout).toBe("755\n");
		await sh("cd dst && git checkout -q plain");
		expect((await sh("stat -c %a dst/run.sh")).stdout).toBe("644\n");
	});

	it("keeps the mode across git mv", async () => {
		await sh("git clone -q src dst && cd dst && git mv run.sh go.sh");
		expect((await sh("stat -c %a dst/go.sh")).stdout).toBe("755\n");
	});

	it("leaves a file git did not write alone", async () => {
		const result = await sh(
			"git clone -q src dst && cd dst && chmod 755 README.md && rm run.sh && git checkout -- run.sh",
		);
		expect(result.exitCode, result.stderr).toBe(0);
		expect((await sh("stat -c %a dst/README.md")).stdout).toBe("755\n");
		expect((await sh("stat -c %a dst/run.sh")).stdout).toBe("755\n");
	});
});

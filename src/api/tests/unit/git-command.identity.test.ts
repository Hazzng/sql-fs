/**
 * Commit identity precedence in the sandbox.
 *
 * just-git 1.9.1 runs `git -c ...` (blindmansion/just-git#11) and, like real git, lets the
 * GIT_AUTHOR_* env beat `-c user.*` and repo config. The deployment's default identity used to be
 * exported into every sandbox as that env, so it silently beat both. It is now just-git's fallback
 * identity instead, below everything an agent or a request sets.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { type BashOverSqlFs, bashOverSqlFs } from "../../../sql-fs/tests/fixtures/bash-over-sqlfs.js";
import { createGitCommand } from "../../commands/git-command.js";
import { buildGitIdentity } from "../../session-manager.js";

const DEPLOYMENT = { name: "Deploy Default", email: "deploy@example.com" };

describe("git identity precedence", () => {
	let env: BashOverSqlFs;

	async function authorOf(commit: string, execEnv?: Record<string, string>): Promise<string> {
		const result = await env.bash.exec(
			`cd r && echo $RANDOM >> f && git add f && ${commit}`,
			execEnv ? { env: execEnv } : undefined,
		);
		expect(result.exitCode, result.stderr).toBe(0);
		return (await env.bash.exec("cd r && git log -1 --format='%an <%ae>'")).stdout;
	}

	beforeEach(async () => {
		env = await bashOverSqlFs({ customCommands: [createGitCommand({ network: false, identity: DEPLOYMENT })] });
		const result = await env.bash.exec("mkdir r && cd r && git init -q");
		expect(result.exitCode, result.stderr).toBe(0);
	});

	it("falls back to the deployment identity", async () => {
		expect(await authorOf("git commit -q -m m")).toBe("Deploy Default <deploy@example.com>\n");
	});

	it("lets git -c user.* beat the deployment identity", async () => {
		expect(await authorOf("git -c user.name=x -c user.email=x@y.z commit -q -m m")).toBe("x <x@y.z>\n");
	});

	// Native git rejects valueless user.* when resolving commit identity. The sandbox rejects
	// these effective bare overrides up front with usage exit 129, instead of authoring as "true".
	it.each(["-c user.name", "-c user.email", "-c USER.NaMe", "-cUsEr.EmAiL"])(
		"rejects a bare identity override %s before creating a commit",
		async (override) => {
			const result = await env.bash.exec(`cd r && echo hi > f && git add f && git ${override} commit -q -m m`);
			expect(result.exitCode).toBe(129);
			expect(result.stderr).toMatch(/user\.(name|email) requires an explicit value/);
			expect((await env.bash.exec("cd r && git log --oneline")).exitCode).not.toBe(0);
		},
	);

	it("validates identity overrides after leading directory and pager options", async () => {
		const result = await env.bash.exec(
			"echo hi > r/f && git -C r add f && git -C r --no-pager -c user.name commit -q -m m",
		);
		expect(result.exitCode).toBe(129);
		expect(result.stderr).toContain("user.name requires an explicit value");
	});

	it("accepts a later explicit override of the same identity key", async () => {
		expect(await authorOf("git -c USER.Name -c user.name=Chosen commit -q -m m")).toBe("Chosen <deploy@example.com>\n");
	});

	it("rejects a bare override after an explicit value", async () => {
		const result = await env.bash.exec(
			"cd r && echo hi > f && git add f && git -c user.name=Chosen -c USER.Name commit -q -m m",
		);
		expect(result.exitCode).toBe(129);
		expect(result.stderr).toContain("user.name requires an explicit value");
	});

	it("leaves explicit empty identity values for just-git to reject", async () => {
		const result = await env.bash.exec("cd r && echo hi > f && git add f && git -c user.name= commit -q -m m");
		expect(result.exitCode).toBe(128);
		expect(result.stderr).toContain("identity unknown");
	});

	it("still accepts bare boolean config keys", async () => {
		expect(await authorOf("git -c core.filemode commit -q -m m")).toBe("Deploy Default <deploy@example.com>\n");
	});

	it("lets repo config beat the deployment identity", async () => {
		await env.bash.exec("cd r && git config user.name Repo && git config user.email repo@r.r");
		expect(await authorOf("git commit -q -m m")).toBe("Repo <repo@r.r>\n");
	});

	it("lets per-request GIT_AUTHOR_* env beat everything", async () => {
		const author = await authorOf("git -c user.name=x -c user.email=x@y.z commit -q -m m", {
			GIT_AUTHOR_NAME: "Request",
			GIT_AUTHOR_EMAIL: "req@r.r",
		});
		expect(author).toBe("Request <req@r.r>\n");
	});

	it("runs git -C from another directory", async () => {
		await authorOf("git commit -q -m m");
		expect((await env.bash.exec("git -C r log --oneline | wc -l")).stdout.trim()).toBe("1");
	});
});

describe("buildGitIdentity", () => {
	it("reads the author identity, falling back to the committer", () => {
		expect(buildGitIdentity({ GIT_AUTHOR_NAME: "A", GIT_AUTHOR_EMAIL: "a@a" })).toEqual({ name: "A", email: "a@a" });
		expect(buildGitIdentity({ GIT_COMMITTER_NAME: "C", GIT_COMMITTER_EMAIL: "c@c" })).toEqual({
			name: "C",
			email: "c@c",
		});
	});

	it("returns undefined unless both a name and an email are set", () => {
		expect(buildGitIdentity({})).toBeUndefined();
		expect(buildGitIdentity({ GIT_AUTHOR_NAME: "A" })).toBeUndefined();
	});
});

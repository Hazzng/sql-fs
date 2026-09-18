import { Bash, InMemoryFs, defineCommand } from "just-bash";
import { createGit } from "just-git";
import { readCommit, resolveRef } from "just-git/repo";
import { type Auth, createServer } from "just-git/server";
import { describe, expect, it } from "vitest";

const TOKEN = "test-token";
const BASE_URL = "https://git.test";

function makeGitBash(network: ReturnType<ReturnType<typeof createServer<Auth>>["asNetwork"]>): Bash {
	const fs = new InMemoryFs();
	const git = createGit({ network });
	const gitCommand = defineCommand("git", (args, ctx) => git.execute(args, ctx as Parameters<typeof git.execute>[1]));
	return new Bash({ fs, customCommands: [gitCommand] });
}

describe("git network transport", () => {
	it("clones, commits with exec env identity, rejects missing tokens, and pushes with bearer auth", async () => {
		const seenAuthorizations: Array<string | null> = [];
		const server = createServer({
			onError: false,
			hooks: {
				preReceive: ({ auth }) => {
					const authorization = auth.request?.headers.get("authorization") ?? null;
					seenAuthorizations.push(authorization);
					if (authorization !== `Bearer ${TOKEN}`) {
						return { reject: true, message: "missing or invalid bearer token" };
					}
				},
			},
		});
		await server.createRepo("project");
		const initial = await server.commit("project", {
			files: { "README.md": "# Project\n" },
			message: "initial remote commit",
			author: { name: "Remote Bot", email: "remote@example.com" },
			branch: "main",
		});

		const bash = makeGitBash(server.asNetwork(BASE_URL));
		const clone = await bash.exec(`git clone ${BASE_URL}/project /repo`);

		expect(clone.exitCode, clone.stderr).toBe(0);
		await expect(bash.exec("cat /repo/README.md")).resolves.toMatchObject({
			exitCode: 0,
			stdout: "# Project\n",
		});

		const commitEnv = {
			GIT_AUTHOR_NAME: "Agent Author",
			GIT_AUTHOR_EMAIL: "author@example.com",
			GIT_COMMITTER_NAME: "Agent Committer",
			GIT_COMMITTER_EMAIL: "committer@example.com",
		};
		const commit = await bash.exec(
			[
				"cd /repo",
				"printf '\\nupdated\\n' >> README.md",
				"git add README.md",
				"git commit -m 'agent update'",
				"git log -1 --pretty=fuller",
			].join(" && "),
			{ env: commitEnv, cwd: "/repo" },
		);

		expect(commit.exitCode, commit.stderr).toBe(0);
		expect(commit.stdout).toContain("Author:     Agent Author <author@example.com>");
		expect(commit.stdout).toContain("Commit:     Agent Committer <committer@example.com>");

		const localHead = await bash.exec("git rev-parse HEAD", { cwd: "/repo" });
		expect(localHead.exitCode, localHead.stderr).toBe(0);
		const localHeadHash = localHead.stdout.trim();
		expect(localHeadHash).not.toBe(initial.hash);

		const rejectedPush = await bash.exec("git push origin main", { cwd: "/repo" });
		expect(rejectedPush.exitCode).not.toBe(0);
		expect(rejectedPush.stderr).toMatch(/missing or invalid bearer token|failed to push/i);

		const acceptedPush = await bash.exec("git push origin main", {
			cwd: "/repo",
			env: { GIT_HTTP_BEARER_TOKEN: TOKEN },
		});
		expect(acceptedPush.exitCode, acceptedPush.stderr).toBe(0);
		expect(seenAuthorizations).toContain(null);
		expect(seenAuthorizations).toContain(`Bearer ${TOKEN}`);

		const remoteRepo = await server.requireRepo("project");
		const remoteHead = await resolveRef(remoteRepo, "refs/heads/main");
		expect(remoteHead).toBe(localHeadHash);

		const remoteCommit = await readCommit(remoteRepo, localHeadHash);
		expect(remoteCommit.author).toMatchObject({
			name: "Agent Author",
			email: "author@example.com",
		});
		expect(remoteCommit.committer).toMatchObject({
			name: "Agent Committer",
			email: "committer@example.com",
		});
	});
});

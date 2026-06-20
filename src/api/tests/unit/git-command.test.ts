import { InMemoryFs } from "just-bash";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager, buildSandboxBaseEnv } from "../../session-manager.js";

const T = "default";

const GIT_IDENTITY = "GIT_AUTHOR_NAME=a GIT_AUTHOR_EMAIL=a@x.com GIT_COMMITTER_NAME=a GIT_COMMITTER_EMAIL=a@x.com";

function makeSessionManager(): SessionManager {
	return new SessionManager({
		createFs: async () => new InMemoryFs(),
		defenseInDepth: false,
	});
}

describe("buildSandboxBaseEnv", () => {
	it("exports GitHub token auth env and optional git identity only when set", () => {
		expect(buildSandboxBaseEnv({})).toEqual({});

		expect(
			buildSandboxBaseEnv({
				GITHUB_TOKEN: "server-token",
				GIT_AUTHOR_NAME: "Agent",
				GIT_AUTHOR_EMAIL: "agent@example.com",
				GIT_COMMITTER_NAME: "",
			}),
		).toEqual({
			GITHUB_TOKEN: "server-token",
			GIT_HTTP_USER: "x-access-token",
			GIT_HTTP_PASSWORD: "server-token",
			GIT_AUTHOR_NAME: "Agent",
			GIT_AUTHOR_EMAIL: "agent@example.com",
		});
	});
});

describe("SessionManager git command", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("registers git for local init/add/commit/log without network", async () => {
		const sm = makeSessionManager();
		const session = await sm.getOrCreate(T, "git-local-cycle", { python: false, javascript: false, network: false });

		const result = await session.bash.exec(
			["git init", "echo hi > a.txt", "git add .", `${GIT_IDENTITY} git commit -m init`, "git log --oneline"].join(
				" && ",
			),
		);

		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toContain("init");
	});

	it("blocks remote git operations cleanly when network is disabled", async () => {
		const sm = makeSessionManager();
		const session = await sm.getOrCreate(T, "git-network-blocked", {
			python: false,
			javascript: false,
			network: false,
		});

		const result = await session.bash.exec("git clone https://github.com/x/y");

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toMatch(/network|disabled|blocked|not allowed/i);
	});

	it("injects server GitHub token env and lets per-request env override it for one exec", async () => {
		vi.stubEnv("GITHUB_TOKEN", "server-token");
		const sm = makeSessionManager();
		const session = await sm.getOrCreate(T, "git-token-env", { python: false, javascript: false, network: false });

		await expect(
			session.bash.exec('printf \'%s:%s:%s\' "$GITHUB_TOKEN" "$GIT_HTTP_USER" "$GIT_HTTP_PASSWORD"'),
		).resolves.toMatchObject({
			exitCode: 0,
			stdout: "server-token:x-access-token:server-token",
		});

		await expect(
			session.bash.exec('printf \'%s:%s:%s\' "$GITHUB_TOKEN" "$GIT_HTTP_USER" "$GIT_HTTP_PASSWORD"', {
				env: { GITHUB_TOKEN: "override", GIT_HTTP_USER: "override-user", GIT_HTTP_PASSWORD: "override-password" },
			}),
		).resolves.toMatchObject({
			exitCode: 0,
			stdout: "override:override-user:override-password",
		});

		await expect(
			session.bash.exec('printf \'%s:%s:%s\' "$GITHUB_TOKEN" "$GIT_HTTP_USER" "$GIT_HTTP_PASSWORD"'),
		).resolves.toMatchObject({
			exitCode: 0,
			stdout: "server-token:x-access-token:server-token",
		});
	});

	it("omits GitHub token env when the server env is unset", async () => {
		vi.stubEnv("GITHUB_TOKEN", undefined);
		const sm = makeSessionManager();
		const session = await sm.getOrCreate(T, "git-token-env-unset", {
			python: false,
			javascript: false,
			network: false,
		});

		const result = await session.bash.exec("env");

		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stdout).not.toMatch(/^GITHUB_TOKEN=/m);
		expect(result.stdout).not.toMatch(/^GIT_HTTP_USER=/m);
		expect(result.stdout).not.toMatch(/^GIT_HTTP_PASSWORD=/m);
	});
});

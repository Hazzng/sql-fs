import { randomUUID } from "node:crypto";
import { readCommit, resolveRef } from "just-git/repo";
import { type Auth, createServer } from "just-git/server";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../../migrations.js";
import { type RuntimeOptions, SessionManager } from "../../session-manager.js";
import { type TenantConfig, loadTenantConfig } from "../../tenants.js";

const SKIP = !process.env.DATABASE_URL;
const TENANT_ID = "default";
const BASE_URL = "https://git.test";
const REPO_ID = "project";
const TOKEN = "server-token";
const IDENTITY = {
	GIT_AUTHOR_NAME: "Agent Author",
	GIT_AUTHOR_EMAIL: "author@example.com",
	GIT_COMMITTER_NAME: "Agent Committer",
	GIT_COMMITTER_EMAIL: "committer@example.com",
};

type GitServer = ReturnType<typeof createServer<Auth>>;

interface CreatedSandbox {
	readonly manager: SessionManager;
	readonly id: string;
}

describe.skipIf(SKIP)("git through SessionManager and Postgres SqlFs", () => {
	let tenantConfig: TenantConfig;
	let database: postgres.Sql | undefined;
	const managers: SessionManager[] = [];
	const servers: GitServer[] = [];
	const createdSandboxes: CreatedSandbox[] = [];

	beforeAll(async () => {
		tenantConfig = loadTenantConfig();
		await runMigrations(tenantConfig);
		database = postgres(tenantConfig.getConnectionString(TENANT_ID), { prepare: false, max: 1 });
	});

	afterAll(async () => {
		if (database) await database.end({ timeout: 5 });
	});

	afterEach(async () => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		await Promise.allSettled(createdSandboxes.splice(0).map(({ manager, id }) => manager.destroy(TENANT_ID, id)));
		await Promise.allSettled(managers.splice(0).map((manager) => manager.shutdown()));
		await Promise.allSettled(servers.splice(0).map((server) => server.close()));
	});

	function makeManager(): SessionManager {
		const manager = new SessionManager({ tenantConfig });
		managers.push(manager);
		return manager;
	}

	async function makeSession(manager: SessionManager, runtimeOptions: RuntimeOptions) {
		const id = `git-sqlfs-${randomUUID()}`;
		createdSandboxes.push({ manager, id });
		const session = await manager.getOrCreate(TENANT_ID, id, runtimeOptions);
		return { id, session };
	}

	function trackServer(server: GitServer): GitServer {
		servers.push(server);
		return server;
	}

	function routeFetch(server: GitServer): void {
		const originalFetch = globalThis.fetch;
		vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (!url.startsWith(BASE_URL)) return originalFetch(input, init);
			return server.fetch(new Request(input, init));
		});
	}

	async function seedRemote(server: GitServer) {
		await server.createRepo(REPO_ID);
		return server.commit(REPO_ID, {
			files: { "README.md": "remote contents\n" },
			message: "initial remote commit",
			author: { name: "Remote Bot", email: "remote@example.com" },
			branch: "main",
		});
	}

	async function clonedFileCount(sandboxId: string): Promise<number> {
		if (!database) throw new Error("database client not initialized");
		const rows = await database<{ count: number }[]>`
			SELECT count(*)::int AS count
			FROM dirents d
			JOIN inodes i ON i.id = d.inode_id
			WHERE d.sandbox_id = ${sandboxId} AND d.name = 'README.md' AND i.kind = 1
		`;
		return rows[0]?.count ?? 0;
	}

	it("initializes, commits, and reads a local repository from Postgres", async () => {
		vi.stubEnv("GITHUB_TOKEN", undefined);
		const manager = makeManager();
		const { session } = await makeSession(manager, { python: false, javascript: false, network: false });

		const init = await session.bash.exec("git init /repo");
		expect(init.exitCode, init.stderr).toBe(0);
		const commit = await session.bash.exec(
			["printf 'local contents\\n' > README.md", "git add README.md", "git commit -m 'initial'"].join(" && "),
			{ cwd: "/repo", env: IDENTITY },
		);
		expect(commit.exitCode, commit.stderr).toBe(0);

		const log = await session.bash.exec("git log --format=%s -1", { cwd: "/repo" });
		expect(log.exitCode, log.stderr).toBe(0);
		expect(log.stdout).toBe("initial\n");
	});

	it("clones remote files into Postgres-backed worktree paths", async () => {
		vi.stubEnv("GITHUB_TOKEN", undefined);
		const server = trackServer(createServer({ onError: false }));
		await seedRemote(server);
		routeFetch(server);
		const manager = makeManager();
		const { id, session } = await makeSession(manager, { python: false, javascript: false, network: true });

		const clone = await session.bash.exec(`git clone ${BASE_URL}/${REPO_ID} /repo`);
		expect(clone.exitCode, clone.stderr).toBe(0);
		const read = await session.bash.exec("cat /repo/README.md");
		expect(read.exitCode, read.stderr).toBe(0);
		expect(read.stdout).toBe("remote contents\n");
		expect(await clonedFileCount(id)).toBe(1);
	});

	it("pushes a SqlFs commit with the exec identity recorded on the remote", async () => {
		vi.stubEnv("GITHUB_TOKEN", undefined);
		const server = trackServer(createServer({ onError: false }));
		await seedRemote(server);
		routeFetch(server);
		const manager = makeManager();
		const { session } = await makeSession(manager, { python: false, javascript: false, network: true });

		expect((await session.bash.exec(`git clone ${BASE_URL}/${REPO_ID} /repo`)).exitCode).toBe(0);
		const commit = await session.bash.exec(
			["printf 'agent update\\n' >> README.md", "git add README.md", "git commit -m 'agent update'"].join(" && "),
			{ cwd: "/repo", env: IDENTITY },
		);
		expect(commit.exitCode, commit.stderr).toBe(0);
		const localHead = await session.bash.exec("git rev-parse HEAD", { cwd: "/repo" });
		expect(localHead.exitCode, localHead.stderr).toBe(0);

		const push = await session.bash.exec("git push origin main", { cwd: "/repo" });
		expect(push.exitCode, push.stderr).toBe(0);
		const remoteRepo = await server.requireRepo(REPO_ID);
		const remoteHead = await resolveRef(remoteRepo, "refs/heads/main");
		expect(remoteHead).toBe(localHead.stdout.trim());
		if (!remoteHead) throw new Error("remote main ref did not advance");
		const remoteCommit = await readCommit(remoteRepo, remoteHead);
		expect(remoteCommit.author.name).toBe(IDENTITY.GIT_AUTHOR_NAME);
		expect(remoteCommit.author.email).toBe(IDENTITY.GIT_AUTHOR_EMAIL);
		expect(remoteCommit.committer.name).toBe(IDENTITY.GIT_COMMITTER_NAME);
		expect(remoteCommit.committer.email).toBe(IDENTITY.GIT_COMMITTER_EMAIL);
	});

	it("uses injected basic auth without per-exec credentials and rejects an uncredentialed push", async () => {
		const expectedAuthorization = `Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}`;
		const seenAuthorizations: Array<string | null> = [];
		const server = trackServer(
			createServer({
				onError: false,
				hooks: {
					preReceive: ({ auth }) => {
						const authorization = auth.request?.headers.get("authorization") ?? null;
						seenAuthorizations.push(authorization);
						if (authorization !== expectedAuthorization) {
							return { reject: true, message: "missing or invalid basic token" };
						}
					},
				},
			}),
		);
		await seedRemote(server);
		routeFetch(server);

		vi.stubEnv("GITHUB_TOKEN", TOKEN);
		const authenticatedManager = makeManager();
		const authenticated = await makeSession(authenticatedManager, { python: false, javascript: false, network: true });
		expect((await authenticated.session.bash.exec(`git clone ${BASE_URL}/${REPO_ID} /repo`)).exitCode).toBe(0);
		const authenticatedCommit = await authenticated.session.bash.exec(
			[
				"printf 'authenticated update\\n' >> README.md",
				"git add README.md",
				"git commit -m 'authenticated update'",
			].join(" && "),
			{ cwd: "/repo", env: IDENTITY },
		);
		expect(authenticatedCommit.exitCode, authenticatedCommit.stderr).toBe(0);
		const acceptedPush = await authenticated.session.bash.exec("git push origin main", { cwd: "/repo" });
		expect(acceptedPush.exitCode, acceptedPush.stderr).toBe(0);
		expect(seenAuthorizations).toEqual([expectedAuthorization]);

		vi.stubEnv("GITHUB_TOKEN", undefined);
		const anonymousManager = makeManager();
		const anonymous = await makeSession(anonymousManager, { python: false, javascript: false, network: true });
		expect((await anonymous.session.bash.exec(`git clone ${BASE_URL}/${REPO_ID} /repo`)).exitCode).toBe(0);
		const anonymousCommit = await anonymous.session.bash.exec(
			["printf 'rejected update\\n' >> README.md", "git add README.md", "git commit -m 'rejected update'"].join(" && "),
			{ cwd: "/repo", env: IDENTITY },
		);
		expect(anonymousCommit.exitCode, anonymousCommit.stderr).toBe(0);
		const rejectedPush = await anonymous.session.bash.exec("git push origin main", { cwd: "/repo" });
		expect(rejectedPush.exitCode).not.toBe(0);
		expect(rejectedPush.stderr).toMatch(/missing or invalid basic token|failed to push/i);
		expect(seenAuthorizations).toEqual([expectedAuthorization, null]);
	});

	it("rejects remote operations without network while local git still works", async () => {
		vi.stubEnv("GITHUB_TOKEN", TOKEN);
		const manager = makeManager();
		const { session } = await makeSession(manager, { python: false, javascript: false, network: false });

		const init = await session.bash.exec("git init /local");
		expect(init.exitCode, init.stderr).toBe(0);
		const commit = await session.bash.exec(
			["printf 'offline contents\\n' > local.txt", "git add local.txt", "git commit -m 'offline'"].join(" && "),
			{ cwd: "/local", env: IDENTITY },
		);
		expect(commit.exitCode, commit.stderr).toBe(0);

		const clone = await session.bash.exec(`git clone ${BASE_URL}/${REPO_ID} /remote`);
		expect(clone.exitCode).not.toBe(0);
		expect(clone.stderr.split("\n")[0]).toBe("fatal: network access is disabled");
		expect(clone.stderr).not.toMatch(/postgres|DATABASE_URL|gitbench_scratch/i);
	});
});

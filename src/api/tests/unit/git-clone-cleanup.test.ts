/**
 * A `git clone` that fails partway must not leave a half-built worktree behind.
 *
 * just-git writes the index in full while the checkout is still running, so an aborted clone
 * leaves a tree whose index claims files that were never written — `git status` then reports
 * them all as staged deletions, and the next `git add -A && git commit` records that as a real
 * deletion commit.
 *
 * The failure is driven through an in-process just-git remote plus a filesystem that starts
 * refusing writes mid-checkout, which is the same shape as the production failures (SqlFs denying
 * `symlink()`, or just-git refusing a symlink whose target escapes the worktree).
 */

import { Bash, InMemoryFs } from "just-bash";
import type { IFileSystem } from "just-bash";
import { type Auth, createServer } from "just-git/server";
import { beforeEach, describe, expect, it } from "vitest";
import { createGitCommand } from "../../commands/git-command.js";

const BASE_URL = "https://git.test";

type Server = ReturnType<typeof createServer<Auth>>;

async function makeRemote(): Promise<Server> {
	const server = createServer({ onError: false });
	await server.createRepo("project");
	await server.commit("project", {
		files: { "README.md": "# Project\n", "src/index.ts": "export const x = 1;\n" },
		message: "initial",
		author: { name: "Remote", email: "remote@example.com" },
		branch: "main",
	});
	return server;
}

/** Wraps a filesystem so `writeFile` starts throwing EPERM after `n` successful writes. */
function failWritesAfter(fs: InMemoryFs, n: number): IFileSystem {
	let writes = 0;
	return new Proxy(fs, {
		get(target, prop) {
			if (prop === "writeFile") {
				return async (...args: Parameters<IFileSystem["writeFile"]>): Promise<void> => {
					writes += 1;
					if (writes > n) throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
					return target.writeFile(...args);
				};
			}
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
		},
	}) as unknown as IFileSystem;
}

function makeBash(fs: IFileSystem, server: Server): Bash {
	return new Bash({ fs, customCommands: [createGitCommand({ network: server.asNetwork(BASE_URL) })] });
}

describe("git clone cleanup", () => {
	let server: Server;

	beforeEach(async () => {
		server = await makeRemote();
	});

	it("leaves the worktree in place when the clone succeeds", async () => {
		const fs = new InMemoryFs();
		const result = await makeBash(fs, server).exec(`git clone ${BASE_URL}/project /repo`);

		expect(result.exitCode, result.stderr).toBe(0);
		expect(await fs.exists("/repo")).toBe(true);
		expect(await fs.readFile("/repo/README.md", "utf8")).toBe("# Project\n");
	});

	it("removes the destination it created when the checkout fails partway", async () => {
		const inner = new InMemoryFs();
		const result = await makeBash(failWritesAfter(inner, 2), server).exec(`git clone ${BASE_URL}/project /repo`);

		expect(result.exitCode).not.toBe(0);
		expect(await inner.exists("/repo")).toBe(false);
	});

	it("reports the cleanup on stderr so the failure is not silent", async () => {
		const fs = failWritesAfter(new InMemoryFs(), 2);
		const result = await makeBash(fs, server).exec(`git clone ${BASE_URL}/project /repo`);

		expect(result.stderr).toContain("removed the incomplete checkout at '/repo'");
	});

	it("resolves the destination from git rather than from the argv it was given", async () => {
		const inner = new InMemoryFs();
		await inner.mkdir("/work", { recursive: true });
		const fs = failWritesAfter(inner, 2);
		const result = await makeBash(fs, server).exec(`cd /work && git clone ${BASE_URL}/project`);

		expect(result.exitCode).not.toBe(0);
		expect(await inner.exists("/work/project")).toBe(false);
		expect(await inner.exists("/work")).toBe(true);
	});

	it("cleans a bare clone at the path git actually created", async () => {
		const inner = new InMemoryFs();
		await inner.mkdir("/work", { recursive: true });
		const fs = failWritesAfter(inner, 2);
		const result = await makeBash(fs, server).exec(`cd /work && git clone --bare ${BASE_URL}/project.git`);

		expect(result.exitCode).not.toBe(0);
		// Whatever name just-git chose, nothing may survive inside the parent.
		expect(await inner.readdir("/work")).toEqual([]);
	});

	it("empties a pre-existing empty destination, keeping the directory itself", async () => {
		const inner = new InMemoryFs();
		await inner.mkdir("/repo", { recursive: true });
		const fs = failWritesAfter(inner, 2);

		const result = await makeBash(fs, server).exec(`cd /repo && git clone ${BASE_URL}/project .`);

		expect(result.exitCode).not.toBe(0);
		expect(await inner.exists("/repo")).toBe(true);
		// The poisoned index is the whole problem — it must not survive.
		expect(await inner.readdir("/repo")).toEqual([]);
	});

	it("never deletes a destination that already held files", async () => {
		const inner = new InMemoryFs();
		await inner.mkdir("/repo", { recursive: true });
		await inner.writeFile("/repo/keep.txt", "precious");
		const fs = failWritesAfter(inner, 2);

		const result = await makeBash(fs, server).exec(`git clone ${BASE_URL}/project /repo`);

		expect(result.exitCode).not.toBe(0);
		expect(await inner.readFile("/repo/keep.txt", "utf8")).toBe("precious");
	});

	it("leaves the filesystem alone when a non-clone subcommand fails", async () => {
		const inner = new InMemoryFs();
		await inner.mkdir("/repo", { recursive: true });
		await inner.writeFile("/repo/file.txt", "content");

		const result = await makeBash(inner, server).exec("cd /repo && git status");

		expect(result.exitCode).not.toBe(0);
		expect(await inner.readFile("/repo/file.txt", "utf8")).toBe("content");
	});

	it("lets git report a destination that is an existing file", async () => {
		const fs = new InMemoryFs();
		await fs.writeFile("/dest", "i am a file\n");

		const result = await makeBash(fs, server).exec(`git clone ${BASE_URL}/project /dest`);

		// The pre-clone hook must not readdir a non-directory: that threw `ENOTDIR … scandir`
		// out of the hook before git could produce its own message.
		expect(result.stderr).toBe("fatal: destination path '/dest' already exists and is not an empty directory.\n");
		expect(result.exitCode).toBe(128);
		expect(await fs.readFile("/dest", "utf8")).toBe("i am a file\n");
	});

	it("leaves no residue when the transport is refused", async () => {
		const fs = new InMemoryFs();
		const offline = new Bash({ fs, customCommands: [createGitCommand({ network: false })] });

		// just-git creates the destination and its .git before it discovers the network is off.
		const result = await offline.exec(`git clone ${BASE_URL}/project /repo`);

		expect(result.exitCode).not.toBe(0);
		expect(await fs.exists("/repo")).toBe(false);
	});
});

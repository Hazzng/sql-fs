import { InMemoryFs, createCommandContext } from "just-bash";
import type { ExecResult } from "just-bash";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGitCommand } from "../../commands/git-command.js";

const upstream = vi.hoisted(() => ({ execute: vi.fn() }));

// Keep the filesystem and wrapper real; control only the upstream command's failure points.
vi.mock("just-git", () => ({ createGit: () => ({ execute: upstream.execute }) }));

const LISTING: ExecResult = {
	stdout: `100755 ${"a".repeat(40)} 0\trun.sh\0`,
	stderr: "",
	exitCode: 0,
};

describe("git mode repair on failures", () => {
	let fs: InMemoryFs;
	let ctx: ReturnType<typeof createCommandContext>;

	beforeEach(async () => {
		upstream.execute.mockReset();
		fs = new InMemoryFs();
		await fs.mkdir("/repo/.git", { recursive: true });
		ctx = createCommandContext({ fs, cwd: "/repo" });
	});

	async function writeExecutable(gitCtx: typeof ctx): Promise<void> {
		await gitCtx.fs.writeFile("/repo/run.sh", "#!/bin/bash\necho ran\n");
		await gitCtx.fs.chmod("/repo/run.sh", 0o644);
	}

	it("repairs a partial checkout before rethrowing its original error", async () => {
		const error = new Error("checkout refused a symlink");
		upstream.execute.mockImplementation(async (args: string[], gitCtx: typeof ctx) => {
			if (args[0] === "ls-files") return LISTING;
			await writeExecutable(gitCtx);
			throw error;
		});

		await expect(createGitCommand({ network: false }).execute(["checkout", "main"], ctx)).rejects.toBe(error);
		expect((await fs.stat("/repo/run.sh")).mode & 0o777).toBe(0o755);
	});

	it("repairs files after a nonzero result while retaining that result", async () => {
		const result: ExecResult = { stdout: "conflict\n", stderr: "merge failed\n", exitCode: 1 };
		upstream.execute.mockImplementation(async (args: string[], gitCtx: typeof ctx) => {
			if (args[0] === "ls-files") return LISTING;
			await writeExecutable(gitCtx);
			return result;
		});

		expect(await createGitCommand({ network: false }).execute(["merge", "other"], ctx)).toBe(result);
		expect((await fs.stat("/repo/run.sh")).mode & 0o777).toBe(0o755);
	});

	it.each([0, 1])("retains exit %i when reading index modes throws", async (exitCode) => {
		const result: ExecResult = { stdout: "original output\n", stderr: "original error\n", exitCode };
		upstream.execute.mockImplementation(async (args: string[], gitCtx: typeof ctx) => {
			if (args[0] === "ls-files") throw new Error("unreadable index");
			await writeExecutable(gitCtx);
			return result;
		});

		expect(await createGitCommand({ network: false }).execute(["checkout", "main"], ctx)).toBe(result);
	});

	it("retains the original checkout exception when mode repair also throws", async () => {
		const error = new Error("original checkout failure");
		upstream.execute.mockImplementation(async (args: string[], gitCtx: typeof ctx) => {
			if (args[0] === "ls-files") throw new Error("secondary index failure");
			await writeExecutable(gitCtx);
			throw error;
		});

		await expect(createGitCommand({ network: false }).execute(["checkout", "main"], ctx)).rejects.toBe(error);
		expect(upstream.execute).toHaveBeenCalledTimes(2);
	});

	it.each(["lookup", "stat", "chmod"])(
		"retains git's result when filesystem %s fails during repair",
		async (failure) => {
			const result: ExecResult = { stdout: "checked out\n", stderr: "", exitCode: 0 };
			upstream.execute.mockImplementation(async (args: string[], gitCtx: typeof ctx) => {
				if (args[0] === "ls-files") return LISTING;
				await writeExecutable(gitCtx);
				if (failure === "lookup") vi.spyOn(fs, "exists").mockRejectedValue(new Error("lookup failed"));
				if (failure === "stat") vi.spyOn(fs, "stat").mockRejectedValue(new Error("stat failed"));
				if (failure === "chmod") vi.spyOn(fs, "chmod").mockRejectedValue(new Error("chmod failed"));
				return result;
			});

			expect(await createGitCommand({ network: false }).execute(["checkout", "main"], ctx)).toBe(result);
		},
	);
});

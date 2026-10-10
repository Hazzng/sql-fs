import { InMemoryFs, createCommandContext } from "just-bash";
import type { ExecResult } from "just-bash";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGitCommand } from "../../commands/git-command.js";

const upstream = vi.hoisted(() => ({
	execute: vi.fn(),
	findRepo: vi.fn(),
	beforeCommand: undefined as ((event: { command: string; args: string[] }) => void) | undefined,
}));

// Keep the filesystem and wrapper real; control only the upstream command's failure points.
vi.mock("just-git", () => ({
	createGit: (options: { hooks: { beforeCommand: typeof upstream.beforeCommand } }) => {
		upstream.beforeCommand = options.hooks.beforeCommand;
		return { execute: upstream.execute, findRepo: upstream.findRepo };
	},
}));

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
		upstream.findRepo.mockReset();
		upstream.beforeCommand = undefined;
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

	// Listing fixtures isolate the index-stage selector while retaining real filesystem modes.
	it.each([
		{
			name: "ours changed",
			stages: [
				[1, "100644"],
				[2, "100755"],
				[3, "100644"],
			],
			expected: 0o755,
		},
		{
			name: "theirs changed",
			stages: [
				[1, "100644"],
				[2, "100644"],
				[3, "100755"],
			],
			expected: 0o755,
		},
		{
			name: "ours removed executable",
			stages: [
				[1, "100755"],
				[2, "100644"],
				[3, "100755"],
			],
			expected: 0o644,
		},
		{
			name: "both agree",
			stages: [
				[1, "100755"],
				[2, "100644"],
				[3, "100644"],
			],
			expected: 0o644,
		},
		{
			name: "add/add executable ours",
			stages: [
				[2, "100755"],
				[3, "100644"],
			],
			expected: 0o755,
		},
		{
			name: "add/add plain ours",
			stages: [
				[2, "100644"],
				[3, "100755"],
			],
			expected: 0o644,
		},
		{
			name: "ours survives deletion",
			stages: [
				[1, "100644"],
				[2, "100755"],
			],
			expected: 0o755,
		},
		{
			name: "theirs survives deletion",
			stages: [
				[1, "100644"],
				[3, "100755"],
			],
			expected: 0o755,
		},
		{
			name: "stage order differs",
			stages: [
				[3, "100755"],
				[2, "100644"],
				[1, "100755"],
			],
			expected: 0o644,
		},
		{
			name: "symlink base became regular",
			stages: [
				[1, "120000"],
				[2, "100755"],
				[3, "100644"],
			],
			expected: 0o755,
		},
		{
			name: "gitlink base became regular",
			stages: [
				[1, "160000"],
				[2, "100644"],
				[3, "100755"],
			],
			expected: 0o644,
		},
	])("merges staged modes ($name) and retains the nonzero result", async ({ stages, expected }) => {
		const result: ExecResult = { stdout: "conflict\n", stderr: "original merge error\n", exitCode: 1 };
		const stdout = stages.map(([stage, mode]) => `${mode} ${"a".repeat(40)} ${stage}\trun.sh\0`).join("");
		upstream.execute.mockImplementation(async (args: string[], gitCtx: typeof ctx) => {
			if (args[0] === "ls-files") return { stdout, stderr: "", exitCode: 0 };
			await writeExecutable(gitCtx);
			await gitCtx.fs.chmod("/repo/run.sh", expected === 0o755 ? 0o644 : 0o755);
			return result;
		});

		expect(await createGitCommand({ network: false }).execute(["merge", "other"], ctx)).toBe(result);
		expect((await fs.stat("/repo/run.sh")).mode & 0o777).toBe(expected);
	});

	it.each([
		{ name: "base alone", stages: [[1, "100755"]] },
		{
			name: "symlink ours",
			stages: [
				[2, "120000"],
				[3, "100755"],
			],
		},
		{
			name: "symlink theirs",
			stages: [
				[2, "100755"],
				[3, "120000"],
			],
		},
		{
			name: "gitlink ours",
			stages: [
				[2, "160000"],
				[3, "100755"],
			],
		},
		{ name: "resolved symlink", stages: [[0, "120000"]] },
	])("skips unsupported mode repair ($name)", async ({ stages }) => {
		const result: ExecResult = { stdout: "conflict\n", stderr: "", exitCode: 1 };
		const stdout = stages.map(([stage, mode]) => `${mode} ${"a".repeat(40)} ${stage}\trun.sh\0`).join("");
		upstream.execute.mockImplementation(async (args: string[], gitCtx: typeof ctx) => {
			if (args[0] === "ls-files") return { stdout, stderr: "", exitCode: 0 };
			await writeExecutable(gitCtx);
			return result;
		});

		expect(await createGitCommand({ network: false }).execute(["merge", "other"], ctx)).toBe(result);
		expect((await fs.stat("/repo/run.sh")).mode & 0o777).toBe(0o644);
	});

	it("does not chmod a symlink's target when the recorded write is no longer a regular file", async () => {
		const result: ExecResult = { stdout: "conflict\n", stderr: "", exitCode: 1 };
		const chmod = vi.spyOn(fs, "chmod");
		upstream.execute.mockImplementation(async (args: string[], gitCtx: typeof ctx) => {
			if (args[0] === "ls-files") return LISTING;
			await writeExecutable(gitCtx);
			await fs.writeFile("/repo/target", "target");
			await fs.chmod("/repo/target", 0o644);
			await fs.rm("/repo/run.sh");
			await fs.symlink("target", "/repo/run.sh");
			chmod.mockClear();
			return result;
		});

		expect(await createGitCommand({ network: false }).execute(["merge", "other"], ctx)).toBe(result);
		expect((await fs.lstat("/repo/run.sh")).isSymbolicLink).toBe(true);
		expect((await fs.stat("/repo/target")).mode & 0o777).toBe(0o644);
		expect(chmod).not.toHaveBeenCalled();
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

	it.each([0, 1])("retains exit %i when source tree lookup throws", async (exitCode) => {
		const result: ExecResult = { stdout: "original restore output\n", stderr: "original restore error\n", exitCode };
		upstream.findRepo.mockRejectedValue(new Error("source lookup failed"));
		upstream.execute.mockImplementation(async (_args: string[], gitCtx: typeof ctx) => {
			upstream.beforeCommand?.({ command: "restore", args: ["--source=other", "run.sh"] });
			await writeExecutable(gitCtx);
			return result;
		});

		expect(await createGitCommand({ network: false }).execute(["restore", "--source=other", "run.sh"], ctx)).toBe(
			result,
		);
		expect(upstream.findRepo).toHaveBeenCalledTimes(1);
	});

	it("retains the original restore exception when source tree lookup also throws", async () => {
		const error = new Error("original restore failure");
		upstream.findRepo.mockRejectedValue(new Error("source lookup failed"));
		upstream.execute.mockImplementation(async (_args: string[], gitCtx: typeof ctx) => {
			upstream.beforeCommand?.({ command: "restore", args: ["--source=other", "run.sh"] });
			await writeExecutable(gitCtx);
			throw error;
		});

		await expect(
			createGitCommand({ network: false }).execute(["restore", "--source=other", "run.sh"], ctx),
		).rejects.toBe(error);
		expect(upstream.findRepo).toHaveBeenCalledTimes(1);
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

	it.each(["lookup", "lstat", "chmod"])(
		"retains git's result when filesystem %s fails during repair",
		async (failure) => {
			const result: ExecResult = { stdout: "checked out\n", stderr: "", exitCode: 0 };
			upstream.execute.mockImplementation(async (args: string[], gitCtx: typeof ctx) => {
				if (args[0] === "ls-files") return LISTING;
				await writeExecutable(gitCtx);
				if (failure === "lookup") vi.spyOn(fs, "exists").mockRejectedValue(new Error("lookup failed"));
				if (failure === "lstat") vi.spyOn(fs, "lstat").mockRejectedValue(new Error("lstat failed"));
				if (failure === "chmod") vi.spyOn(fs, "chmod").mockRejectedValue(new Error("chmod failed"));
				return result;
			});

			expect(await createGitCommand({ network: false }).execute(["checkout", "main"], ctx)).toBe(result);
		},
	);
});

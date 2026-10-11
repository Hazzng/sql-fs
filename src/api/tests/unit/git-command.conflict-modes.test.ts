import { beforeEach, describe, expect, it } from "vitest";
import { type BashOverSqlFs, bashOverSqlFs } from "../../../sql-fs/tests/fixtures/bash-over-sqlfs.js";
import { createGitCommand } from "../../commands/git-command.js";

const IDENTITY = {
	GIT_AUTHOR_NAME: "a",
	GIT_AUTHOR_EMAIL: "a@b.c",
	GIT_COMMITTER_NAME: "a",
	GIT_COMMITTER_EMAIL: "a@b.c",
};

const THREE_WAY_MODES = [
	[644, 644, 644, 644],
	[644, 644, 755, 755],
	[644, 755, 644, 755],
	[644, 755, 755, 755],
	[755, 644, 644, 644],
	[755, 644, 755, 644],
	[755, 755, 644, 644],
	[755, 755, 755, 755],
] as const;

describe("git wrapper — modes of files with merge conflicts", () => {
	let env: BashOverSqlFs;

	beforeEach(async () => {
		env = await bashOverSqlFs({ env: IDENTITY, customCommands: [createGitCommand({ network: false })] });
	});

	async function prepare(base: number | undefined, ours: number, theirs: number): Promise<void> {
		const seed = base === undefined ? "echo anchor > anchor" : `echo base > run.sh && chmod ${base} run.sh`;
		const commands = [
			"mkdir repo && cd repo && git init -q",
			seed,
			"git add -A && git commit -q -m base",
			"git checkout -q -b ours",
			`echo ours > run.sh && chmod ${ours} run.sh && git add run.sh && git commit -q -m ours`,
			"git checkout -q -b theirs main",
			`echo theirs > run.sh && chmod ${theirs} run.sh && git add run.sh && git commit -q -m theirs`,
			"git checkout -q ours",
		];
		const result = await env.bash.exec(commands.join(" && "));
		expect(result.exitCode, result.stderr).toBe(0);
	}

	async function expectResolvedMode(expectedMode: number): Promise<void> {
		expect((await env.fs.stat("/home/user/repo/run.sh")).mode & 0o777).toBe(Number.parseInt(`${expectedMode}`, 8));

		const resolved = await env.bash.exec(
			"cd repo && echo resolved > run.sh && git add run.sh && git ls-files -s run.sh",
		);
		expect(resolved.exitCode, resolved.stderr).toBe(0);
		expect(resolved.stdout).toMatch(new RegExp(`^100${expectedMode} [a-f0-9]{40} 0\\trun\\.sh\\n$`));
	}

	async function mergeAndResolve(expectedMode: number): Promise<void> {
		const result = await env.bash.exec("cd repo && git merge theirs");
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain("CONFLICT");
		await expectResolvedMode(expectedMode);
	}

	it.each(THREE_WAY_MODES)(
		"merges base %i, ours %i, theirs %i to worktree mode %i",
		async (base, ours, theirs, expected) => {
			await prepare(base, ours, theirs);
			await mergeAndResolve(expected);
		},
	);

	it.each([
		[644, 644],
		[644, 755],
		[755, 644],
		[755, 755],
	])("keeps ours %i in an add/add conflict with theirs %i", async (ours, theirs) => {
		await prepare(undefined, ours, theirs);
		await mergeAndResolve(ours);
	});

	it.each(
		["checkout", "restore"].flatMap((command) =>
			["ours", "theirs"].flatMap((side) => [
				{ command, side, ours: 755, theirs: 644 },
				{ command, side, ours: 644, theirs: 755 },
			]),
		),
	)(
		"uses the requested stage for $command --$side (ours $ours, theirs $theirs)",
		async ({ command, side, ours, theirs }) => {
			await prepare(644, ours, theirs);
			expect((await env.bash.exec("cd repo && git merge theirs")).exitCode).toBe(1);
			// The hook receives this subcommand after just-git consumes the global options.
			const result = await env.bash.exec(`git -C repo -c core.filemode=true ${command} --${side} -- run.sh`);
			expect(result.exitCode, result.stderr).toBe(0);
			expect(await env.fs.readFile("/home/user/repo/run.sh")).toBe(`${side}\n`);
			const unmerged = await env.bash.exec("cd repo && git ls-files -s run.sh");
			expect(unmerged.exitCode, unmerged.stderr).toBe(0);
			expect(unmerged.stdout).toMatch(/ 2\trun\.sh\n/);
			expect(unmerged.stdout).toMatch(/ 3\trun\.sh\n/);
			await expectResolvedMode(side === "ours" ? ours : theirs);
		},
	);

	it.each(
		["checkout", "restore"].flatMap((command) => [
			{ command, options: "--ours=true", side: "ours", ours: 644, theirs: 755 },
			{ command, options: "--ours=false", side: "ours", ours: 644, theirs: 755 },
			{ command, options: "--theirs=true", side: "theirs", ours: 755, theirs: 644 },
			{ command, options: "--theirs=false", side: "theirs", ours: 755, theirs: 644 },
			{ command, options: "--ours --no-ours --theirs=0", side: "theirs", ours: 755, theirs: 644 },
			{ command, options: "--theirs --no-theirs --ours=1", side: "ours", ours: 644, theirs: 755 },
			{ command, options: "--ours --no-ours=true --theirs=", side: "theirs", ours: 755, theirs: 644 },
			{ command, options: "--theirs --no-theirs=false --ours=1", side: "ours", ours: 644, theirs: 755 },
		]),
	)("matches upstream flag handling for $command $options", async ({ command, options, side, ours, theirs }) => {
		await prepare(644, ours, theirs);
		expect((await env.bash.exec("cd repo && git merge theirs")).exitCode).toBe(1);
		const result = await env.bash.exec(`git -C repo ${command} ${options} -- run.sh`);
		expect(result.exitCode, result.stderr).toBe(0);
		expect(await env.fs.readFile("/home/user/repo/run.sh")).toBe(`${side}\n`);
		await expectResolvedMode(side === "ours" ? ours : theirs);
	});

	it.each([
		"--source=theirs",
		"--source theirs",
		"-s theirs",
		"-stheirs",
		"-Wstheirs",
		"-Ws theirs",
		"-qWstheirs",
		"--worktree --source=theirs",
	])("uses the source tree mode for restore %s while the index remains unmerged", async (options) => {
		await prepare(644, 755, 644);
		expect((await env.bash.exec("cd repo && git merge theirs")).exitCode).toBe(1);
		const result = await env.bash.exec(`git -C repo restore ${options} -- run.sh`);
		expect(result.exitCode, result.stderr).toBe(0);
		expect(await env.fs.readFile("/home/user/repo/run.sh")).toBe("theirs\n");
		const unmerged = await env.bash.exec("cd repo && git ls-files -s run.sh");
		expect(unmerged.exitCode, unmerged.stderr).toBe(0);
		expect(unmerged.stdout).toMatch(/ 2\trun\.sh\n/);
		expect(unmerged.stdout).toMatch(/ 3\trun\.sh\n/);
		await expectResolvedMode(644);
	});

	it("uses the updated stage0 mode after checkout of a revision and path", async () => {
		await prepare(644, 755, 644);
		expect((await env.bash.exec("cd repo && git merge theirs")).exitCode).toBe(1);
		const result = await env.bash.exec("git -C repo checkout theirs -- run.sh");
		expect(result.exitCode, result.stderr).toBe(0);
		expect(await env.fs.readFile("/home/user/repo/run.sh")).toBe("theirs\n");
		await expectResolvedMode(644);
	});

	it.each([
		[644, 644, "ours"],
		[644, 755, "ours"],
		[755, 644, "ours"],
		[755, 755, "ours"],
		[644, 644, "theirs"],
		[644, 755, "theirs"],
		[755, 644, "theirs"],
		[755, 755, "theirs"],
	] as const)("keeps the surviving side in modify/delete: base %i, survivor %i on %s", async (base, mode, side) => {
		const modify = `echo modified > run.sh && chmod ${mode} run.sh && git add run.sh`;
		const commands = [
			"mkdir repo && cd repo && git init -q",
			`echo base > run.sh && chmod ${base} run.sh && git add run.sh && git commit -q -m base`,
			"git checkout -q -b ours",
			side === "ours" ? modify : "git rm run.sh",
			"git commit -q -m ours && git checkout -q -b theirs main",
			side === "theirs" ? modify : "git rm run.sh",
			"git commit -q -m theirs && git checkout -q ours",
		];
		const result = await env.bash.exec(commands.join(" && "));
		expect(result.exitCode, result.stderr).toBe(0);
		await mergeAndResolve(mode);
	});
});

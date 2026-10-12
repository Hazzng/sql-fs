import { Bash } from "just-bash";
import { beforeEach, describe, expect, it } from "vitest";
import { SqlFs } from "../../sql-fs.js";
import { BUFFER_ON, makeProbeDialect } from "../fixtures/buffered-dialect.js";

describe("bash over SqlFs — ls -l modes and mv onto the same file", () => {
	let fs: SqlFs;
	let bash: Bash;

	async function execInScriptScope(script: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		fs.beginScriptScope();
		try {
			const r = await bash.exec(script);
			return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
		} finally {
			await fs.endScriptScope();
		}
	}

	beforeEach(async () => {
		fs = new SqlFs({ dialect: makeProbeDialect().dialect, sandboxId: "s-ls-mv", scriptTxBuffer: BUFFER_ON });
		await fs.ready();
		bash = new Bash({ cwd: "/home/user", fs });
	});

	it("shows -rw-r--r-- for a new file", async () => {
		expect(await execInScriptScope("echo x > a; ls -l a | cut -d' ' -f1")).toEqual({
			stdout: "-rw-r--r--\n",
			stderr: "",
			exitCode: 0,
		});
	});

	it("shows the chmod'd mode for a file operand", async () => {
		expect(await execInScriptScope("echo x > a; chmod 755 a; ls -l a | cut -d' ' -f1")).toEqual({
			stdout: "-rwxr-xr-x\n",
			stderr: "",
			exitCode: 0,
		});
	});

	it("shows each entry's mode in a directory listing", async () => {
		expect(
			await execInScriptScope("mkdir d; echo x > d/f; chmod 600 d/f; ls -l d | tail -n 1 | cut -d' ' -f1"),
		).toEqual({
			stdout: "-rw-------\n",
			stderr: "",
			exitCode: 0,
		});
	});

	it("shows a directory's own mode with -d", async () => {
		expect(await execInScriptScope("mkdir d; chmod 750 d; ls -ld d | cut -d' ' -f1")).toEqual({
			stdout: "drwxr-x---\n",
			stderr: "",
			exitCode: 0,
		});
	});

	it("rejects mv onto the same file with GNU's message", async () => {
		expect(await execInScriptScope("echo x > a; mv a ./a")).toEqual({
			stdout: "",
			stderr: "mv: 'a' and './a' are the same file\n",
			exitCode: 1,
		});
	});

	it("names the joined target when mv moves a file into its own directory", async () => {
		expect(await execInScriptScope("echo x > a; mv a ./")).toEqual({
			stdout: "",
			stderr: "mv: 'a' and './a' are the same file\n",
			exitCode: 1,
		});
	});

	it("leaves the file intact after a same-file mv", async () => {
		expect(await execInScriptScope("echo x > a; mv a ./a; cat a")).toEqual({
			stdout: "x\n",
			stderr: "mv: 'a' and './a' are the same file\n",
			exitCode: 0,
		});
	});

	it("still renames a file to a new name", async () => {
		expect(await execInScriptScope("echo x > a; mv a b; cat b; test -e a; echo a=$?")).toEqual({
			stdout: "x\na=1\n",
			stderr: "",
			exitCode: 0,
		});
	});
});

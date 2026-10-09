/**
 * Output redirects whose target cannot be created (vercel-labs/just-bash#557).
 *
 * SqlFs throws ENOENT for a missing parent directory, as POSIX does. just-bash
 * 3.0.1 let that error reject `bash.exec()`, which failed the whole request and
 * rolled back the script; inside a loop it was swallowed and the loop abandoned.
 * The patch turns ENOENT/ENOTDIR into the shell diagnostic bash prints. Every
 * other error must still reject: EREADONLY, ESCRIPTBUFFER, ELOCKLOST and EFBIG
 * carry meaning the API layer depends on.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { readOnlyContext } from "../../../api/read-only-context.js";
import { type BashOverSqlFs, bashOverSqlFs } from "../fixtures/bash-over-sqlfs.js";

describe("bash over SqlFs — redirect target errors (just-bash#557)", () => {
	let env: BashOverSqlFs;

	beforeEach(async () => {
		env = await bashOverSqlFs();
	});

	it("reports > into a missing directory and continues with $? = 1", async () => {
		const r = await env.bash.exec("echo x > /home/user/missing/f; echo after rc=$?");
		expect({ stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode }).toEqual({
			stdout: "after rc=1\n",
			stderr: "bash: /home/user/missing/f: No such file or directory\n",
			exitCode: 0,
		});
	});

	it("reports >> into a missing directory", async () => {
		const r = await env.bash.exec("echo x >> /home/user/missing/f; echo after rc=$?");
		expect({ stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode }).toEqual({
			stdout: "after rc=1\n",
			stderr: "bash: /home/user/missing/f: No such file or directory\n",
			exitCode: 0,
		});
	});

	it("reports 2> into a missing directory", async () => {
		const r = await env.bash.exec("echo x 2> /home/user/missing/f; echo after rc=$?");
		expect({ stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode }).toEqual({
			stdout: "after rc=1\n",
			stderr: "bash: /home/user/missing/f: No such file or directory\n",
			exitCode: 0,
		});
	});

	it("reports a loop redirected into a missing directory", async () => {
		const r = await env.bash.exec("for c in a; do echo $c; done > /home/user/missing/f; echo after rc=$?");
		expect({ stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode }).toEqual({
			stdout: "after rc=1\n",
			stderr: "bash: /home/user/missing/f: No such file or directory\n",
			exitCode: 0,
		});
	});

	it("runs every loop iteration when each one hits a missing directory", async () => {
		const r = await env.bash.exec(
			"for c in a b; do echo $c > /home/user/missing/f; echo iter $c; done; echo after rc=$?",
		);
		expect({ stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode }).toEqual({
			stdout: "iter a\niter b\nafter rc=0\n",
			stderr:
				"bash: /home/user/missing/f: No such file or directory\nbash: /home/user/missing/f: No such file or directory\n",
			exitCode: 0,
		});
	});

	it("reports a path through a regular file as Not a directory", async () => {
		const r = await env.bash.exec("echo x > /home/user/file.txt/f; echo after rc=$?");
		expect({ stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode }).toEqual({
			stdout: "after rc=1\n",
			stderr: "bash: /home/user/file.txt/f: Not a directory\n",
			exitCode: 0,
		});
	});

	it("still rejects exec() for a filesystem policy error", async () => {
		env.fs.beginReadOnlyScope();
		try {
			await readOnlyContext.run({ violated: false }, async () => {
				await expect(env.bash.exec("echo x > /home/user/new.txt")).rejects.toMatchObject({ code: "EREADONLY" });
			});
		} finally {
			env.fs.endReadOnlyScope();
		}
	});
});

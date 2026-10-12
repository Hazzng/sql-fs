/**
 * `&>` / `&>>` to /dev/stdout and /dev/stderr (vercel-labs/just-bash#562).
 *
 * just-bash 3.6 handles `> /dev/stderr` as a stream but sends `&> /dev/stderr` through the
 * filesystem, and SqlFs has no `/dev`, so the whole exec rejected with ENOENT. The local
 * just-bash patch routes both operators to the current stdout/stderr sink, as #562 does.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { type BashOverSqlFs, bashOverSqlFs } from "../fixtures/bash-over-sqlfs.js";

describe("bash over SqlFs — &> and &>> to /dev/stdout and /dev/stderr", () => {
	let env: BashOverSqlFs;

	async function run(script: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		const r = await env.bash.exec(script);
		return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
	}

	beforeEach(async () => {
		env = await bashOverSqlFs();
	});

	it("sends both streams to stderr with &> /dev/stderr", async () => {
		expect(await run("{ echo out; echo err >&2; } &> /dev/stderr")).toEqual({
			stdout: "",
			stderr: "out\nerr\n",
			exitCode: 0,
		});
	});

	it("sends both streams to stdout with &> /dev/stdout", async () => {
		expect(await run("{ echo out; echo err >&2; } &> /dev/stdout")).toEqual({
			stdout: "out\nerr\n",
			stderr: "",
			exitCode: 0,
		});
	});

	it("handles &>> like &>", async () => {
		expect(await run("echo g &>> /dev/stdout; echo h &>> /dev/stderr")).toEqual({
			stdout: "g\n",
			stderr: "h\n",
			exitCode: 0,
		});
	});

	it("keeps the command's exit status", async () => {
		const r = await run("ls /nope &> /dev/stdout; echo rc=$?");
		expect(r.stdout.endsWith("rc=2\n")).toBe(true);
		expect(r.stderr).toBe("");
	});

	it("never writes the device paths into the filesystem", async () => {
		await run("echo a &> /dev/stdout; echo b &>> /dev/stderr; echo c &> /dev/null");
		expect(env.probe.calls).toEqual([]);
	});

	it("still writes &> to a regular file", async () => {
		expect(await run("{ echo out; echo err >&2; } &> both.txt; wc -l < both.txt")).toEqual({
			stdout: "2\n",
			stderr: "",
			exitCode: 0,
		});
	});
});

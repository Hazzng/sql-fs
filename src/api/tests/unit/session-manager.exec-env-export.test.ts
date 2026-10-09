/**
 * Per-request env must reach child shells. just-bash 3.6 sets `exec` env as shell variables
 * without exporting them, so `bash -c` and `bash script.sh` saw them empty (fixed upstream in
 * vercel-labs/just-bash#439, not yet released). The session manager exports the names itself.
 */

import { InMemoryFs } from "just-bash";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager, exportExecEnv } from "../../session-manager.js";

const T = "default";

describe("per-request env reaches child shells", () => {
	let sm: SessionManager;
	let sandboxId: string;
	let fs: InMemoryFs;

	async function exec(script: string, env?: Record<string, string>): Promise<{ stdout: string; stderr: string }> {
		const r = await sm.withSession(T, sandboxId, (s) =>
			sm.execWithRuntimeThrottle(s, script, env ? { env } : undefined),
		);
		return { stdout: r.stdout, stderr: r.stderr };
	}

	beforeEach(async () => {
		fs = new InMemoryFs();
		sm = new SessionManager({ createFs: async () => fs });
		sandboxId = `sb-env-${Math.random().toString(36).slice(2)}`;
		await sm.getOrCreate(T, sandboxId);
	});

	afterEach(async () => {
		await sm.shutdown();
	});

	it("reaches bash -c", async () => {
		expect(await exec("bash -c 'echo foo=$FOO'", { FOO: "bar" })).toEqual({ stdout: "foo=bar\n", stderr: "" });
	});

	it("reaches a script run with bash", async () => {
		await exec("echo 'echo foo=$FOO' > /tmp/s.sh");
		expect(await exec("bash /tmp/s.sh", { FOO: "bar" })).toEqual({ stdout: "foo=bar\n", stderr: "" });
	});

	it("does not leak into the next exec", async () => {
		await exec("true", { FOO: "bar" });
		expect(await exec("bash -c 'echo foo=$FOO'")).toEqual({ stdout: "foo=\n", stderr: "" });
	});

	it("keeps line numbers unchanged", async () => {
		expect((await exec("echo $LINENO\necho $LINENO", { FOO: "bar" })).stdout).toBe("1\n2\n");
	});

	it("never turns an env key into shell code", async () => {
		const r = await exec("echo ran", { "X;touch /tmp/pwned": "v", FOO: "bar" });
		expect(r.stdout).toBe("ran\n");
		expect(await fs.exists("/tmp/pwned")).toBe(false);
	});
});

describe("exportExecEnv", () => {
	it("exports only valid variable names", () => {
		expect(exportExecEnv("echo hi", { FOO: "1", _bar2: "2", "1X": "3", "A-B": "4", "X;rm -rf /": "5" })).toBe(
			"export FOO _bar2; echo hi",
		);
	});

	it("leaves the script alone without env", () => {
		expect(exportExecEnv("echo hi", undefined)).toBe("echo hi");
		expect(exportExecEnv("echo hi", { "A-B": "x" })).toBe("echo hi");
	});
});

/**
 * The local just-bash patch exports valid per-request env names without adding shell commands.
 * Drop the patch once a release carries vercel-labs/just-bash#439.
 */

import { Bash, InMemoryFs } from "just-bash";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../session-manager.js";

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
		vi.restoreAllMocks();
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

	it("does not export a later shell variable with a previously supplied env name", async () => {
		await exec("true", { FOO: "bar" });
		expect(await exec("FOO=private; bash -c 'echo foo=$FOO'")).toEqual({ stdout: "foo=\n", stderr: "" });
	});

	it("does not persist export -n into the next exec", async () => {
		await exec("export -n HOME", { FOO: "bar" });
		expect(await exec("bash -c 'echo home=$HOME'")).toEqual({ stdout: "home=/home/user\n", stderr: "" });
	});

	for (const wrapper of ["env", "time", "timeout 5"]) {
		it(`exports request env through ${wrapper}`, async () => {
			const result = await exec(`${wrapper} bash -c 'echo foo=$FOO'`, { FOO: "bar" });
			expect(result.stdout).toBe("foo=bar\n");
		});

		it(`does not export script-local variables through ${wrapper}`, async () => {
			const result = await exec(`PRIVATE=secret; ${wrapper} bash -c 'echo private=$PRIVATE'`, { FOO: "bar" });
			expect(result.stdout).toBe("private=\n");
		});

		it(`inherits prefix assignments through ${wrapper}`, async () => {
			const result = await exec(`FOO=prefix ${wrapper} bash -c 'echo foo=$FOO'`, { MARKER: "request" });
			expect(result.stdout).toBe("foo=prefix\n");
		});
	}

	it("honors export -n before a child shell", async () => {
		expect(await exec("export -n FOO; bash -c 'echo foo=$FOO'", { FOO: "bar" })).toEqual({
			stdout: "foo=\n",
			stderr: "",
		});
	});

	it.each([
		["SHELLOPTS", "set -e", "braceexpand:errexit:hashall:interactive-comments"],
		["BASHOPTS", "shopt -s nullglob", "globskipdots:nullglob"],
	] as const)("keeps exported %s in a child shell", async (name, configure, inherited) => {
		expect(await exec(`${configure}; export ${name}; bash -c 'echo "$${name}"'`, { FOO: "bar" })).toEqual({
			stdout: `${inherited}\n`,
			stderr: "",
		});
	});

	it.each([
		["SHELLOPTS", "set -e", "braceexpand:hashall:interactive-comments"],
		["BASHOPTS", "shopt -s nullglob", "globskipdots"],
	] as const)("uses the startup default for unexported %s", async (name, configure, defaultValue) => {
		expect(await exec(`${configure}; bash -c 'echo "$${name}"'`, { FOO: "bar" })).toEqual({
			stdout: `${defaultValue}\n`,
			stderr: "",
		});
	});

	it("keeps default PATH available after env -i starts a child shell", async () => {
		expect(await exec('env -i bash -c \'printf "%s\\n" "$PATH"; echo usable\'', { FOO: "bar" })).toEqual({
			stdout: "/usr/bin:/bin\nusable\n",
			stderr: "",
		});
	});

	for (const wrapper of ["", "env ", "time ", "timeout 5 "]) {
		it(`does not restore constructor env after replacement through ${wrapper || "bash"}`, async () => {
			await sm.withSession(T, sandboxId, async (session) => {
				const replacementSession = {
					...session,
					bash: new Bash({ fs, defenseInDepth: false, env: { SECRET: "private", HOSTNAME: "private-host" } }),
				};
				const result = await sm.execWithRuntimeThrottle(
					replacementSession,
					`${wrapper}bash -c 'printf "%s\\n" "$MARKER" "$SECRET" "$HOSTNAME"'`,
					{ env: { MARKER: "request" }, replaceEnv: true },
				);
				expect(result.stdout).toBe("request\n\nlocalhost\n");
				expect(result.exitCode).toBe(0);
			});
		});
	}

	it("keeps line numbers unchanged", async () => {
		expect((await exec("echo $LINENO\necho $LINENO", { FOO: "bar" })).stdout).toBe("1\n2\n");
	});

	it("keeps shebangs and line numbers unchanged", async () => {
		expect(await exec("#!/bin/bash\necho $LINENO\nbash -c 'echo foo=$FOO'", { FOO: "bar" })).toEqual({
			stdout: "2\nfoo=bar\n",
			stderr: "",
		});
	});

	it("keeps args attached to the first user command", async () => {
		const result = await sm.withSession(T, sandboxId, (session) =>
			sm.execWithRuntimeThrottle(session, "echo", { env: { FOO: "bar" }, args: ["first argument"] }),
		);
		expect(result.stdout).toBe("first argument\n");
		expect(result.stderr).toBe("");
		expect(result.exitCode).toBe(0);
	});

	const envCases: Array<Record<string, string> | undefined> = [undefined, { FOO: "bar" }, { "A-B": "bar" }];
	for (const env of envCases) {
		it(`preserves the user command budget with env ${JSON.stringify(env)}`, async () => {
			vi.spyOn(console, "log").mockImplementation(() => {});
			await sm.withSession(T, sandboxId, async (session) => {
				const limitedSession = {
					...session,
					bash: new Bash({ fs, defenseInDepth: false, executionLimits: { maxCommandCount: 2 } }),
				};
				const atLimit = await sm.execWithRuntimeThrottle(limitedSession, "echo one; echo two", { env });
				expect({ stdout: atLimit.stdout, stderr: atLimit.stderr, exitCode: atLimit.exitCode }).toEqual({
					stdout: "one\ntwo\n",
					stderr: "",
					exitCode: 0,
				});
				const overLimit = await sm.execWithRuntimeThrottle(limitedSession, "echo one; echo two; echo three", { env });
				expect(overLimit.stdout).toBe("one\ntwo\n");
				expect(overLimit.stderr).toBe(
					"bash: too many commands executed (>2), increase executionLimits.maxCommandCount\n",
				);
				expect(overLimit.exitCode).toBe(126);
			});
		});
	}

	it("never turns an env key into shell code", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const r = await exec("echo ran", { "X;touch /tmp/pwned": "v", FOO: "bar" });
		expect(r.stdout).toBe("ran\n");
		expect(await fs.exists("/tmp/pwned")).toBe(false);
	});

	it("passes env values literally to child shells", async () => {
		const value = "'\"; $(touch /tmp/pwned)\n$HOME `touch /tmp/pwned`";
		expect(await exec('bash -c \'printf "%s\\n" "$FOO"\'', { FOO: value })).toEqual({
			stdout: `${value}\n`,
			stderr: "",
		});
		expect(await fs.exists("/tmp/pwned")).toBe(false);
	});

	it("logs unsupported export names without logging any env values", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		expect(await exec("printenv A-B; bash -c 'printenv A-B'", { "A-B": "secret-value", FOO: "other-secret" })).toEqual({
			stdout: "secret-value\n",
			stderr: "",
		});
		expect(log.mock.calls).toEqual([
			[
				JSON.stringify({
					tenantId: T,
					sandboxId,
					variableNames: ["A-B"],
					omittedNameCount: 0,
					truncatedNameCount: 0,
					severity: "warn",
					event: "exec_env_not_exported",
				}),
			],
		]);
	});

	it("bounds the number and length of unsupported names in its audit warning", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const names = Array.from({ length: 100 }, (_, i) => `invalid-${i}-${"x".repeat(1000)}`);
		const env = Object.fromEntries(names.map((name) => [name, "secret-value"]));
		expect(await exec("echo ran", env)).toEqual({ stdout: "ran\n", stderr: "" });
		expect(log).toHaveBeenCalledTimes(1);
		const warning = JSON.parse(log.mock.calls[0]![0] as string);
		expect(warning).toEqual({
			tenantId: T,
			sandboxId,
			variableNames: names.slice(0, 20).map((name) => name.slice(0, 128)),
			omittedNameCount: 80,
			truncatedNameCount: 20,
			severity: "warn",
			event: "exec_env_not_exported",
		});
		expect(JSON.stringify(warning)).not.toContain("secret-value");
		expect(JSON.stringify(warning).length).toBeLessThan(4000);
	});

	it("warns only once per warm session, even for later unsupported names", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		await exec("true", { FOO: "valid" });
		await exec("true", { "A-B": "secret-value" });
		await exec("true", { "A-B": "another-secret" });
		await exec("true", { "C-D": "different-name" });
		expect(log).toHaveBeenCalledTimes(1);
		expect(JSON.parse(log.mock.calls[0]![0] as string).variableNames).toEqual(["A-B"]);
	});

	it("warns independently for separate sandboxes and tenants", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		await exec("true", { "A-B": "secret-value" });
		const otherSandboxId = `${sandboxId}-other`;
		for (const [tenantId, id] of [
			[T, otherSandboxId],
			["other-tenant", sandboxId],
		]) {
			await sm.withSession(tenantId!, id!, (session) =>
				sm.execWithRuntimeThrottle(session, "true", { env: { "A-B": "secret-value" } }),
			);
		}
		expect(
			log.mock.calls.map(([line]) => {
				const warning = JSON.parse(line as string);
				return [warning.tenantId, warning.sandboxId];
			}),
		).toEqual([
			[T, sandboxId],
			[T, otherSandboxId],
			["other-tenant", sandboxId],
		]);
	});
});

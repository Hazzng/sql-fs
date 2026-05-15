/**
 * Regression tests for cwd persistence across exec calls — issue #73.
 *
 * just-bash runs each `bash.exec()` against a **copy** of the interpreter
 * state, so `cd` inside a script modifies only that copy and is discarded
 * when the call returns. We bridge that gap in `execWithRuntimeThrottle` by
 * reading `result.env.PWD` (always populated by just-bash) and storing it on
 * `session.cwd`, then passing it as `opts.cwd` before the next exec.
 */

import { Bash, InMemoryFs } from "just-bash";
import type { BashExecResult } from "just-bash";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../../session-manager.js";

const T = "default";
const HOME = "/home/user";

async function makeEnv(): Promise<{ sm: SessionManager; sandboxId: string }> {
	const sm = new SessionManager({ createFs: async () => new InMemoryFs() });
	const sandboxId = `sb-cwd-${Math.random().toString(36).slice(2)}`;
	await sm.getOrCreate(T, sandboxId);
	return { sm, sandboxId };
}

describe("session cwd persistence across exec calls (regression — issue #73)", () => {
	it("session.cwd is initialised to the bash home directory", async () => {
		const { sm, sandboxId } = await makeEnv();
		const session = sm.getSession(T, sandboxId)!;
		expect(session.cwd).toBe(HOME);
	});

	it("cd in one exec persists to the next exec via session.cwd", async () => {
		const { sm, sandboxId } = await makeEnv();

		// Call 1: cd to a subdirectory
		await sm.withSession(T, sandboxId, async (session) => {
			await session.bash.exec("mkdir -p /home/user/project");
			await sm.execWithRuntimeThrottle(session, "cd /home/user/project");
		});

		// Call 2: pwd should reflect the new cwd
		const result = await sm.withSession(T, sandboxId, async (session) => {
			return sm.execWithRuntimeThrottle(session, "pwd");
		});

		expect(result.stdout.trim()).toBe("/home/user/project");
	});

	it("session.cwd is updated after cd", async () => {
		const { sm, sandboxId } = await makeEnv();
		const session = sm.getSession(T, sandboxId)!;

		await session.bash.exec("mkdir -p /home/user/deep/sub");

		await sm.withSession(T, sandboxId, async (s) => {
			await sm.execWithRuntimeThrottle(s, "cd /home/user/deep/sub");
		});

		expect(session.cwd).toBe("/home/user/deep/sub");
	});

	it("session.cwd is not updated when cd fails (stays at current dir)", async () => {
		const { sm, sandboxId } = await makeEnv();
		const session = sm.getSession(T, sandboxId)!;

		await sm.withSession(T, sandboxId, async (s) => {
			// cd to a nonexistent directory — should fail and leave cwd unchanged
			await sm.execWithRuntimeThrottle(s, "cd /does/not/exist");
		});

		// cwd should still be HOME because the cd failed
		expect(session.cwd).toBe(HOME);
	});

	it("relative cd is resolved correctly across calls", async () => {
		const { sm, sandboxId } = await makeEnv();
		const session = sm.getSession(T, sandboxId)!;

		await session.bash.exec("mkdir -p /home/user/a/b/c");

		// Move to /home/user/a
		await sm.withSession(T, sandboxId, async (s) => {
			await sm.execWithRuntimeThrottle(s, "cd /home/user/a");
		});
		expect(session.cwd).toBe("/home/user/a");

		// Move one level down using a relative path
		await sm.withSession(T, sandboxId, async (s) => {
			await sm.execWithRuntimeThrottle(s, "cd b");
		});
		expect(session.cwd).toBe("/home/user/a/b");

		// And again
		await sm.withSession(T, sandboxId, async (s) => {
			await sm.execWithRuntimeThrottle(s, "cd c");
		});
		expect(session.cwd).toBe("/home/user/a/b/c");
	});

	it("explicit cwd in opts overrides session.cwd for that call", async () => {
		const { sm, sandboxId } = await makeEnv();

		await sm.withSession(T, sandboxId, async (s) => {
			await sm.execWithRuntimeThrottle(s, "mkdir -p /tmp/override");
		});

		const result = await sm.withSession(T, sandboxId, async (session) => {
			return sm.execWithRuntimeThrottle(session, "pwd", { cwd: "/tmp/override" });
		});

		expect(result.stdout.trim()).toBe("/tmp/override");
	});

	it("explicit cwd in opts also updates session.cwd after the call", async () => {
		const { sm, sandboxId } = await makeEnv();
		const session = sm.getSession(T, sandboxId)!;

		await sm.withSession(T, sandboxId, async (s) => {
			await sm.execWithRuntimeThrottle(s, "mkdir -p /tmp/explicit");
		});

		// Pass an explicit cwd — the session cwd should be updated to /tmp/explicit afterward
		await sm.withSession(T, sandboxId, async (s) => {
			await sm.execWithRuntimeThrottle(s, "echo hello", { cwd: "/tmp/explicit" });
		});

		expect(session.cwd).toBe("/tmp/explicit");
	});

	it("readOnly exec does not update session.cwd", async () => {
		const { sm, sandboxId } = await makeEnv();
		const session = sm.getSession(T, sandboxId)!;

		// Create directory so cd can succeed within the readOnly exec context
		await sm.withSession(T, sandboxId, async (s) => {
			await sm.execWithRuntimeThrottle(s, "mkdir -p /home/user/readonly-dir");
		});

		// Run a readOnly exec that does a cd — it should NOT update session.cwd
		await sm.withSessionRead(T, sandboxId, async (s) => {
			await sm.execWithRuntimeThrottle(s, "cd /home/user/readonly-dir");
		});

		// session.cwd must be unchanged (readOnly contract)
		expect(session.cwd).toBe(HOME);
	});

	it("cwd persists across multiple sequential cd calls — exact issue #73 reproduction", async () => {
		const { sm, sandboxId } = await makeEnv();

		// Set up the directory structure
		await sm.withSession(T, sandboxId, async (s) => {
			await sm.execWithRuntimeThrottle(s, "mkdir -p /home/user/project/apps/langgraph");
		});

		// Call 1: cd and export a variable
		await sm.withSession(T, sandboxId, async (s) => {
			await sm.execWithRuntimeThrottle(s, "export MYVAR=hello_world; cd /home/user/project/apps/langgraph");
		});

		// Call 2: verify pwd — this was the broken behaviour (reset to /home/user)
		const result = await sm.withSession(T, sandboxId, async (s) => {
			return sm.execWithRuntimeThrottle(s, "pwd");
		});

		expect(result.stdout.trim()).toBe("/home/user/project/apps/langgraph");
	});
});

describe("session.cwd — stub-based unit coverage", () => {
	/**
	 * Tests that use a stub for bash.exec to verify the cwd wiring in
	 * execWithRuntimeThrottle without running the actual bash interpreter.
	 */
	type StubResult = BashExecResult;

	function stubBashExec(
		session: { bash: unknown },
		impl: (script: string, opts?: unknown) => Promise<StubResult>,
	): void {
		// biome-ignore lint/suspicious/noExplicitAny: deliberately overwriting a readonly method for test control
		(session.bash as any).exec = impl;
	}

	it("passes session.cwd as opts.cwd to bash.exec when no explicit cwd provided", async () => {
		const sm = new SessionManager({ createFs: async () => new InMemoryFs() });
		const session = await sm.getOrCreate(T, "sb-stub-cwd");

		// Manually override session.cwd so we can verify it is forwarded
		session.cwd = "/custom/tracked/dir";

		const capturedCwds: (string | undefined)[] = [];
		stubBashExec(session, async (_script, opts) => {
			capturedCwds.push((opts as { cwd?: string } | undefined)?.cwd);
			return { stdout: "", stderr: "", exitCode: 0, env: { PWD: "/custom/tracked/dir" } };
		});

		await sm.execWithRuntimeThrottle(session, "echo hi");

		expect(capturedCwds).toEqual(["/custom/tracked/dir"]);
	});

	it("uses caller-supplied cwd over session.cwd when both are set", async () => {
		const sm = new SessionManager({ createFs: async () => new InMemoryFs() });
		const session = await sm.getOrCreate(T, "sb-stub-override");

		session.cwd = "/session/dir";
		const capturedCwds: (string | undefined)[] = [];

		stubBashExec(session, async (_script, opts) => {
			capturedCwds.push((opts as { cwd?: string } | undefined)?.cwd);
			return { stdout: "", stderr: "", exitCode: 0, env: { PWD: "/explicit/dir" } };
		});

		await sm.execWithRuntimeThrottle(session, "echo hi", { cwd: "/explicit/dir" });

		// Caller-supplied wins
		expect(capturedCwds).toEqual(["/explicit/dir"]);
		// And session.cwd is updated from result.env.PWD
		expect(session.cwd).toBe("/explicit/dir");
	});

	it("updates session.cwd from result.env.PWD after exec", async () => {
		const sm = new SessionManager({ createFs: async () => new InMemoryFs() });
		const session = await sm.getOrCreate(T, "sb-stub-update");

		stubBashExec(session, async () => {
			return { stdout: "", stderr: "", exitCode: 0, env: { PWD: "/new/cwd/from/exec" } };
		});

		await sm.execWithRuntimeThrottle(session, "cd /new/cwd/from/exec");

		expect(session.cwd).toBe("/new/cwd/from/exec");
	});

	it("does not update session.cwd when result.env.PWD is missing", async () => {
		const sm = new SessionManager({ createFs: async () => new InMemoryFs() });
		const session = await sm.getOrCreate(T, "sb-stub-no-pwd");
		session.cwd = "/original/dir";

		stubBashExec(session, async () => {
			// No PWD in env (hypothetical edge case — just-bash always sets it, but be defensive)
			return { stdout: "", stderr: "", exitCode: 0, env: {} };
		});

		await sm.execWithRuntimeThrottle(session, "echo hi");

		// cwd must not change when PWD is absent
		expect(session.cwd).toBe("/original/dir");
	});

	it("bash instance state — getCwd() always returns HOME (confirms just-bash design)", async () => {
		// This test documents that just-bash.getCwd() never changes on its own;
		// our session.cwd layer is what provides cross-call persistence.
		const bash = new Bash({ fs: new InMemoryFs() });
		await bash.exec("cd /tmp");
		expect(bash.getCwd()).toBe(HOME);
	});
});

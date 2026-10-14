import type { BashExecResult } from "just-bash";
import { InMemoryFs } from "just-bash";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ownerCancellation } from "../../../execution/owner-cancellation.js";
import { SqlFs } from "../../../sql-fs/sql-fs.js";
import { BUFFER_ON, makeProbeDialect } from "../../../sql-fs/tests/fixtures/buffered-dialect.js";
import { consumeExecInput, execContext } from "../../exec-context.js";
import { runInScriptTx } from "../../lib/script-tx.js";
import { readOnlyContext } from "../../read-only-context.js";
import { sessionLeaseContext } from "../../session-lease-context.js";
import { createSessionRuntime, executeSessionRuntime } from "../../session-runtime/engine.js";

const filesystems: SqlFs[] = [];
const identity = {
	tenantId: "default",
	sandboxId: "scope-policy",
	runtimeOptions: { python: false, javascript: false, network: false },
};
const options = { defenseInDepth: false, defenseAuditMode: false };
const returned: BashExecResult = { stdout: "", stderr: "", exitCode: 0, env: { PWD: "/home/next" } };

afterEach(async () => {
	vi.restoreAllMocks();
	for (const fs of filesystems.splice(0)) await fs.disconnect();
});

async function fixture(inputLimit = 1024) {
	const probe = makeProbeDialect();
	const fs = new SqlFs({ dialect: probe.dialect, sandboxId: identity.sandboxId, scriptTxBuffer: BUFFER_ON });
	filesystems.push(fs);
	await fs.ready();
	probe.windows.length = 0;
	probe.calls.length = 0;
	const runtime = createSessionRuntime(fs, identity, {
		...options,
		executionLimits: { maxInputBytes: inputLimit },
	});
	runtime.cwd = "/home/user";
	const scope = runtime.scriptTx;
	if (scope === undefined) throw new Error("SqlFs must provide a script scope");
	return { fs, probe, runtime, scope };
}

describe("session runtime script completion", () => {
	it("commits writes when bash returns a nonzero exit code", async () => {
		const { fs, runtime, scope } = await fixture();

		const result = await executeSessionRuntime(runtime, "echo kept > /home/user/kept; false");

		expect(result.exitCode).toBe(1);
		expect(await fs.readFile("/home/user/kept")).toBe("kept\n");
		expect(scope.isActive).toBe(false);
	});

	it("leaves nested execution open until the outer owner commits", async () => {
		const { fs, probe, runtime, scope } = await fixture();

		await scope.run(async () => {
			await executeSessionRuntime(runtime, "echo nested > /home/user/nested");
			expect(scope.isActive).toBe(true);
			expect(probe.calls).not.toContain("writeFileComposite");
			expect(await fs.readFile("/home/user/nested")).toBe("nested\n");
		});

		expect(scope.isActive).toBe(false);
		expect(probe.calls.filter((call) => call === "writeFileComposite")).toHaveLength(1);
		expect(await fs.readFile("/home/user/nested")).toBe("nested\n");
	});

	it("rolls back all outer and nested writes when a nested body throws", async () => {
		const { fs, runtime, scope } = await fixture();
		const primary = new Error("nested failure");

		await expect(
			scope.run(async () => {
				await executeSessionRuntime(runtime, "echo outer > /home/user/outer");
				await scope.run(async () => {
					await fs.writeFile("/home/user/inner", "inner");
					throw primary;
				});
			}),
		).rejects.toBe(primary);

		expect(scope.isActive).toBe(false);
		expect(await fs.exists("/home/user/outer")).toBe(false);
		expect(await fs.exists("/home/user/inner")).toBe(false);
	});

	it("checks definitive lease loss inside a borrowed scope before commit", async () => {
		const { fs, probe, runtime, scope } = await fixture();
		const lease = new AbortController();
		vi.spyOn(runtime.bash, "exec").mockImplementation(async () => {
			await fs.writeFile("/home/user/lost", "pending");
			lease.abort();
			return returned;
		});

		await expect(
			sessionLeaseContext.run({ lostSignal: lease.signal }, () =>
				scope.run(() => executeSessionRuntime(runtime, "write then lose lease")),
			),
		).rejects.toMatchObject({ code: "ELOCKLOST" });

		expect(await fs.exists("/home/user/lost")).toBe(false);
		expect(probe.calls).not.toContain("writeFileComposite");
		expect(runtime.cwd).toBe("/home/user");
	});

	it("checks a lost route lease in a borrowed scope without finalizing the owner's scope", async () => {
		const { fs, runtime, scope } = await fixture();
		const lease = new AbortController();
		await scope.beginScope();
		await fs.writeFile("/home/user/route-pending", "pending");
		lease.abort();
		try {
			await expect(
				sessionLeaseContext.run({ lostSignal: lease.signal }, () => runInScriptTx(runtime, async () => "returned")),
			).rejects.toMatchObject({ code: "ELOCKLOST" });
			expect(scope.isActive).toBe(true);
			expect(await fs.readFile("/home/user/route-pending")).toBe("pending");
		} finally {
			await scope.abortScope();
		}
		expect(await fs.exists("/home/user/route-pending")).toBe(false);
	});

	it("rolls back when the worker owner lease is lost after the body returns", async () => {
		const { fs, runtime } = await fixture();
		const words = new Int32Array(new SharedArrayBuffer(8));
		vi.spyOn(runtime.bash, "exec").mockImplementation(async () => {
			await fs.writeFile("/home/user/worker-lost", "pending");
			Atomics.store(words, 1, 1);
			return returned;
		});

		await expect(
			ownerCancellation.run(words, () => executeSessionRuntime(runtime, "write then lose owner")),
		).rejects.toMatchObject({ code: "ELOCKLOST" });

		expect(await fs.exists("/home/user/worker-lost")).toBe(false);
		expect(runtime.cwd).toBe("/home/user");
	});

	it("rolls back a borrowed scope when bash swallows an input-budget rejection", async () => {
		const { fs, runtime, scope } = await fixture(8);
		vi.spyOn(runtime.bash, "exec").mockImplementation(async () => {
			await fs.writeFile("/home/user/input-limited", "pending");
			try {
				consumeExecInput(execContext.getStore(), 9, "rejected input");
			} catch {}
			return returned;
		});

		await expect(scope.run(() => executeSessionRuntime(runtime, "swallowed input error"))).rejects.toMatchObject({
			code: "EEXEC_INPUT_LIMIT",
		});

		expect(await fs.exists("/home/user/input-limited")).toBe(false);
		expect(scope.isActive).toBe(false);
		expect(runtime.cwd).toBe("/home/user");
	});

	it("rejects oversized stdin before invoking bash and leaves no open scope", async () => {
		const { runtime, scope } = await fixture(8);
		const exec = vi.spyOn(runtime.bash, "exec");

		await expect(executeSessionRuntime(runtime, "unused", { stdin: "123456789" })).rejects.toMatchObject({
			code: "EEXEC_INPUT_LIMIT",
		});

		expect(exec).not.toHaveBeenCalled();
		expect(scope.isActive).toBe(false);
	});

	it("commits a returned result when only the execution signal is aborted", async () => {
		const { fs, runtime } = await fixture();
		const timeout = new AbortController();
		vi.spyOn(runtime.bash, "exec").mockImplementation(async () => {
			await fs.writeFile("/home/user/timeout-result", "returned");
			timeout.abort();
			return returned;
		});

		await expect(executeSessionRuntime(runtime, "returned despite abort", { signal: timeout.signal })).resolves.toBe(
			returned,
		);
		expect(await fs.readFile("/home/user/timeout-result")).toBe("returned");
	});

	it("changes cwd after owned completion succeeds", async () => {
		const { runtime, scope } = await fixture();
		const endScope = scope.endScope.bind(scope);
		vi.spyOn(scope, "endScope").mockImplementation(async () => {
			expect(runtime.cwd).toBe("/home/user");
			await endScope();
		});
		vi.spyOn(runtime.bash, "exec").mockResolvedValue(returned);

		await executeSessionRuntime(runtime, "changed cwd");

		expect(runtime.cwd).toBe("/home/next");
	});

	it("keeps cwd when owned commit fails", async () => {
		const { fs, probe, runtime, scope } = await fixture();
		const primary = new Error("commit failed");
		vi.spyOn(runtime.bash, "exec").mockImplementation(async () => {
			await fs.writeFile("/home/user/commit-failed", "pending");
			probe.failTransaction = primary;
			return returned;
		});

		await expect(executeSessionRuntime(runtime, "failed commit")).rejects.toBe(primary);

		expect(runtime.cwd).toBe("/home/user");
		expect(scope.isActive).toBe(false);
	});

	it("read-only execution neither opens a scope nor changes cwd", async () => {
		const { fs, runtime, scope } = await fixture();
		const begin = vi.spyOn(scope, "beginScope");
		fs.beginReadOnlyScope();
		try {
			const result = await readOnlyContext.run({ violated: false }, () =>
				executeSessionRuntime(runtime, "cd /home; pwd"),
			);
			expect(result).toMatchObject({ stdout: "/home\n", exitCode: 0 });
			expect(begin).not.toHaveBeenCalled();
			expect(scope.isActive).toBe(false);
			expect(runtime.cwd).toBe("/home/user");
		} finally {
			fs.endReadOnlyScope();
		}
	});

	it("preserves direct execution on a backend without a scope even with an aborted lease", async () => {
		const fs = new InMemoryFs();
		const runtime = createSessionRuntime(fs, identity, options);
		const lease = new AbortController();
		lease.abort();
		vi.spyOn(runtime.bash, "exec").mockImplementation(async () => {
			await fs.writeFile("/direct", "written");
			return returned;
		});

		await sessionLeaseContext.run({ lostSignal: lease.signal }, () => executeSessionRuntime(runtime, "direct"));

		expect(runtime.scriptTx).toBeUndefined();
		expect(await fs.readFile("/direct")).toBe("written");
		expect(runtime.cwd).toBe("/home/next");
	});
});

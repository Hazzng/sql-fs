/**
 * Regression tests for issue #77 — perScriptTimeoutMs feature.
 *
 * Before the fix: totalTimeoutMs was the only budget, so a slow first script
 * would exhaust the shared budget and later scripts came back exit_code=-1,
 * error="timeout" even when they would have succeeded individually.
 * After the fix: perScriptTimeoutMs gives each script its own independent budget.
 *
 * Split from exec-batch.test.ts to keep each file under the 300-line guideline.
 * The sequential (write) path is exercised via HTTP (POST exec-sync-batch without
 * readOnly:true). The parallel (readOnly) path is exercised by calling executeBatch
 * directly inside readOnlyContext.run to avoid the jose libuv fake-timer race.
 */

import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { SignJWT } from "jose";
import { InMemoryFs } from "just-bash";
import type { BashExecResult, IFileSystem } from "just-bash";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AuthVariables, authMiddleware } from "../../auth.js";
import { mapFsErrorToStatus } from "../../errors.js";
import { executeBatch } from "../../lib/batch-exec.js";
import { readOnlyContext } from "../../read-only-context.js";
import { execRoutes } from "../../routes/exec.js";
import { SessionManager } from "../../session-manager.js";
import type { Session } from "../../session-manager.js";

const AUTH_SECRET = "test-secret-for-exec-batch-perscript-at-least-32bytes!";
const secretBytes = new TextEncoder().encode(AUTH_SECRET);

async function makeToken(sub = "agent-1"): Promise<string> {
	return new SignJWT({ sub }).setProtectedHeader({ alg: "HS256" }).sign(secretBytes);
}

async function makeTestEnv(): Promise<{
	sessionManager: SessionManager;
	fs: IFileSystem;
	session: Session;
}> {
	const fs = new InMemoryFs();
	const sessionManager = new SessionManager({ createFs: async () => fs });
	const session = await sessionManager.getOrCreate("default", SANDBOX_ID, undefined, "agent-1");
	return { sessionManager, fs, session };
}

function makeTestApp(sessionManager: SessionManager) {
	const app = new Hono<{ Variables: AuthVariables }>();
	app.use("/v1/*", authMiddleware);
	app.route("/v1/sandboxes", execRoutes(sessionManager));
	app.onError((err, c) => {
		const status = mapFsErrorToStatus(err) as ContentfulStatusCode;
		const code = (err as Error & { code?: string }).code ?? "INTERNAL_ERROR";
		return c.json({ error: err.message, code }, status);
	});
	return app;
}

const SANDBOX_ID = "test-perscript-sandbox";

interface BatchResult {
	id: string;
	stdout: string;
	stderr: string;
	exitCode: number;
	durationMs: number;
	error?: string;
}

describe("perScriptTimeoutMs — sequential (write) path via HTTP", () => {
	beforeEach(() => {
		process.env.AUTH_SECRET = AUTH_SECRET;
	});

	afterEach(() => {
		process.env.AUTH_SECRET = "";
		vi.restoreAllMocks();
	});

	// Regression for issue #77 — shared timeout silently kills later scripts.
	// Before the fix: totalTimeoutMs was the only budget, so a slow first script
	// would exhaust the shared budget and later scripts came back exit_code=-1,
	// error="timeout" even though they would have succeeded individually.
	// After the fix: perScriptTimeoutMs gives each script its own independent budget.
	it("later scripts succeed when first script times out (regression #77)", async () => {
		vi.useFakeTimers();
		try {
			const { sessionManager } = await makeTestEnv();
			const app = makeTestApp(sessionManager);
			const token = await makeToken();

			const batchSandboxId = `${SANDBOX_ID}-per-script`;
			const session = await sessionManager.getOrCreate("default", batchSandboxId, undefined, "agent-1");

			// Latch fires once the first blocking exec is registered so we can advance
			// the fake clock after its per-script timer has been created.
			let latchResolve!: () => void;
			const execBlocking = new Promise<void>((r) => {
				latchResolve = r;
			});

			let callCount = 0;
			vi.spyOn(session.bash, "exec").mockImplementation((_script, opts) => {
				callCount++;
				if (callCount === 1) {
					// First script blocks forever — simulates Python 1.4s WASM startup.
					return new Promise((_resolve, reject) => {
						latchResolve();
						opts?.signal?.addEventListener("abort", () => {
							reject(new DOMException("The operation was aborted", "AbortError"));
						});
					});
				}
				// Subsequent scripts succeed instantly.
				return Promise.resolve({ stdout: "ok\n", stderr: "", exitCode: 0, env: {} });
			});

			const resPromise = app.request(`/v1/sandboxes/${batchSandboxId}/exec-sync-batch`, {
				method: "POST",
				headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
				body: JSON.stringify({
					scripts: [
						{ id: "slow", script: "sleep 1000" },
						{ id: "fast1", script: "echo ok" },
						{ id: "fast2", script: "echo ok" },
					],
					// Total budget is 5s — far more than enough for fast1 and fast2.
					// Per-script budget is 50ms — just enough to kill the first slow script.
					// Before the fix (no perScriptTimeoutMs wiring): all three would share
					// the 5s total, and the first script would block for the full 5s, causing
					// fast1 and fast2 to come back as timeout false-negatives.
					timeoutMs: 5000,
					perScriptTimeoutMs: 50,
				}),
			});

			// Wait until the mock is blocking before advancing the clock.
			await execBlocking;
			// Advance past the per-script timeout for the first script only (50ms).
			await vi.advanceTimersByTimeAsync(60);

			const res = await resPromise;
			expect(res.status).toBe(200);
			const body = (await res.json()) as { results: BatchResult[] };

			// The first (slow) script must be killed by its per-script timeout.
			expect(body.results[0]!.id).toBe("slow");
			expect(body.results[0]!.exitCode).toBe(-1);
			expect(body.results[0]!.error).toBe("timeout");

			// The later scripts must NOT be false-negatives — they succeed independently.
			// Before the fix these would both be exit_code=-1, error="timeout".
			expect(body.results[1]!.id).toBe("fast1");
			expect(body.results[1]!.exitCode).toBe(0);
			expect(body.results[1]!.error).toBeUndefined();

			expect(body.results[2]!.id).toBe("fast2");
			expect(body.results[2]!.exitCode).toBe(0);
			expect(body.results[2]!.error).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it("perScriptTimeoutMs is capped by totalTimeoutMs outer ceiling", async () => {
		vi.useFakeTimers();
		try {
			const { sessionManager } = await makeTestEnv();
			const app = makeTestApp(sessionManager);
			const token = await makeToken();

			const batchSandboxId = `${SANDBOX_ID}-ceiling`;
			const session = await sessionManager.getOrCreate("default", batchSandboxId, undefined, "agent-1");

			let latchResolve!: () => void;
			const execBlocking = new Promise<void>((r) => {
				latchResolve = r;
			});

			vi.spyOn(session.bash, "exec").mockImplementation((_script, opts) => {
				// Every script blocks forever — only abort can resolve.
				return new Promise((_resolve, reject) => {
					latchResolve();
					latchResolve = () => {}; // prevent double-resolve
					opts?.signal?.addEventListener("abort", () => {
						reject(new DOMException("The operation was aborted", "AbortError"));
					});
				});
			});

			const resPromise = app.request(`/v1/sandboxes/${batchSandboxId}/exec-sync-batch`, {
				method: "POST",
				headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
				body: JSON.stringify({
					scripts: [
						{ id: "a", script: "block" },
						{ id: "b", script: "block" },
					],
					// Total budget 100ms is smaller than per-script budget 10000ms.
					// The total deadline must fire first and kill everything.
					timeoutMs: 100,
					perScriptTimeoutMs: 10000,
				}),
			});

			await execBlocking;
			await vi.advanceTimersByTimeAsync(110);

			const res = await resPromise;
			expect(res.status).toBe(200);
			const body = (await res.json()) as { results: BatchResult[] };

			// Both scripts timed out — the outer ceiling took effect.
			for (const result of body.results) {
				expect(result.exitCode).toBe(-1);
				expect(result.error).toBe("timeout");
			}
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("perScriptTimeoutMs — parallel (readOnly) path via executeBatch", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	// Regression for issue #77 on the parallel code path.
	// runParallel uses per-script AbortControllers linked to a sharedController via an
	// onShared listener — a structurally different mechanism from runSequential. This test
	// ensures perScriptTimeoutMs lets later scripts succeed even when the first blocks.
	it("later scripts succeed when first script times out (regression #77, parallel path)", async () => {
		vi.useFakeTimers();
		try {
			const sessionManager = new SessionManager({ createFs: async () => new InMemoryFs() });
			const session = await sessionManager.getOrCreate("default", `${SANDBOX_ID}-parallel`, undefined, "agent-1");

			let latchResolve!: () => void;
			const execBlocking = new Promise<void>((r) => {
				latchResolve = r;
			});

			let callCount = 0;
			vi.spyOn(session.bash, "exec").mockImplementation((_script, opts) => {
				callCount++;
				if (callCount === 1) {
					// First script blocks forever — simulates a slow capability probe.
					return new Promise<BashExecResult>((_resolve, reject) => {
						latchResolve();
						opts?.signal?.addEventListener("abort", () => {
							reject(new DOMException("The operation was aborted", "AbortError"));
						});
					});
				}
				// Subsequent scripts complete instantly.
				return Promise.resolve<BashExecResult>({ stdout: "ok\n", stderr: "", exitCode: 0, env: {} });
			});

			const scripts = [
				{ id: "slow", script: "sleep 1000" },
				{ id: "fast1", script: "echo ok" },
				{ id: "fast2", script: "echo ok" },
			];

			// Wrap in readOnlyContext.run to activate the parallel code path in executeBatch.
			// Total budget is 5s — far more than enough for fast1 and fast2.
			// Per-script budget is 50ms — just enough to kill the first slow script.
			const batchPromise = readOnlyContext.run({ violated: false }, () =>
				executeBatch(sessionManager, session, scripts, 5000, undefined, { perScriptTimeoutMs: 50 }),
			);

			await execBlocking;
			// Advance past the per-script timeout (50ms) but stay well within total (5000ms).
			await vi.advanceTimersByTimeAsync(60);

			const results = await batchPromise;

			// The first (slow) script must be killed by its per-script timeout.
			expect(results[0]!.id).toBe("slow");
			expect(results[0]!.exitCode).toBe(-1);
			expect(results[0]!.error).toBe("timeout");

			// The later scripts must NOT be false-negatives — they succeed independently.
			// Before the fix (no perScriptTimeoutMs in runParallel): all scripts share the
			// sharedController, so aborting the first would abort the entire batch.
			expect(results[1]!.id).toBe("fast1");
			expect(results[1]!.exitCode).toBe(0);
			expect(results[1]!.error).toBeUndefined();

			expect(results[2]!.id).toBe("fast2");
			expect(results[2]!.exitCode).toBe(0);
			expect(results[2]!.error).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});
});

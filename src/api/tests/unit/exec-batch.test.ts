import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { SignJWT } from "jose";
import { InMemoryFs } from "just-bash";
import type { IFileSystem } from "just-bash";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxMeta } from "../../../fs/sql-fs/types.js";
import { type AuthVariables, authMiddleware } from "../../auth.js";
import { mapFsErrorToStatus } from "../../errors.js";
import { execRoutes } from "../../routes/exec.js";
import { SessionManager } from "../../session-manager.js";

const AUTH_SECRET = "test-secret-for-exec-batch-at-least-32bytes!";
const secretBytes = new TextEncoder().encode(AUTH_SECRET);

async function makeToken(sub = "agent-1"): Promise<string> {
	return new SignJWT({ sub }).setProtectedHeader({ alg: "HS256" }).sign(secretBytes);
}

async function makeTestEnv(): Promise<{ sessionManager: SessionManager; fs: IFileSystem }> {
	const fs = new InMemoryFs();
	const sessionManager = new SessionManager({
		createFs: async () => fs,
	});
	await sessionManager.getOrCreate("default", SANDBOX_ID);
	return { sessionManager, fs };
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

const SANDBOX_ID = "test-batch-sandbox";

interface BatchResult {
	id: string;
	stdout: string;
	stderr: string;
	exitCode: number;
	error?: string;
}

describe("POST /v1/sandboxes/:id/exec-sync-batch", () => {
	beforeEach(() => {
		process.env.AUTH_SECRET = AUTH_SECRET;
	});

	afterEach(() => {
		process.env.AUTH_SECRET = "";
		vi.restoreAllMocks();
	});

	it("executes multiple scripts and returns results for each", async () => {
		const { sessionManager } = await makeTestEnv();
		const app = makeTestApp(sessionManager);
		const token = await makeToken();

		const res = await app.request(`/v1/sandboxes/${SANDBOX_ID}/exec-sync-batch`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({
				scripts: [
					{ id: "hello", script: "echo hello" },
					{ id: "world", script: "echo world" },
				],
			}),
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as { results: BatchResult[] };
		expect(body.results).toHaveLength(2);
		expect(body.results[0]).toEqual({ id: "hello", stdout: "hello\n", stderr: "", exitCode: 0 });
		expect(body.results[1]).toEqual({ id: "world", stdout: "world\n", stderr: "", exitCode: 0 });
	});

	it("continues executing after a script fails with non-zero exit", async () => {
		const { sessionManager } = await makeTestEnv();
		const app = makeTestApp(sessionManager);
		const token = await makeToken();

		const res = await app.request(`/v1/sandboxes/${SANDBOX_ID}/exec-sync-batch`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({
				scripts: [
					{ id: "fail", script: "false" },
					{ id: "ok", script: "echo still-runs" },
				],
			}),
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as { results: BatchResult[] };
		expect(body.results[0]!.exitCode).toBe(1);
		expect(body.results[1]!.stdout).toBe("still-runs\n");
		expect(body.results[1]!.exitCode).toBe(0);
	});

	it("shares filesystem state across sequential scripts", async () => {
		const { sessionManager } = await makeTestEnv();
		const app = makeTestApp(sessionManager);
		const token = await makeToken();

		const res = await app.request(`/v1/sandboxes/${SANDBOX_ID}/exec-sync-batch`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({
				scripts: [
					{ id: "write", script: "echo batch-test > /tmp/batch.txt" },
					{ id: "read", script: "cat /tmp/batch.txt" },
				],
			}),
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as { results: BatchResult[] };
		expect(body.results[0]!.exitCode).toBe(0);
		expect(body.results[1]!.stdout).toBe("batch-test\n");
	});

	it("marks remaining scripts as timeout when budget expires", async () => {
		vi.useFakeTimers();
		try {
			const { sessionManager } = await makeTestEnv();
			const app = makeTestApp(sessionManager);
			const token = await makeToken();

			const batchSandboxId = `${SANDBOX_ID}-timeout`;
			const session = await sessionManager.getOrCreate("default", batchSandboxId);

			// Latch resolves the moment the first exec call begins blocking, which is
			// AFTER batch-exec.ts has registered its budget setTimeout. Advancing the
			// fake clock only after this latch fires avoids a race where advanceTimers
			// runs before the setTimeout is registered.
			let latchResolve!: () => void;
			const execBlocking = new Promise<void>((r) => {
				latchResolve = r;
			});

			let callCount = 0;
			vi.spyOn(session.bash, "exec").mockImplementation((_script, opts) => {
				callCount++;
				if (callCount === 1) {
					return new Promise((_resolve, reject) => {
						latchResolve();
						opts?.signal?.addEventListener("abort", () => {
							reject(new DOMException("The operation was aborted", "AbortError"));
						});
					});
				}
				return Promise.resolve({ stdout: "ok\n", stderr: "", exitCode: 0, env: {} });
			});

			const resPromise = app.request(`/v1/sandboxes/${batchSandboxId}/exec-sync-batch`, {
				method: "POST",
				headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
				body: JSON.stringify({
					scripts: [
						{ id: "slow", script: "sleep 1000" },
						{ id: "never", script: "echo unreachable" },
					],
					timeoutMs: 50,
				}),
			});

			// Wait until the mock is blocking — the budget setTimeout is registered
			// synchronously before bash.exec is called in batch-exec.ts, so once the
			// latch fires the fake timer is already in the queue.
			await execBlocking;
			await vi.advanceTimersByTimeAsync(50);

			const res = await resPromise;
			expect(res.status).toBe(200);
			const body = (await res.json()) as { results: BatchResult[] };
			expect(body.results[0]!.error).toBe("timeout");
			expect(body.results[0]!.exitCode).toBe(-1);
			expect(body.results[1]!.error).toBe("timeout");
			expect(body.results[1]!.exitCode).toBe(-1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("rejects empty scripts array", async () => {
		const { sessionManager } = await makeTestEnv();
		const app = makeTestApp(sessionManager);
		const token = await makeToken();

		const res = await app.request(`/v1/sandboxes/${SANDBOX_ID}/exec-sync-batch`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ scripts: [] }),
		});

		expect(res.status).toBe(400);
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("INVALID_INPUT");
	});

	it("rejects invalid JSON body", async () => {
		const { sessionManager } = await makeTestEnv();
		const app = makeTestApp(sessionManager);
		const token = await makeToken();

		const res = await app.request(`/v1/sandboxes/${SANDBOX_ID}/exec-sync-batch`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: "not-json",
		});

		expect(res.status).toBe(400);
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("INVALID_INPUT");
	});

	it("returns 403 for wrong owner", async () => {
		const meta = new Map<string, SandboxMeta>();
		const mgr = new SessionManager({
			createFs: async () => new InMemoryFs(),
			getSandboxMetaFn: async (_t, id) => meta.get(id) ?? null,
			persistSandboxMetaFn: async (_t, id, m) => {
				meta.set(id, m);
			},
		});
		await mgr.withSession("default", SANDBOX_ID, async (session) => {
			session.owner = "agent-1";
			await mgr.persistSandboxMeta("default", SANDBOX_ID, {
				owner: "agent-1",
				name: null,
				python: false,
				javascript: false,
			});
		});

		const app = makeTestApp(mgr);
		const token = await makeToken("agent-2");

		const res = await app.request(`/v1/sandboxes/${SANDBOX_ID}/exec-sync-batch`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ scripts: [{ id: "a", script: "echo hi" }] }),
		});

		expect(res.status).toBe(403);
	});

	it("returns 404 for non-existent sandbox", async () => {
		const mgr = new SessionManager({
			createFs: async () => new InMemoryFs(),
			getSandboxMetaFn: async () => null,
		});
		const app = makeTestApp(mgr);
		const token = await makeToken();

		const res = await app.request("/v1/sandboxes/does-not-exist/exec-sync-batch", {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ scripts: [{ id: "a", script: "echo hi" }] }),
		});

		expect(res.status).toBe(404);
	});

	// Regression for issue #77 — shared timeout silently kills later scripts.
	// Before the fix: totalTimeoutMs was the only budget, so a slow first script
	// would exhaust the shared budget and later scripts came back exit_code=-1,
	// error="timeout" even though they would have succeeded individually.
	// After the fix: perScriptTimeoutMs gives each script its own independent budget.
	it("perScriptTimeoutMs: later scripts succeed when first script times out (regression #77)", async () => {
		vi.useFakeTimers();
		try {
			const { sessionManager } = await makeTestEnv();
			const app = makeTestApp(sessionManager);
			const token = await makeToken();

			const batchSandboxId = `${SANDBOX_ID}-per-script`;
			const session = await sessionManager.getOrCreate("default", batchSandboxId);

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
			const session = await sessionManager.getOrCreate("default", batchSandboxId);

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

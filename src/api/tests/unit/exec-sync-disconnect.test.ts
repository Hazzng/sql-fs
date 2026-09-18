/**
 * US-172: POST /v1/sandboxes/:id/exec-sync must abort the in-flight script when the
 * client disconnects — an orphaned script holds the sandbox's exclusive exec lock for
 * the rest of its timeout (up to 300 s), blocking every other request on that sandbox.
 * Semantics are deliberately abort-only: whatever the script already committed stays
 * committed, matching /exec, /exec-sync-batch and the timeout path.
 */

import { Hono } from "hono";
import { SignJWT } from "jose";
import { InMemoryFs } from "just-bash";
import type { IFileSystem } from "just-bash";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AuthVariables, authMiddleware } from "../../auth.js";
import { execRoutes } from "../../routes/exec.js";
import { SessionManager } from "../../session-manager.js";

const AUTH_SECRET = "test-secret-for-exec-disconnect-32bytes!!";
const secretBytes = new TextEncoder().encode(AUTH_SECRET);
const SANDBOX_ID = "test-exec-disconnect-sandbox";

/** How long to wait before declaring the buffered handler hung (no fix = never settles). */
const SETTLE_BUDGET_MS = 500;

async function makeToken(sub = "agent-1"): Promise<string> {
	return new SignJWT({ sub }).setProtectedHeader({ alg: "HS256" }).sign(secretBytes);
}

async function makeTestEnv(
	sandboxId: string,
): Promise<{ sessionManager: SessionManager; fs: IFileSystem; app: Hono<{ Variables: AuthVariables }> }> {
	const fs = new InMemoryFs();
	const sessionManager = new SessionManager({ createFs: async () => fs });
	await sessionManager.getOrCreate("default", sandboxId, undefined, "agent-1");
	const app = new Hono<{ Variables: AuthVariables }>();
	app.use("/v1/*", authMiddleware);
	app.route("/v1/sandboxes", execRoutes(sessionManager));
	return { sessionManager, fs, app };
}

/** `app.request` is typed as sync-or-async; normalise it so the test can race and catch it. */
function settleable(res: Response | Promise<Response>): Promise<Response> {
	return Promise.resolve(res);
}

/** Resolves "settled" when the buffered response comes back either way, "hung" on timeout. */
function raceSettle(res: Promise<unknown>): Promise<"settled" | "hung"> {
	return Promise.race([
		res.then(
			() => "settled" as const,
			() => "settled" as const,
		),
		new Promise<"hung">((r) => setTimeout(() => r("hung"), SETTLE_BUDGET_MS)),
	]);
}

describe("POST /v1/sandboxes/:id/exec-sync client disconnect", () => {
	beforeEach(() => {
		process.env.AUTH_SECRET = AUTH_SECRET;
	});

	afterEach(() => {
		process.env.AUTH_SECRET = "";
		vi.restoreAllMocks();
	});

	it("aborts the running script when the client disconnects mid-exec", async () => {
		const { sessionManager, app } = await makeTestEnv(SANDBOX_ID);
		const token = await makeToken();
		const session = await sessionManager.getOrCreate("default", SANDBOX_ID, undefined, "agent-1");

		let execStarted!: () => void;
		const started = new Promise<void>((r) => {
			execStarted = r;
		});
		let execSignal: AbortSignal | undefined;
		let abandonExec!: () => void;

		vi.spyOn(session.bash, "exec").mockImplementation(
			(_script, opts) =>
				new Promise((_resolve, reject) => {
					execSignal = opts?.signal;
					abandonExec = () => reject(new DOMException("The operation was aborted", "AbortError"));
					opts?.signal?.addEventListener("abort", abandonExec, { once: true });
					execStarted();
				}),
		);

		const client = new AbortController();
		const resPromise = settleable(
			app.request(`/v1/sandboxes/${SANDBOX_ID}/exec-sync`, {
				method: "POST",
				headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
				body: JSON.stringify({ script: "sleep 1000" }),
				signal: client.signal,
			}),
		);

		await started;
		client.abort();

		try {
			expect(await raceSettle(resPromise)).toBe("settled");
			expect(execSignal?.aborted).toBe(true);
		} finally {
			abandonExec();
			await resPromise.catch(() => undefined);
		}
	});

	it("aborts an exec that starts after the client has already disconnected", async () => {
		const sandboxId = `${SANDBOX_ID}-pre`;
		const { sessionManager, app } = await makeTestEnv(sandboxId);
		const token = await makeToken();
		const session = await sessionManager.getOrCreate("default", sandboxId, undefined, "agent-1");

		let abortedAtExecStart: boolean | undefined;
		let abandonExec: () => void = () => undefined;

		vi.spyOn(session.bash, "exec").mockImplementation(
			(_script, opts) =>
				new Promise((_resolve, reject) => {
					abortedAtExecStart = opts?.signal?.aborted;
					abandonExec = () => reject(new DOMException("The operation was aborted", "AbortError"));
					if (opts?.signal?.aborted) {
						abandonExec();
						return;
					}
					opts?.signal?.addEventListener("abort", abandonExec, { once: true });
				}),
		);

		const client = new AbortController();
		client.abort();
		const resPromise = settleable(
			app.request(`/v1/sandboxes/${sandboxId}/exec-sync`, {
				method: "POST",
				headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
				body: JSON.stringify({ script: "sleep 1000" }),
				signal: client.signal,
			}),
		);

		try {
			expect(await raceSettle(resPromise)).toBe("settled");
			expect(abortedAtExecStart).toBe(true);
		} finally {
			abandonExec();
			await resPromise.catch(() => undefined);
		}
	});

	it("keeps writes the script already committed after a disconnect abort", async () => {
		const sandboxId = `${SANDBOX_ID}-commit`;
		const { sessionManager, fs, app } = await makeTestEnv(sandboxId);
		const token = await makeToken();
		const session = await sessionManager.getOrCreate("default", sandboxId, undefined, "agent-1");

		let execStarted!: () => void;
		const started = new Promise<void>((r) => {
			execStarted = r;
		});
		let abandonExec!: () => void;

		vi.spyOn(session.bash, "exec").mockImplementation(
			(_script, opts) =>
				new Promise((_resolve, reject) => {
					abandonExec = () => reject(new DOMException("The operation was aborted", "AbortError"));
					opts?.signal?.addEventListener("abort", abandonExec, { once: true });
					// The script commits half its work, then hangs past the disconnect.
					fs.writeFile("/committed.txt", "half-done").then(execStarted);
				}),
		);

		const client = new AbortController();
		const resPromise = settleable(
			app.request(`/v1/sandboxes/${sandboxId}/exec-sync`, {
				method: "POST",
				headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
				body: JSON.stringify({ script: "echo half-done > /committed.txt; sleep 1000" }),
				signal: client.signal,
			}),
		);

		await started;
		client.abort();

		try {
			expect(await raceSettle(resPromise)).toBe("settled");
			expect(await fs.readFile("/committed.txt")).toBe("half-done");
		} finally {
			abandonExec();
			await resPromise.catch(() => undefined);
		}
	});
});

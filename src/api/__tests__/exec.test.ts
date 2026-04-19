/**
 * Unit tests for exec routes.
 * US-068: POST /v1/sandboxes/:id/exec-sync — buffered execution
 * US-069: POST /v1/sandboxes/:id/exec — SSE streaming execution
 */

import { Hono } from "hono";
import { SignJWT } from "jose";
import { InMemoryFs } from "just-bash";
import type { IFileSystem } from "just-bash";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AuthVariables, authMiddleware } from "../auth.js";
import { execRoutes } from "../routes/exec.js";
import { SessionManager } from "../session-manager.js";

const AUTH_SECRET = "test-secret-for-exec-tests-at-least-32bytes!";
const secretBytes = new TextEncoder().encode(AUTH_SECRET);

async function makeToken(sub = "agent-1"): Promise<string> {
	return new SignJWT({ sub }).setProtectedHeader({ alg: "HS256" }).sign(secretBytes);
}

function makeTestEnv(): { sessionManager: SessionManager; fs: IFileSystem } {
	const fs = new InMemoryFs();
	const sessionManager = new SessionManager({
		backend: "memory",
		createFs: async () => fs,
	});
	return { sessionManager, fs };
}

function makeTestApp(sessionManager: SessionManager) {
	const app = new Hono<{ Variables: AuthVariables }>();
	app.use("/v1/*", authMiddleware);
	app.route("/v1/sandboxes", execRoutes(sessionManager));
	return app;
}

const SANDBOX_ID = "test-exec-sandbox";

describe("POST /v1/sandboxes/:id/exec-sync", () => {
	beforeEach(() => {
		process.env.AUTH_SECRET = AUTH_SECRET;
	});

	afterEach(() => {
		process.env.AUTH_SECRET = "";
	});

	it("echo hello returns stdout with hello and exitCode 0", async () => {
		const { sessionManager } = makeTestEnv();
		const app = makeTestApp(sessionManager);
		const token = await makeToken();

		const res = await app.request(`/v1/sandboxes/${SANDBOX_ID}/exec-sync`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ script: "echo hello" }),
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as { stdout: string; stderr: string; exitCode: number };
		expect(body.stdout).toBe("hello\n");
		expect(body.exitCode).toBe(0);
	});

	it("false command returns exitCode 1", async () => {
		const { sessionManager } = makeTestEnv();
		const app = makeTestApp(sessionManager);
		const token = await makeToken();

		const res = await app.request(`/v1/sandboxes/${SANDBOX_ID}/exec-sync`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ script: "false" }),
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as { stdout: string; stderr: string; exitCode: number };
		expect(body.exitCode).toBe(1);
	});

	it("timeout returns 408", async () => {
		const { sessionManager } = makeTestEnv();
		const app = makeTestApp(sessionManager);
		const token = await makeToken();

		const timeoutSandboxId = `${SANDBOX_ID}-timeout`;

		// Pre-create the session so we can spy on bash.exec
		const session = await sessionManager.getOrCreate(timeoutSandboxId);

		// Mock bash.exec to hang, but respond to the abort signal
		vi.spyOn(session.bash, "exec").mockImplementation(
			(_script, opts) =>
				new Promise((_resolve, reject) => {
					const handle = setTimeout(() => {
						// Should never reach here in the timeout test
					}, 60_000);
					opts?.signal?.addEventListener("abort", () => {
						clearTimeout(handle);
						reject(new DOMException("The operation was aborted", "AbortError"));
					});
				}),
		);

		const res = await app.request(`/v1/sandboxes/${timeoutSandboxId}/exec-sync`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ script: "sleep 1000", timeoutMs: 50 }),
		});

		expect(res.status).toBe(408);
		const body = (await res.json()) as { error: string; code: string };
		expect(body.code).toBe("EXEC_TIMEOUT");

		vi.restoreAllMocks();
	});
});

// Helper: parse SSE response body into events array
function parseSseEvents(body: string): Array<{ event: string; data: unknown }> {
	const events: Array<{ event: string; data: unknown }> = [];
	const blocks = body.split("\n\n").filter((b) => b.trim());
	for (const block of blocks) {
		const lines = block.split("\n");
		let event = "message";
		let data = "";
		for (const line of lines) {
			if (line.startsWith("event: ")) event = line.slice(7).trim();
			if (line.startsWith("data: ")) data = line.slice(6).trim();
		}
		if (data) events.push({ event, data: JSON.parse(data) });
	}
	return events;
}

describe("POST /v1/sandboxes/:id/exec (SSE streaming)", () => {
	beforeEach(() => {
		process.env.AUTH_SECRET = AUTH_SECRET;
	});

	afterEach(() => {
		process.env.AUTH_SECRET = "";
	});

	it("executes script and streams stdout and exit events", async () => {
		const { sessionManager } = makeTestEnv();
		const app = makeTestApp(sessionManager);
		const token = await makeToken();

		const res = await app.request(`/v1/sandboxes/${SANDBOX_ID}/exec`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ script: "echo hello" }),
		});

		expect(res.headers.get("content-type")).toContain("text/event-stream");

		const bodyText = await res.text();
		const events = parseSseEvents(bodyText);

		const stdoutEvent = events.find((e) => e.event === "stdout");
		const exitEvent = events.find((e) => e.event === "exit");

		expect(stdoutEvent).toBeDefined();
		expect((stdoutEvent?.data as { t: string; data: string }).data).toBe("hello\n");
		expect(exitEvent).toBeDefined();
		expect((exitEvent?.data as { t: string; exitCode: number }).exitCode).toBe(0);
	});
});

/**
 * Unit tests for exec routes.
 * US-068: POST /v1/sandboxes/:id/exec-sync — buffered execution
 * US-069: POST /v1/sandboxes/:id/exec — SSE streaming execution
 * US-070: Exec timeout enforcement
 */

import { Hono } from "hono";
import { SignJWT } from "jose";
import { InMemoryFs } from "just-bash";
import type { IFileSystem } from "just-bash";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxMeta } from "../../fs/sql-fs/types.js";
import { type AuthVariables, authMiddleware } from "../auth.js";
import { execRoutes } from "../routes/exec.js";
import { SessionManager } from "../session-manager.js";

const AUTH_SECRET = "test-secret-for-exec-tests-at-least-32bytes!";
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
		const { sessionManager } = await makeTestEnv();
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
		const body = (await res.json()) as {
			stdout: string;
			stderr: string;
			exitCode: number;
			exitSignal: string | null;
			timedOut: boolean;
			durationMs: number;
		};
		expect(body.stdout).toBe("hello\n");
		expect(body.exitCode).toBe(0);
		expect(body.exitSignal).toBeNull();
		expect(body.timedOut).toBe(false);
		expect(body.durationMs).toBeGreaterThanOrEqual(0);
	});

	it("false command returns exitCode 1", async () => {
		const { sessionManager } = await makeTestEnv();
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
		const body = (await res.json()) as {
			exitCode: number;
			exitSignal: string | null;
			timedOut: boolean;
			durationMs: number;
		};
		expect(body.exitCode).toBe(1);
		expect(body.exitSignal).toBeNull();
		expect(body.timedOut).toBe(false);
		expect(body.durationMs).toBeGreaterThanOrEqual(0);
	});

	it.each(["text/x-shellscript", "text/plain"])("accepts %s content type with raw script body", async (ct) => {
		const { sessionManager } = await makeTestEnv();
		const app = makeTestApp(sessionManager);
		const token = await makeToken();

		const res = await app.request(`/v1/sandboxes/${SANDBOX_ID}/exec-sync`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": ct,
			},
			body: "echo hello",
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as { stdout: string; stderr: string; exitCode: number };
		expect(body.stdout).toBe("hello\n");
		expect(body.exitCode).toBe(0);
	});

	it("accepts text/plain with charset parameter", async () => {
		const { sessionManager } = await makeTestEnv();
		const app = makeTestApp(sessionManager);
		const token = await makeToken();

		const res = await app.request(`/v1/sandboxes/${SANDBOX_ID}/exec-sync`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "text/plain; charset=utf-8",
			},
			body: "echo hello",
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as { stdout: string; exitCode: number };
		expect(body.stdout).toBe("hello\n");
		expect(body.exitCode).toBe(0);
	});

	it("supports timeoutMs query param with plaintext body", async () => {
		const { sessionManager } = await makeTestEnv();
		const app = makeTestApp(sessionManager);
		const token = await makeToken();

		const res = await app.request(`/v1/sandboxes/${SANDBOX_ID}/exec-sync?timeoutMs=60000`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "text/x-shellscript",
			},
			body: "echo hello",
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as { stdout: string; exitCode: number };
		expect(body.stdout).toBe("hello\n");
	});

	it("rejects invalid timeoutMs query param with plaintext body", async () => {
		const { sessionManager } = await makeTestEnv();
		const app = makeTestApp(sessionManager);
		const token = await makeToken();

		const res = await app.request(`/v1/sandboxes/${SANDBOX_ID}/exec-sync?timeoutMs=abc`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "text/x-shellscript",
			},
			body: "echo hello",
		});

		expect(res.status).toBe(400);
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("INVALID_INPUT");
	});

	it("rejects timeoutMs exceeding maximum with plaintext body", async () => {
		const { sessionManager } = await makeTestEnv();
		const app = makeTestApp(sessionManager);
		const token = await makeToken();

		const res = await app.request(`/v1/sandboxes/${SANDBOX_ID}/exec-sync?timeoutMs=999999`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "text/x-shellscript",
			},
			body: "echo hello",
		});

		expect(res.status).toBe(400);
		const body = (await res.json()) as { code: string; details: string[] };
		expect(body.code).toBe("INVALID_INPUT");
		expect(body.details[0]).toContain("300000");
	});

	it("rejects empty plaintext body", async () => {
		const { sessionManager } = await makeTestEnv();
		const app = makeTestApp(sessionManager);
		const token = await makeToken();

		const res = await app.request(`/v1/sandboxes/${SANDBOX_ID}/exec-sync`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "text/x-shellscript",
			},
			body: "",
		});

		expect(res.status).toBe(400);
		const body = (await res.json()) as { code: string; details: string[] };
		expect(body.code).toBe("INVALID_INPUT");
		expect(body.details).toContain("Empty script body");
	});

	it("returns 415 for unsupported content type", async () => {
		const { sessionManager } = await makeTestEnv();
		const app = makeTestApp(sessionManager);
		const token = await makeToken();

		const res = await app.request(`/v1/sandboxes/${SANDBOX_ID}/exec-sync`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/xml",
			},
			body: "<script>echo hello</script>",
		});

		expect(res.status).toBe(415);
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("UNSUPPORTED_MEDIA_TYPE");
	});

	it("handles scripts with quotes and special characters via plaintext", async () => {
		const { sessionManager } = await makeTestEnv();
		const app = makeTestApp(sessionManager);
		const token = await makeToken();

		const script = `echo "hello 'world'" && echo $'line1\\nline2'`;
		const res = await app.request(`/v1/sandboxes/${SANDBOX_ID}/exec-sync`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "text/x-shellscript",
			},
			body: script,
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as { stdout: string; exitCode: number };
		expect(body.exitCode).toBe(0);
	});

	it("timeout returns 408 with timedOut and durationMs", async () => {
		const { sessionManager } = await makeTestEnv();
		const app = makeTestApp(sessionManager);
		const token = await makeToken();

		const timeoutSandboxId = `${SANDBOX_ID}-timeout`;

		// Pre-create the session so we can spy on bash.exec
		const session = await sessionManager.getOrCreate("default", timeoutSandboxId);

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
		const body = (await res.json()) as { error: string; code: string; timedOut: boolean; durationMs: number };
		expect(body.code).toBe("EXEC_TIMEOUT");
		expect(body.timedOut).toBe(true);
		expect(body.durationMs).toBeGreaterThanOrEqual(0);

		vi.restoreAllMocks();
	});

	it("debug mode prepends set -x and produces trace output in stderr", async () => {
		const { sessionManager } = await makeTestEnv();
		const app = makeTestApp(sessionManager);
		const token = await makeToken();

		const res = await app.request(`/v1/sandboxes/${SANDBOX_ID}/exec-sync`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ script: "echo hello", debug: true }),
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as { stdout: string; stderr: string; exitCode: number; timedOut: boolean };
		expect(body.stdout).toBe("hello\n");
		expect(body.exitCode).toBe(0);
		expect(body.timedOut).toBe(false);
		expect(body.stderr).toContain("+ echo hello");
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
		const { sessionManager } = await makeTestEnv();
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

	it.each(["text/x-shellscript", "text/plain"])("accepts %s content type for SSE streaming", async (ct) => {
		const { sessionManager } = await makeTestEnv();
		const app = makeTestApp(sessionManager);
		const token = await makeToken();

		const res = await app.request(`/v1/sandboxes/${SANDBOX_ID}/exec`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": ct,
			},
			body: "echo hello",
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

	it("SSE streaming respects timeoutMs query param with plaintext body", async () => {
		const { sessionManager } = await makeTestEnv();
		const app = makeTestApp(sessionManager);
		const token = await makeToken();

		const timeoutSandboxId = `${SANDBOX_ID}-sse-plaintext-timeout`;

		const session = await sessionManager.getOrCreate("default", timeoutSandboxId);

		vi.spyOn(session.bash, "exec").mockImplementation(
			(_script, opts) =>
				new Promise((_resolve, reject) => {
					const handle = setTimeout(() => {}, 60_000);
					opts?.signal?.addEventListener("abort", () => {
						clearTimeout(handle);
						reject(new DOMException("The operation was aborted", "AbortError"));
					});
				}),
		);

		const res = await app.request(`/v1/sandboxes/${timeoutSandboxId}/exec?timeoutMs=50`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "text/x-shellscript",
			},
			body: "sleep 1000",
		});

		expect(res.headers.get("content-type")).toContain("text/event-stream");

		const bodyText = await res.text();
		const events = parseSseEvents(bodyText);

		const exitEvent = events.find((e) => e.event === "exit");
		expect(exitEvent).toBeDefined();
		expect((exitEvent?.data as { t: string; exitCode: number; error: string }).exitCode).toBe(-1);
		expect((exitEvent?.data as { t: string; exitCode: number; error: string }).error).toBe("timeout");

		vi.restoreAllMocks();
	});

	it("timeout sends exit event with exitCode -1 and error='timeout'", async () => {
		const { sessionManager } = await makeTestEnv();
		const app = makeTestApp(sessionManager);
		const token = await makeToken();

		const timeoutSandboxId = `${SANDBOX_ID}-sse-timeout`;

		// Pre-create session so we can spy on bash.exec
		const session = await sessionManager.getOrCreate("default", timeoutSandboxId);

		// Mock bash.exec to hang but respond to abort signal
		vi.spyOn(session.bash, "exec").mockImplementation(
			(_script, opts) =>
				new Promise((_resolve, reject) => {
					const handle = setTimeout(() => {
						// Should not reach here in the timeout test
					}, 60_000);
					opts?.signal?.addEventListener("abort", () => {
						clearTimeout(handle);
						reject(new DOMException("The operation was aborted", "AbortError"));
					});
				}),
		);

		const res = await app.request(`/v1/sandboxes/${timeoutSandboxId}/exec`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ script: "sleep 1000", timeoutMs: 50 }),
		});

		expect(res.headers.get("content-type")).toContain("text/event-stream");

		const bodyText = await res.text();
		const events = parseSseEvents(bodyText);

		const exitEvent = events.find((e) => e.event === "exit");
		expect(exitEvent).toBeDefined();
		expect((exitEvent?.data as { t: string; exitCode: number; error: string }).exitCode).toBe(-1);
		expect((exitEvent?.data as { t: string; exitCode: number; error: string }).error).toBe("timeout");

		vi.restoreAllMocks();
	});

	it("rejects unauthorized cold-replica SSE requests before opening the stream", async () => {
		const meta = new Map<string, SandboxMeta>();
		const ownerManager = new SessionManager({
			createFs: async () => new InMemoryFs(),
			getSandboxMetaFn: async (_tenantId, sandboxId) => meta.get(sandboxId) ?? null,
			persistSandboxMetaFn: async (_tenantId, sandboxId, sandboxMeta) => {
				meta.set(sandboxId, sandboxMeta);
			},
		});
		await ownerManager.withSession("default", SANDBOX_ID, async (session) => {
			session.owner = "agent-1";
			await ownerManager.persistSandboxMeta("default", SANDBOX_ID, {
				owner: "agent-1",
				python: false,
				javascript: false,
			});
		});

		const coldReplica = new SessionManager({
			createFs: async () => new InMemoryFs(),
			getSandboxMetaFn: async (_tenantId, sandboxId) => meta.get(sandboxId) ?? null,
		});
		const app = makeTestApp(coldReplica);
		const token = await makeToken("agent-2");

		const res = await app.request(`/v1/sandboxes/${SANDBOX_ID}/exec`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ script: "echo hello" }),
		});

		expect(res.status).toBe(403);
		expect(res.headers.get("content-type")).not.toContain("text/event-stream");
		const body = (await res.json()) as { error: string; code: string };
		expect(body).toEqual({ error: "forbidden", code: "FORBIDDEN" });
	});
});

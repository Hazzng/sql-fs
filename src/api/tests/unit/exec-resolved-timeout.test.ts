import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Hono } from "hono";
import { SignJWT } from "jose";
import { InMemoryFs } from "just-bash";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AuthVariables, authMiddleware } from "../../auth.js";
import { registerTools } from "../../mcp/tools.js";
import { execRoutes } from "../../routes/exec.js";
import { SessionManager } from "../../session-manager.js";

const secret = "test-secret-resolved-timeout-at-least-32bytes";
const sandboxId = "resolved-timeout";
const script = "echo prefix > /prefix; sleep 2; echo suffix > /suffix";

afterEach(() => {
	process.env.AUTH_SECRET = "";
	vi.restoreAllMocks();
});

async function setup() {
	process.env.AUTH_SECRET = secret;
	const fs = new InMemoryFs();
	const manager = new SessionManager({ createFs: async () => fs });
	await manager.getOrCreate("default", sandboxId, undefined, "owner");
	const app = new Hono<{ Variables: AuthVariables }>();
	app.use("/v1/*", authMiddleware);
	app.route("/v1/sandboxes", execRoutes(manager));
	const token = await new SignJWT({ sub: "owner" })
		.setProtectedHeader({ alg: "HS256" })
		.sign(new TextEncoder().encode(secret));
	const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
	return { fs, manager, app, headers };
}

describe("resolved just-bash cancellation", () => {
	it("returns HTTP 408 when real Bash resolves cancellation with exit 124", async () => {
		const { fs, app, headers } = await setup();
		const response = await app.request(`/v1/sandboxes/${sandboxId}/exec-sync`, {
			method: "POST",
			headers,
			body: JSON.stringify({ script, timeoutMs: 100 }),
		});
		expect(response.status).toBe(408);
		expect(await response.json()).toMatchObject({ code: "EXEC_TIMEOUT", timedOut: true });
		expect(await fs.readFile("/prefix")).toBe("prefix\n");
		expect(await fs.exists("/suffix")).toBe(false);
	});

	it("keeps an explicit exit 124 as a completed command", async () => {
		const { app, headers } = await setup();
		const response = await app.request(`/v1/sandboxes/${sandboxId}/exec-sync`, {
			method: "POST",
			headers,
			body: JSON.stringify({ script: "exit 124", timeoutMs: 1000 }),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ exitCode: 124, timedOut: false });
	});

	it("reports SSE timeout and leaves the cancelled suffix absent", async () => {
		const { fs, app, headers } = await setup();
		const response = await app.request(`/v1/sandboxes/${sandboxId}/exec`, {
			method: "POST",
			headers,
			body: JSON.stringify({ script, timeoutMs: 100 }),
		});
		const text = await response.text();
		expect(text).toContain('"error":"timeout"');
		expect(text).toContain('"exitCode":-1');
		expect(await fs.readFile("/prefix")).toBe("prefix\n");
		expect(await fs.exists("/suffix")).toBe(false);
	});

	it.each([false, true])("reports a real batch deadline with readOnly=%s", async (readOnly) => {
		const { app, headers } = await setup();
		const response = await app.request(`/v1/sandboxes/${sandboxId}/exec-sync-batch`, {
			method: "POST",
			headers,
			body: JSON.stringify({ scripts: [{ id: "slow", script: "sleep 2; echo suffix" }], timeoutMs: 100, readOnly }),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ results: [{ id: "slow", exitCode: -1, error: "timeout" }] });
	});

	it("reports a real MCP deadline without replaying the cancelled script", async () => {
		const { fs, manager } = await setup();
		type Handler = (
			args: { id: string; script: string; timeout: number },
			extra: { signal: AbortSignal },
		) => Promise<{ content: Array<{ text: string }> }>;
		let handler: Handler | undefined;
		const server = {
			tool(name: string, _description: unknown, _schema: unknown, callback: Handler) {
				if (name === "bash_exec") handler = callback;
			},
		} as unknown as McpServer;
		registerTools(server, manager, "owner", "default");
		const result = await handler?.({ id: sandboxId, script, timeout: 100 }, { signal: new AbortController().signal });
		expect(JSON.parse(result!.content[0]!.text)).toMatchObject({ exitCode: -1, timedOut: true });
		expect(await fs.readFile("/prefix")).toBe("prefix\n");
		expect(await fs.exists("/suffix")).toBe(false);
	});

	it("preserves an unknown worker failure after the SSE timeout fires", async () => {
		const { app, headers, manager } = await setup();
		vi.spyOn(manager, "execWithRuntimeThrottle").mockImplementation(
			(_session, _script, options) =>
				new Promise((_resolve, reject) => {
					options?.signal?.addEventListener(
						"abort",
						() => reject(Object.assign(new Error("Execution outcome is unknown"), { code: "EEXEC_OUTCOME_UNKNOWN" })),
						{ once: true },
					);
				}),
		);
		const response = await app.request(`/v1/sandboxes/${sandboxId}/exec`, {
			method: "POST",
			headers,
			body: JSON.stringify({ script: "busy", timeoutMs: 10 }),
		});
		const text = await response.text();
		expect(text).toContain("event: error");
		expect(text).toContain('"retryable":false');
		expect(text).not.toContain('"error":"timeout"');
	});

	it("preserves an unknown worker failure after the MCP timeout fires", async () => {
		const { manager } = await setup();
		vi.spyOn(manager, "execWithRuntimeThrottle").mockImplementation(
			(_session, _script, options) =>
				new Promise((_resolve, reject) => {
					options?.signal?.addEventListener(
						"abort",
						() => reject(Object.assign(new Error("Execution outcome is unknown"), { code: "EEXEC_OUTCOME_UNKNOWN" })),
						{ once: true },
					);
				}),
		);
		type Handler = (
			args: { id: string; script: string; timeout: number },
			extra: { signal: AbortSignal },
		) => Promise<unknown>;
		let handler: Handler | undefined;
		const server = {
			tool(name: string, _description: unknown, _schema: unknown, callback: Handler) {
				if (name === "bash_exec") handler = callback;
			},
		} as unknown as McpServer;
		registerTools(server, manager, "owner", "default");
		const result = await handler?.(
			{ id: sandboxId, script: "busy", timeout: 10 },
			{ signal: new AbortController().signal },
		);
		expect(result).toMatchObject({
			isError: true,
			structuredContent: { code: "EEXEC_OUTCOME_UNKNOWN", retryable: false },
		});
	});
});

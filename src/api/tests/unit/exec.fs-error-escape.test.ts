import { Hono } from "hono";
import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqlFs } from "../../../sql-fs/sql-fs.js";
import { makeProbeDialect } from "../../../sql-fs/tests/fixtures/buffered-dialect.js";
import { type AuthVariables, authMiddleware } from "../../auth.js";
import { apiErrorHandler } from "../../errors.js";
import { registerTools } from "../../mcp/tools.js";
import { execRoutes } from "../../routes/exec.js";
import { SessionManager } from "../../session-manager.js";
import { captureToolHandlers, requireHandler } from "../helpers/mcp.js";

const AUTH_SECRET = "test-secret-for-exec-tests-at-least-32bytes!";
const SANDBOX_ID = "sb-fs-escape";
const ESCAPING_SCRIPT = "mkdir /d; { rm -rf /d; echo x; } > /d/out";
const EXPECTED_MESSAGE =
	"EEXEC_FS: the script hit a filesystem error the shell did not handle (ENOENT: no such file or directory, '/d')";

async function sqlFsSessionManager(): Promise<SessionManager> {
	const sm = new SessionManager({
		createFs: async (_tenant, sandboxId) => {
			const fs = new SqlFs({ dialect: makeProbeDialect().dialect, sandboxId });
			await fs.ready();
			return fs;
		},
	});
	await sm.getOrCreate("default", SANDBOX_ID, undefined, "agent-1");
	return sm;
}

function execApp(sm: SessionManager): Hono<{ Variables: AuthVariables }> {
	const app = new Hono<{ Variables: AuthVariables }>();
	app.use("/v1/*", authMiddleware);
	app.route("/v1/sandboxes", execRoutes(sm));
	app.onError(apiErrorHandler);
	return app;
}

async function post(app: Hono<{ Variables: AuthVariables }>, path: string, script: string): Promise<Response> {
	const token = await new SignJWT({ sub: "agent-1" })
		.setProtectedHeader({ alg: "HS256" })
		.sign(new TextEncoder().encode(AUTH_SECRET));
	return app.request(path, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		body: JSON.stringify({ script }),
	});
}

function loggedEvents(spy: ReturnType<typeof vi.spyOn>): unknown[] {
	return spy.mock.calls.map((call: unknown[]) => JSON.parse(String(call[0])));
}

describe("a filesystem error escaping bash.exec", () => {
	let sm: SessionManager;
	let errorSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(async () => {
		process.env.AUTH_SECRET = AUTH_SECRET;
		vi.spyOn(console, "log").mockImplementation(() => {});
		errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		sm = await sqlFsSessionManager();
	});

	afterEach(async () => {
		await sm.shutdown();
		vi.restoreAllMocks();
		process.env.AUTH_SECRET = "";
	});

	it("answers exec-sync with 500 EEXEC_FS, not retryable", async () => {
		const res = await post(execApp(sm), `/v1/sandboxes/${SANDBOX_ID}/exec-sync`, ESCAPING_SCRIPT);

		expect({ status: res.status, body: await res.json() }).toEqual({
			status: 500,
			body: { error: EXPECTED_MESSAGE, code: "EEXEC_FS", retryable: false },
		});
	});

	it("logs the escaped error with its sandbox and original code", async () => {
		await post(execApp(sm), `/v1/sandboxes/${SANDBOX_ID}/exec-sync`, ESCAPING_SCRIPT);

		expect(loggedEvents(errorSpy)).toContainEqual({
			event: "exec_fs_error",
			tenantId: "default",
			sandboxId: SANDBOX_ID,
			code: "ENOENT",
			error: "ENOENT: no such file or directory, '/d'",
		});
	});

	it("sends EEXEC_FS in the SSE error frame", async () => {
		const res = await post(execApp(sm), `/v1/sandboxes/${SANDBOX_ID}/exec`, ESCAPING_SCRIPT);

		expect(await res.text()).toContain(
			`data: ${JSON.stringify({ t: "error", code: "EEXEC_FS", error: EXPECTED_MESSAGE, retryable: false })}`,
		);
	});

	it("does not tell an MCP client the sandbox is gone", async () => {
		const { server, handlers } = captureToolHandlers();
		registerTools(server, sm, "agent-1", "default");

		const result = await requireHandler(handlers, "bash_exec")(
			{ id: SANDBOX_ID, script: ESCAPING_SCRIPT },
			{ signal: new AbortController().signal },
		);

		expect(result).toEqual({
			content: [{ type: "text", text: JSON.stringify({ stdout: "", stderr: EXPECTED_MESSAGE, exitCode: 1 }) }],
		});
	});

	it("keeps 404 ENOENT for a sandbox that does not exist", async () => {
		const res = await post(execApp(sm), "/v1/sandboxes/sb-missing/exec-sync", "true");

		expect({ status: res.status, body: await res.json() }).toEqual({
			status: 404,
			body: { error: "ENOENT: sandbox sb-missing not found", code: "ENOENT", retryable: false },
		});
	});
});

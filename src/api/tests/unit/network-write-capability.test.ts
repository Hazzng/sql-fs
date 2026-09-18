/**
 * Unit tests for the `networkWrite` capability (v3 Phase 5).
 *
 * Covers the create-route schema and its one cross-field rule, the MCP
 * `sandbox_create` surface, and the `SQLFS_HTTP_WRITE` shell-env export.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Hono } from "hono";
import { SignJWT } from "jose";
import { InMemoryFs } from "just-bash";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AuthVariables, authMiddleware } from "../../auth.js";
import { HTTP_WRITE_ENV_VAR } from "../../commands/pip-command.js";
import { registerTools } from "../../mcp/tools.js";
import { NETWORK_WRITE_REQUIRES_NETWORK, sandboxRoutes } from "../../routes/sandboxes.js";
import { SessionManager, buildRuntimeSandboxEnv } from "../../session-manager.js";

const AUTH_SECRET = "test-secret-for-network-write-tests-32b!!";

async function makeToken(sub = "owner-nw"): Promise<string> {
	return new SignJWT({ sub }).setProtectedHeader({ alg: "HS256" }).sign(new TextEncoder().encode(AUTH_SECRET));
}

function makeApp(): { app: Hono<{ Variables: AuthVariables }>; sessionManager: SessionManager } {
	const fs = new InMemoryFs();
	const sessionManager = new SessionManager({ createFs: async () => fs });
	const app = new Hono<{ Variables: AuthVariables }>();
	app.use("/v1/*", authMiddleware);
	app.route("/v1/sandboxes", sandboxRoutes(sessionManager));
	return { app, sessionManager };
}

describe("POST /v1/sandboxes — networkWrite", () => {
	beforeEach(() => {
		process.env.AUTH_SECRET = AUTH_SECRET;
	});

	afterEach(() => {
		process.env.AUTH_SECRET = "";
	});

	it("accepts networkWrite with network and reports it on the session and the response", async () => {
		const { app, sessionManager } = makeApp();
		const token = await makeToken();

		const res = await app.request("/v1/sandboxes", {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ python: true, network: true, networkWrite: true }),
		});

		expect(res.status).toBe(201);
		const body = (await res.json()) as { id: string; network: boolean; networkWrite: boolean };
		expect(body.network).toBe(true);
		expect(body.networkWrite).toBe(true);
		expect(sessionManager.getSession("default", body.id)?.runtimeOptions.networkWrite).toBe(true);
	});

	it("defaults networkWrite to false on a network sandbox that did not ask for it", async () => {
		const { app, sessionManager } = makeApp();
		const token = await makeToken();

		const res = await app.request("/v1/sandboxes", {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ network: true }),
		});

		expect(res.status).toBe(201);
		const body = (await res.json()) as { id: string; networkWrite: boolean };
		expect(body.networkWrite).toBe(false);
		expect(sessionManager.getSession("default", body.id)?.runtimeOptions.networkWrite).toBe(false);
	});

	it("rejects networkWrite without network with a 400 naming both fields", async () => {
		const { app } = makeApp();
		const token = await makeToken();

		const res = await app.request("/v1/sandboxes", {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ networkWrite: true }),
		});

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({
			error: "validation_error",
			code: "INVALID_INPUT",
			details: ["networkWrite requires network: true (the sandbox has no outbound access without it)"],
		});
	});

	it("rejects a non-boolean networkWrite", async () => {
		const { app } = makeApp();
		const token = await makeToken();

		const res = await app.request("/v1/sandboxes", {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ network: true, networkWrite: "yes" }),
		});

		expect(res.status).toBe(400);
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("INVALID_INPUT");
	});
});

type ToolCall = { schema: Record<string, unknown>; handler: (args: Record<string, unknown>) => Promise<unknown> };

function captureSandboxCreate(sessionManager: SessionManager): ToolCall {
	let captured: ToolCall | undefined;
	const server = {
		tool: (name: string, _desc: unknown, schema: Record<string, unknown>, handler: ToolCall["handler"]) => {
			if (name === "sandbox_create") captured = { schema, handler };
		},
	} as unknown as McpServer;
	registerTools(server, sessionManager, "owner-nw", "default");
	if (captured === undefined) throw new Error("sandbox_create was not registered");
	return captured;
}

describe("MCP sandbox_create — networkWrite", () => {
	it("declares networkWrite as an optional boolean in the tool schema", () => {
		const { schema } = captureSandboxCreate(new SessionManager({ createFs: async () => new InMemoryFs() }));
		expect(Object.keys(schema).sort()).toEqual(["javascript", "name", "network", "networkWrite", "python"]);
		const nwSchema = schema.networkWrite as { type?: string };
		expect(nwSchema).toBeDefined();
	});

	it("creates a sandbox with networkWrite and echoes it", async () => {
		const sessionManager = new SessionManager({ createFs: async () => new InMemoryFs() });
		const { handler } = captureSandboxCreate(sessionManager);

		const result = (await handler({ network: true, networkWrite: true })) as {
			content: [{ text: string }];
		};

		const payload = JSON.parse(result.content[0].text) as { id: string; networkWrite: boolean };
		expect(payload.networkWrite).toBe(true);
		expect(sessionManager.getSession("default", payload.id)?.runtimeOptions.networkWrite).toBe(true);
	});

	it("refuses networkWrite without network", async () => {
		const sessionManager = new SessionManager({ createFs: async () => new InMemoryFs() });
		const { handler } = captureSandboxCreate(sessionManager);

		const result = (await handler({ networkWrite: true })) as { content: [{ text: string }] };

		expect(JSON.parse(result.content[0].text)).toEqual({
			ok: false,
			error: NETWORK_WRITE_REQUIRES_NETWORK,
		});
	});

	it("returns networkWrite false when explicitly passed as false", async () => {
		const sessionManager = new SessionManager({ createFs: async () => new InMemoryFs() });
		const { handler } = captureSandboxCreate(sessionManager);
		const result = (await handler({ network: true, networkWrite: false })) as {
			content: [{ text: string }];
		};
		const payload = JSON.parse(result.content[0].text) as { id: string; networkWrite: boolean };
		expect(payload.networkWrite).toBe(false);
	});

	it("rejects non-boolean networkWrite at the Zod schema level", () => {
		const { schema } = captureSandboxCreate(new SessionManager({ createFs: async () => new InMemoryFs() }));
		const nwSchema = schema.networkWrite as { safeParse?: (v: unknown) => { success: boolean } };
		expect(nwSchema.safeParse!(true).success).toBe(true);
		expect(nwSchema.safeParse!(false).success).toBe(true);
		expect(nwSchema.safeParse!(undefined).success).toBe(true);
		expect(nwSchema.safeParse!("yes").success).toBe(false);
		expect(nwSchema.safeParse!(1).success).toBe(false);
	});
});

describe("buildRuntimeSandboxEnv — SQLFS_HTTP_WRITE", () => {
	it("omits the variable for a default sandbox", () => {
		expect(buildRuntimeSandboxEnv({}, false)).toBeUndefined();
		expect(buildRuntimeSandboxEnv({ GIT_AUTHOR_NAME: "a" }, false)).toEqual({ GIT_AUTHOR_NAME: "a" });
	});

	it("omits the variable for a network sandbox without networkWrite", () => {
		expect(buildRuntimeSandboxEnv({}, true, false)).toBeUndefined();
	});

	it("exports SQLFS_HTTP_WRITE=1 when both flags are set", () => {
		expect(buildRuntimeSandboxEnv({}, true, true)).toEqual({ [HTTP_WRITE_ENV_VAR]: "1" });
		expect(HTTP_WRITE_ENV_VAR).toBe("SQLFS_HTTP_WRITE");
	});

	it("never exports it without network, even if networkWrite leaked through", () => {
		expect(buildRuntimeSandboxEnv({}, false, true)).toBeUndefined();
	});

	it("strips a leaked SQLFS_HTTP_WRITE from baseEnv when network is disabled", () => {
		const result = buildRuntimeSandboxEnv({ [HTTP_WRITE_ENV_VAR]: "1" }, false, true);
		expect(result).toBeUndefined();
	});

	it("strips a leaked SQLFS_HTTP_WRITE from baseEnv when networkWrite is false", () => {
		const result = buildRuntimeSandboxEnv({ [HTTP_WRITE_ENV_VAR]: "1", OTHER: "x" }, true, false);
		expect(result).toBeDefined();
		expect(result![HTTP_WRITE_ENV_VAR]).toBeUndefined();
		expect(result!.OTHER).toBe("x");
	});
});

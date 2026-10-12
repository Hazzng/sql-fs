import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { InMemoryFs } from "just-bash";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpServer } from "../../mcp/server.js";
import { registerTools } from "../../mcp/tools.js";
import { SessionManager } from "../../session-manager.js";

const sandboxId = "mcp-error-contract";
const tools = [
	{ name: "sandbox_create", arguments: {} },
	{ name: "sandbox_list", arguments: {} },
	{ name: "file_read", arguments: { id: sandboxId, path: "/file" } },
	{ name: "file_write", arguments: { id: sandboxId, path: "/file", content: "new" } },
	{ name: "file_edit", arguments: { id: sandboxId, path: "/file", oldString: "old", newString: "new" } },
	{ name: "sandbox_delete", arguments: { id: sandboxId } },
	{ name: "bash_exec", arguments: { id: sandboxId, script: "echo done" } },
	{ name: "bash_exec_batch", arguments: { id: sandboxId, scripts: [{ id: "one", script: "echo done" }] } },
	{ name: "fs_ingest", arguments: { id: sandboxId, files: { file: Buffer.from("new").toString("base64") } } },
	{ name: "fs_export", arguments: { id: sandboxId } },
];

async function setup(error: Error) {
	const fs = new InMemoryFs({ "/file": "old" });
	const manager = new SessionManager({ createFs: async () => fs });
	await manager.getOrCreate("default", sandboxId, undefined, "owner");
	vi.spyOn(manager, "getOrCreate").mockRejectedValue(error);
	vi.spyOn(manager, "listSandboxes").mockRejectedValue(error);
	vi.spyOn(manager, "withSessionOrRehydrate").mockRejectedValue(error);
	vi.spyOn(manager, "withSessionRead").mockRejectedValue(error);
	const server = createMcpServer();
	registerTools(server, manager, "owner", "default");
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "mcp-error-contract", version: "1" });
	await server.connect(serverTransport);
	await client.connect(clientTransport);
	return { client, close: async () => Promise.all([client.close(), server.close()]) };
}

afterEach(() => vi.restoreAllMocks());

describe("MCP error envelopes", () => {
	it.each(["EWORKER_BUSY", "EWORKER_UNAVAILABLE", "EEXEC_OUTCOME_UNKNOWN", "EEXEC_INPUT_LIMIT"])(
		"preserves %s for all ten tools through the MCP SDK",
		async (code) => {
			const retryable = code === "EWORKER_BUSY" || code === "EWORKER_UNAVAILABLE";
			const message = code === "EEXEC_INPUT_LIMIT" ? "Execution input exceeds its byte budget" : "worker fault";
			const error = Object.assign(new Error(message), { code });
			const { client, close } = await setup(error);
			try {
				for (const tool of tools) {
					const result = await client.callTool(tool);
					const body = {
						ok: false,
						code,
						error: message,
						retryable,
						...(code === "EWORKER_BUSY" ? { retryAfterMs: 1000 } : {}),
					};
					expect(result, tool.name).toEqual({
						isError: true,
						structuredContent: body,
						content: [{ type: "text", text: JSON.stringify(body) }],
					});
				}
			} finally {
				await close();
			}
		},
	);

	it("preserves each legacy envelope and hides infrastructure details", async () => {
		const { client, close } = await setup(new Error("postgres://private-user@private-host/private-db"));
		vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			for (const tool of tools) {
				const result = await client.callTool(tool);
				const body =
					tool.name === "bash_exec"
						? { stdout: "", stderr: "internal error", exitCode: 1 }
						: {
								ok: false,
								error: tool.name.startsWith("file_") ? "Internal server error" : "internal error",
							};
				expect(result, tool.name).toEqual({ content: [{ type: "text", text: JSON.stringify(body) }] });
			}
		} finally {
			await close();
		}
	});
});

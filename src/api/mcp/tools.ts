/**
 * MCP tool definitions and handlers.
 * US-078: MCP tool — sandbox_create
 * US-079: MCP tool — sandbox_delete
 */

import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SessionManager } from "../session-manager.js";

export function registerTools(server: McpServer, sessionManager: SessionManager): void {
	server.tool(
		"sandbox_create",
		"Create an isolated bash sandbox with a virtual filesystem",
		{ env: z.record(z.string(), z.string()).optional() },
		async (_args) => {
			const id = randomUUID();
			await sessionManager.getOrCreate(id);
			return {
				content: [{ type: "text" as const, text: JSON.stringify({ id }) }],
			};
		},
	);

	server.tool("sandbox_delete", "Delete a sandbox and all its files", { id: z.string() }, async (args) => {
		try {
			await sessionManager.destroy(args.id);
			return {
				content: [{ type: "text" as const, text: JSON.stringify({ ok: true }) }],
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return {
				content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: message }) }],
			};
		}
	});
}

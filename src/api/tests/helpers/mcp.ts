/** Shared MCP test harness: a minimal McpServer stub that captures registered tool handlers. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export type ToolHandler = (args: Record<string, unknown>, extra: { signal?: AbortSignal }) => Promise<unknown>;

/**
 * Stub server plus the map its registrations land in. Pass the server to `registerTools`, then
 * pull handlers out by name.
 */
export function captureToolHandlers(): { server: McpServer; handlers: Map<string, ToolHandler> } {
	const handlers = new Map<string, ToolHandler>();
	const server = {
		tool: (name: string, _desc: unknown, _schema: unknown, handler: ToolHandler) => handlers.set(name, handler),
	} as unknown as McpServer;
	return { server, handlers };
}

/** Handler for `name`, or a clear failure when the tool was never registered. */
export function requireHandler(handlers: Map<string, ToolHandler>, name: string): ToolHandler {
	const handler = handlers.get(name);
	if (handler === undefined) throw new Error(`Handler for '${name}' was not registered`);
	return handler;
}

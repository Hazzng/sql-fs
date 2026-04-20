/**
 * MCP server setup with streamable HTTP transport.
 * US-077: MCP server setup and streamable HTTP transport
 * US-078: MCP tool — sandbox_create
 */

import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { SessionManager } from "../session-manager.js";
import { registerTools } from "./tools.js";

// Map from MCP session ID to active transport for stateful session management
const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();

/**
 * Creates a new MCP server instance with virtualfs server info.
 */
export function createMcpServer(): McpServer {
	return new McpServer({
		name: "virtualfs",
		version: "1.0.0",
	});
}

/**
 * Handles an incoming MCP HTTP request (POST or GET SSE).
 * Reuses the existing transport for known sessions; creates a new one otherwise.
 */
export async function handleMcpRequest(req: Request, sessionManager: SessionManager): Promise<Response> {
	const sessionId = req.headers.get("mcp-session-id") ?? undefined;

	if (sessionId !== undefined && sessions.has(sessionId)) {
		const transport = sessions.get(sessionId) as WebStandardStreamableHTTPServerTransport;
		return transport.handleRequest(req);
	}

	const server = createMcpServer();
	registerTools(server, sessionManager);
	const transport = new WebStandardStreamableHTTPServerTransport({
		sessionIdGenerator: () => randomUUID(),
		onsessioninitialized: (id) => {
			sessions.set(id, transport);
		},
		onsessionclosed: (id) => {
			sessions.delete(id);
		},
	});

	await server.connect(transport);
	return transport.handleRequest(req);
}

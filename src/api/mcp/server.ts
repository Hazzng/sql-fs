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

// Map from MCP session ID to active transport + the principal that initiated it.
// The (owner, tenant) binding prevents session-id replay across principals: a
// leaked mcp-session-id cannot be used by another authenticated caller to act
// inside the original tool context.
interface SessionEntry {
	readonly transport: WebStandardStreamableHTTPServerTransport;
	readonly owner: string;
	readonly tenant: string;
}
const sessions = new Map<string, SessionEntry>();

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
 *
 * @param tenant - Tenant id resolved by the auth middleware; scopes every
 *   SessionManager call for the lifetime of this MCP session.
 */
export async function handleMcpRequest(
	req: Request,
	sessionManager: SessionManager,
	owner: string,
	tenant: string,
): Promise<Response> {
	const sessionId = req.headers.get("mcp-session-id") ?? undefined;

	if (sessionId !== undefined) {
		const existing = sessions.get(sessionId);
		if (existing !== undefined) {
			if (existing.owner !== owner || existing.tenant !== tenant) {
				return new Response(JSON.stringify({ error: "forbidden", code: "MCP_SESSION_FORBIDDEN" }), {
					status: 403,
					headers: { "Content-Type": "application/json" },
				});
			}
			return existing.transport.handleRequest(req);
		}
	}

	const server = createMcpServer();
	registerTools(server, sessionManager, owner, tenant);
	const transport = new WebStandardStreamableHTTPServerTransport({
		sessionIdGenerator: () => randomUUID(),
		onsessioninitialized: (id) => {
			sessions.set(id, { transport, owner, tenant });
		},
		onsessionclosed: (id) => {
			sessions.delete(id);
		},
	});

	await server.connect(transport);
	return transport.handleRequest(req);
}

/**
 * MCP server setup with streamable HTTP transport.
 * US-077: MCP server setup and streamable HTTP transport
 * US-078: MCP tool — sandbox_create
 */

import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { type SessionManager, assertIdleBelowVersionTtl } from "../session-manager.js";
import { registerTools } from "./tools.js";

// Map from MCP session ID to active transport + the principal that initiated it.
// The (owner, tenant) binding prevents session-id replay across principals: a
// leaked mcp-session-id cannot be used by another authenticated caller to act
// inside the original tool context.
interface SessionEntry {
	readonly transport: WebStandardStreamableHTTPServerTransport;
	readonly owner: string;
	readonly tenant: string;
	lastSeen: number;
}
const sessions = new Map<string, SessionEntry>();

const MCP_SESSION_IDLE_MS = Number(process.env.MCP_SESSION_IDLE_MS ?? "1800000"); // 30 min
// Audit F9b: the MCP idle window is a separate env-tunable that must obey the
// same version-key TTL invariant as SESSION_IDLE_MS. Redis presence is keyed off
// REDIS_URL here (this module has no live Redis handle at load time).
assertIdleBelowVersionTtl(MCP_SESSION_IDLE_MS, Boolean(process.env.REDIS_URL));
const MCP_SESSION_MAX = Number(process.env.MCP_SESSION_MAX ?? "1000");
const MCP_SWEEP_INTERVAL_MS = Number(process.env.MCP_SWEEP_INTERVAL_MS ?? "60000");

let sweeperTimer: ReturnType<typeof setInterval> | undefined;

function closeTransport(entry: SessionEntry): void {
	const t = entry.transport as { close?: () => void | Promise<void> };
	try {
		if (typeof t.close === "function") {
			// Audit L8: a rejected close() promise would otherwise surface as an
			// unhandled rejection (the surrounding try/catch only catches sync throws).
			const r = t.close();
			if (r !== undefined && typeof (r as Promise<void>).catch === "function") {
				(r as Promise<void>).catch(() => {});
			}
		}
	} catch {
		// best-effort
	}
}

/** Evict the oldest (by lastSeen) session to keep the map under MCP_SESSION_MAX. */
function evictOldest(): void {
	let oldestId: string | undefined;
	let oldestSeen = Number.POSITIVE_INFINITY;
	for (const [id, entry] of sessions) {
		if (entry.lastSeen < oldestSeen) {
			oldestSeen = entry.lastSeen;
			oldestId = id;
		}
	}
	if (oldestId !== undefined) {
		const entry = sessions.get(oldestId);
		sessions.delete(oldestId);
		if (entry !== undefined) closeTransport(entry);
	}
}

function sweepIdleMcpSessions(): void {
	const now = Date.now();
	for (const [id, entry] of sessions) {
		if (now - entry.lastSeen > MCP_SESSION_IDLE_MS) {
			sessions.delete(id);
			closeTransport(entry);
		}
	}
}

/** Start the idle sweeper. Idempotent; safe to call once at server startup. */
export function startMcpSessionSweeper(intervalMs: number = MCP_SWEEP_INTERVAL_MS): void {
	if (sweeperTimer !== undefined) return;
	sweeperTimer = setInterval(sweepIdleMcpSessions, intervalMs);
	if (typeof sweeperTimer.unref === "function") sweeperTimer.unref();
}

/** Stop the sweeper and close every active MCP transport. Used during shutdown. */
export async function shutdownMcp(): Promise<void> {
	if (sweeperTimer !== undefined) {
		clearInterval(sweeperTimer);
		sweeperTimer = undefined;
	}
	const entries = [...sessions.values()];
	sessions.clear();
	for (const entry of entries) closeTransport(entry);
}

/**
 * Creates a new MCP server instance with sqlfs server info.
 */
export function createMcpServer(): McpServer {
	return new McpServer({
		name: "sql-fs",
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
			existing.lastSeen = Date.now();
			return existing.transport.handleRequest(req);
		}
	}

	// Cap total live MCP sessions: each session holds an MCP server + transport
	// in memory, so unbounded growth from short-lived clients can leak.
	if (sessions.size >= MCP_SESSION_MAX) {
		sweepIdleMcpSessions();
		if (sessions.size >= MCP_SESSION_MAX) evictOldest();
	}

	const server = createMcpServer();
	registerTools(server, sessionManager, owner, tenant);
	const transport = new WebStandardStreamableHTTPServerTransport({
		sessionIdGenerator: () => randomUUID(),
		onsessioninitialized: (id) => {
			sessions.set(id, { transport, owner, tenant, lastSeen: Date.now() });
		},
		onsessionclosed: (id) => {
			sessions.delete(id);
		},
	});

	await server.connect(transport);
	return transport.handleRequest(req);
}

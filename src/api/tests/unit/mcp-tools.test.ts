/**
 * Unit tests for MCP bash_exec_batch tool.
 * Phase 1 (RED): pins the disconnect-signal forwarding contract that Phase 2 will implement.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryFs } from "just-bash";
import type { BashExecResult } from "just-bash";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerTools } from "../../mcp/tools.js";
import { SessionManager } from "../../session-manager.js";

const SANDBOX_ID = "mcp-cancel-sandbox";

// Minimal McpServer stub that captures tool handlers by name.
type ToolHandler = (args: Record<string, unknown>, extra: { signal?: AbortSignal }) => Promise<unknown>;

function captureToolHandler(name: string): {
	server: McpServer;
	getHandler: () => ToolHandler;
} {
	let captured: ToolHandler | undefined;
	const server = {
		tool: (toolName: string, _desc: unknown, _schema: unknown, handler: ToolHandler) => {
			if (toolName === name) captured = handler;
		},
	} as unknown as McpServer;
	return {
		server,
		getHandler: () => {
			if (captured === undefined) throw new Error(`Handler for '${name}' was not registered`);
			return captured;
		},
	};
}

describe("MCP tool — bash_exec_batch disconnect signal", () => {
	beforeEach(() => {
		process.env.AUTH_SECRET = "test-secret-mcp-tools-at-least-32bytes!!";
	});

	afterEach(() => {
		process.env.AUTH_SECRET = "";
		vi.restoreAllMocks();
	});

	// RED test: current MCP handler passes no signal to executeBatch, so MCP client
	// cancellation does NOT propagate into in-flight scripts. After Phase 2 wires
	// `extra.signal` into executeBatch's outerSignal, scripts abort at t≈10ms instead
	// of waiting for the batch deadline at t=60ms.
	it("forwards MCP cancellation into in-flight parallel scripts", async () => {
		vi.useFakeTimers();
		try {
			const sessionManager = new SessionManager({ createFs: async () => new InMemoryFs() });
			await sessionManager.getOrCreate("default", SANDBOX_ID);

			// Track the fake-clock timestamp when each script's abort signal fires.
			const start = Date.now();
			let firstAbortTime = -1;

			vi.spyOn(sessionManager, "execWithRuntimeThrottle").mockImplementation((_session, _script, opts) => {
				// Block indefinitely; only the abort signal can settle this promise.
				return new Promise<BashExecResult>((_, reject) => {
					opts?.signal?.addEventListener("abort", () => {
						if (firstAbortTime === -1) firstAbortTime = Date.now() - start;
						reject(new DOMException("Aborted", "AbortError"));
					});
				});
			});

			const { server, getHandler } = captureToolHandler("bash_exec_batch");
			registerTools(server, sessionManager, "test-owner", "default");
			const handler = getHandler();

			// MCP client disconnect controller — fires at t=10ms (fake).
			const mcpController = new AbortController();
			setTimeout(() => mcpController.abort(), 10);

			// Batch timeout of 60ms: without signal forwarding the batch deadline is the
			// only abort source and fires at t=60ms; with forwarding it fires at t=10ms.
			const handlerPromise = handler(
				{
					id: SANDBOX_ID,
					scripts: [
						{ id: "a", script: "block" },
						{ id: "b", script: "block" },
					],
					readOnly: true,
					timeout: 60,
				},
				{ signal: mcpController.signal },
			);

			// Advance past the batch deadline so the handler always settles (no hanging).
			await vi.advanceTimersByTimeAsync(200);
			await handlerPromise;

			// Phase 2 (GREEN): extra.signal forwarded → scripts aborted at t≈10ms → firstAbortTime < 30.
			// Current (RED): signal NOT forwarded → scripts aborted by batch deadline at t=60ms →
			//   firstAbortTime ≈ 60ms → assertion fails.
			expect(firstAbortTime).toBeLessThan(30);
		} finally {
			vi.useRealTimers();
		}
	});
});

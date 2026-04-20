/**
 * Unit tests for MCP server setup.
 * US-077: MCP server setup and streamable HTTP transport
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { createMcpServer } from "../mcp/server.js";

describe("MCP server", () => {
	it("initializes without error", () => {
		const server = createMcpServer();
		expect(server).toBeDefined();
		expect(server).toBeInstanceOf(McpServer);
	});
});

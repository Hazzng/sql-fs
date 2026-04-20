/**
 * Unit tests for MCP server setup.
 * US-077: MCP server setup and streamable HTTP transport
 * US-078: MCP tool — sandbox_create
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { createMcpServer } from "../mcp/server.js";
import { registerTools } from "../mcp/tools.js";
import type { Session } from "../session-manager.js";

describe("MCP server", () => {
	it("initializes without error", () => {
		const server = createMcpServer();
		expect(server).toBeDefined();
		expect(server).toBeInstanceOf(McpServer);
	});
});

describe("MCP tool — sandbox_create", () => {
	it("returns a sandbox id when called", async () => {
		const createdIds: string[] = [];

		const mockSessionManager = {
			getOrCreate: async (id: string): Promise<Session> => {
				createdIds.push(id);
				return {} as Session;
			},
		};

		const server = createMcpServer();
		registerTools(server, mockSessionManager as never);

		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

		const client = new Client({ name: "test-client", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);

		const result = await client.callTool({ name: "sandbox_create", arguments: {} });

		const content = result.content as Array<{ type: string; text?: string }>;
		expect(content).toHaveLength(1);
		const item = content[0];
		expect(item).toBeDefined();
		expect(item?.type).toBe("text");

		const parsed = JSON.parse(item?.text ?? "") as { id: string };
		expect(typeof parsed.id).toBe("string");
		expect(parsed.id).toHaveLength(36); // UUID v4

		expect(createdIds).toHaveLength(1);
		expect(createdIds[0]).toBe(parsed.id);

		await client.close();
	});
});

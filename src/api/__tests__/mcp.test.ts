/**
 * Unit tests for MCP server setup.
 * US-077: MCP server setup and streamable HTTP transport
 * US-078: MCP tool — sandbox_create
 * US-079: MCP tool — sandbox_delete
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

describe("MCP tool — sandbox_delete", () => {
	it("creates then deletes a sandbox via MCP tools", async () => {
		const sessions = new Map<string, Session>();

		const mockSessionManager = {
			getOrCreate: async (id: string): Promise<Session> => {
				const session = {} as Session;
				sessions.set(id, session);
				return session;
			},
			destroy: async (id: string): Promise<boolean> => {
				if (!sessions.has(id)) {
					throw Object.assign(new Error(`ENOENT: sandbox ${id} not found`), { code: "ENOENT" });
				}
				sessions.delete(id);
				return true;
			},
		};

		const server = createMcpServer();
		registerTools(server, mockSessionManager as never);

		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "test-client", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);

		// Create a sandbox
		const createResult = await client.callTool({ name: "sandbox_create", arguments: {} });
		const createContent = createResult.content as Array<{ type: string; text?: string }>;
		const created = JSON.parse(createContent[0]?.text ?? "") as { id: string };
		expect(typeof created.id).toBe("string");

		// Delete the sandbox
		const deleteResult = await client.callTool({ name: "sandbox_delete", arguments: { id: created.id } });
		const deleteContent = deleteResult.content as Array<{ type: string; text?: string }>;
		expect(deleteContent).toHaveLength(1);
		const deleted = JSON.parse(deleteContent[0]?.text ?? "") as { ok: boolean };
		expect(deleted.ok).toBe(true);

		// Verify session is gone
		expect(sessions.has(created.id)).toBe(false);

		await client.close();
	});

	it("returns error content when sandbox not found", async () => {
		const mockSessionManager = {
			getOrCreate: async (id: string): Promise<Session> => ({ id }) as unknown as Session,
			destroy: async (_id: string): Promise<boolean> => {
				throw Object.assign(new Error("ENOENT: sandbox not found"), { code: "ENOENT" });
			},
		};

		const server = createMcpServer();
		registerTools(server, mockSessionManager as never);

		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "test-client", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);

		const result = await client.callTool({ name: "sandbox_delete", arguments: { id: "nonexistent-id" } });
		const content = result.content as Array<{ type: string; text?: string }>;
		expect(content).toHaveLength(1);
		const parsed = JSON.parse(content[0]?.text ?? "") as { ok: boolean; error: string };
		expect(parsed.ok).toBe(false);
		expect(typeof parsed.error).toBe("string");

		await client.close();
	});
});

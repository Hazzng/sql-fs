/**
 * Unit tests for MCP server setup.
 * US-077: MCP server setup and streamable HTTP transport
 * US-078: MCP tool — sandbox_create
 * US-079: MCP tool — sandbox_delete
 * US-080: MCP tool — bash_exec
 * US-086: MCP tool — fs_ingest
 * US-087: MCP tool — fs_export
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryFs } from "just-bash";
import { describe, expect, it } from "vitest";
import type { SandboxMeta } from "../../fs/sql-fs/types.js";
import { createMcpServer } from "../mcp/server.js";
import { registerTools } from "../mcp/tools.js";
import { SessionManager } from "../session-manager.js";
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
		const sessions = new Map<string, Session>();

		const mockSessionManager = {
			getOrCreate: async (_tenantId: string, id: string): Promise<Session> => {
				createdIds.push(id);
				const session = { owner: "" } as unknown as Session;
				sessions.set(id, session);
				return session;
			},
			getSession: (_tenantId: string, id: string): Session | undefined => sessions.get(id),
			persistSandboxMeta: async () => {},
		};

		const server = createMcpServer();
		registerTools(server, mockSessionManager as never, "test-owner", "default");

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

	it("sandbox_create sets session.owner to the caller", async () => {
		const sessionManager = new SessionManager({
			createFs: async () => new InMemoryFs(),
		});

		const server = createMcpServer();
		registerTools(server, sessionManager, "agent-1", "default");

		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "test-client", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);

		const result = await client.callTool({ name: "sandbox_create", arguments: {} });
		const content = result.content as Array<{ type: string; text?: string }>;
		const parsed = JSON.parse(content[0]?.text ?? "") as { id: string };

		const session = sessionManager.getSession("default", parsed.id);
		expect(session?.owner).toBe("agent-1");

		await client.close();
	});
});

describe("MCP tool — sandbox_delete", () => {
	it("creates then deletes a sandbox via MCP tools", async () => {
		const sessions = new Map<string, Session>();

		const mockSessionManager = {
			getOrCreate: async (_tenantId: string, id: string): Promise<Session> => {
				const session = { owner: "" } as unknown as Session;
				sessions.set(id, session);
				return session;
			},
			getSession: (_tenantId: string, id: string): Session | undefined => sessions.get(id),
			withSessionOrRehydrate: async <T>(
				_tenantId: string,
				id: string,
				fn: (session: Session) => Promise<T>,
			): Promise<T> => {
				const session = sessions.get(id);
				if (session === undefined) {
					throw Object.assign(new Error(`ENOENT: sandbox ${id} not found`), { code: "ENOENT" });
				}
				return fn(session);
			},
			persistSandboxMeta: async () => {},
			destroy: async (_tenantId: string, id: string): Promise<boolean> => {
				if (!sessions.has(id)) {
					throw Object.assign(new Error(`ENOENT: sandbox ${id} not found`), { code: "ENOENT" });
				}
				sessions.delete(id);
				return true;
			},
		};

		const server = createMcpServer();
		registerTools(server, mockSessionManager as never, "test-owner", "default");

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
			getOrCreate: async (_tenantId: string, id: string): Promise<Session> => ({ id, owner: "" }) as unknown as Session,
			getSession: (_tenantId: string, _id: string): Session | undefined => undefined,
			withSessionOrRehydrate: async <T>(
				_tenantId: string,
				_id: string,
				_fn: (session: Session) => Promise<T>,
			): Promise<T> => {
				throw Object.assign(new Error("ENOENT: sandbox not found"), { code: "ENOENT" });
			},
			persistSandboxMeta: async () => {},
			destroy: async (_tenantId: string, _id: string): Promise<boolean> => {
				throw Object.assign(new Error("ENOENT: sandbox not found"), { code: "ENOENT" });
			},
		};

		const server = createMcpServer();
		registerTools(server, mockSessionManager as never, "test-owner", "default");

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

	it("rejects sandbox_delete on a cold replica when another owner created the sandbox", async () => {
		const meta = new Map<string, SandboxMeta>();
		const ownerManager = new SessionManager({
			createFs: async () => new InMemoryFs(),
			getSandboxMetaFn: async (_tenantId, sandboxId) => meta.get(sandboxId) ?? null,
			persistSandboxMetaFn: async (_tenantId, sandboxId, sandboxMeta) => {
				meta.set(sandboxId, sandboxMeta);
			},
		});
		const serverA = createMcpServer();
		registerTools(serverA, ownerManager, "user-a", "default");
		const [clientTransportA, serverTransportA] = InMemoryTransport.createLinkedPair();
		const clientA = new Client({ name: "test-a", version: "1.0.0" });
		await serverA.connect(serverTransportA);
		await clientA.connect(clientTransportA);
		const createResult = await clientA.callTool({ name: "sandbox_create", arguments: {} });
		const created = JSON.parse((createResult.content as Array<{ text?: string }>)[0]?.text ?? "") as { id: string };
		await clientA.close();

		const coldReplica = new SessionManager({
			createFs: async () => new InMemoryFs(),
			getSandboxMetaFn: async (_tenantId, sandboxId) => meta.get(sandboxId) ?? null,
		});
		const serverB = createMcpServer();
		registerTools(serverB, coldReplica, "user-b", "default");
		const [clientTransportB, serverTransportB] = InMemoryTransport.createLinkedPair();
		const clientB = new Client({ name: "test-b", version: "1.0.0" });
		await serverB.connect(serverTransportB);
		await clientB.connect(clientTransportB);

		const deleteResult = await clientB.callTool({ name: "sandbox_delete", arguments: { id: created.id } });
		const parsed = JSON.parse((deleteResult.content as Array<{ text?: string }>)[0]?.text ?? "") as {
			ok: boolean;
			error: string;
		};
		expect(parsed).toEqual({ ok: false, error: "forbidden" });

		await clientB.close();
	});
});

describe("MCP tool — bash_exec", () => {
	it("executes 'echo hello' and returns { stdout: 'hello\\n', exitCode: 0 }", async () => {
		const sessionManager = new SessionManager({
			createFs: async () => new InMemoryFs(),
		});

		const server = createMcpServer();
		registerTools(server, sessionManager, "test-owner", "default");

		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "test-client", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);

		// Create a sandbox first
		const createResult = await client.callTool({ name: "sandbox_create", arguments: {} });
		const createContent = createResult.content as Array<{ type: string; text?: string }>;
		const created = JSON.parse(createContent[0]?.text ?? "") as { id: string };

		// Execute 'echo hello'
		const execResult = await client.callTool({
			name: "bash_exec",
			arguments: { id: created.id, script: "echo hello" },
		});

		const content = execResult.content as Array<{ type: string; text?: string }>;
		expect(content).toHaveLength(1);
		const parsed = JSON.parse(content[0]?.text ?? "") as { stdout: string; stderr: string; exitCode: number };
		expect(parsed.stdout).toBe("hello\n");
		expect(parsed.exitCode).toBe(0);

		await client.close();
	});

	it("returns sandbox not found error for non-existent sandbox", async () => {
		const sessionManager = new SessionManager({
			createFs: async () => new InMemoryFs(),
		});

		const server = createMcpServer();
		registerTools(server, sessionManager, "test-owner", "default");

		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "test-client", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);

		const result = await client.callTool({
			name: "bash_exec",
			arguments: { id: "nonexistent-id", script: "echo hello" },
		});
		const content = result.content as Array<{ type: string; text?: string }>;
		const parsed = JSON.parse(content[0]?.text ?? "") as { stdout: string; stderr: string; exitCode: number };
		expect(parsed.stderr).toBe("sandbox not found");
		expect(parsed.exitCode).toBe(1);

		await client.close();
	});

	it("returns forbidden when caller does not own sandbox", async () => {
		const sessionManager = new SessionManager({
			createFs: async () => new InMemoryFs(),
		});

		// Create sandbox as user-a
		const serverA = createMcpServer();
		registerTools(serverA, sessionManager, "user-a", "default");
		const [clientTransportA, serverTransportA] = InMemoryTransport.createLinkedPair();
		const clientA = new Client({ name: "test-a", version: "1.0.0" });
		await serverA.connect(serverTransportA);
		await clientA.connect(clientTransportA);

		const createResult = await clientA.callTool({ name: "sandbox_create", arguments: {} });
		const created = JSON.parse((createResult.content as Array<{ text?: string }>)[0]?.text ?? "") as { id: string };
		await clientA.close();

		// Attempt bash_exec as user-b
		const serverB = createMcpServer();
		registerTools(serverB, sessionManager, "user-b", "default");
		const [clientTransportB, serverTransportB] = InMemoryTransport.createLinkedPair();
		const clientB = new Client({ name: "test-b", version: "1.0.0" });
		await serverB.connect(serverTransportB);
		await clientB.connect(clientTransportB);

		const execResult = await clientB.callTool({
			name: "bash_exec",
			arguments: { id: created.id, script: "echo hello" },
		});
		const content = execResult.content as Array<{ type: string; text?: string }>;
		const parsed = JSON.parse(content[0]?.text ?? "") as { stdout: string; stderr: string; exitCode: number };
		expect(parsed.stderr).toBe("forbidden");
		expect(parsed.exitCode).toBe(1);

		await clientB.close();
	});

	it("returns forbidden when a cold replica rehydrates a sandbox owned by another caller", async () => {
		const meta = new Map<string, SandboxMeta>();
		const ownerManager = new SessionManager({
			createFs: async () => new InMemoryFs(),
			getSandboxMetaFn: async (_tenantId, sandboxId) => meta.get(sandboxId) ?? null,
			persistSandboxMetaFn: async (_tenantId, sandboxId, sandboxMeta) => {
				meta.set(sandboxId, sandboxMeta);
			},
		});
		const serverA = createMcpServer();
		registerTools(serverA, ownerManager, "user-a", "default");
		const [clientTransportA, serverTransportA] = InMemoryTransport.createLinkedPair();
		const clientA = new Client({ name: "test-a", version: "1.0.0" });
		await serverA.connect(serverTransportA);
		await clientA.connect(clientTransportA);
		const createResult = await clientA.callTool({ name: "sandbox_create", arguments: {} });
		const created = JSON.parse((createResult.content as Array<{ text?: string }>)[0]?.text ?? "") as { id: string };
		await clientA.close();

		const coldReplica = new SessionManager({
			createFs: async () => new InMemoryFs(),
			getSandboxMetaFn: async (_tenantId, sandboxId) => meta.get(sandboxId) ?? null,
		});
		const serverB = createMcpServer();
		registerTools(serverB, coldReplica, "user-b", "default");
		const [clientTransportB, serverTransportB] = InMemoryTransport.createLinkedPair();
		const clientB = new Client({ name: "test-b", version: "1.0.0" });
		await serverB.connect(serverTransportB);
		await clientB.connect(clientTransportB);

		const execResult = await clientB.callTool({
			name: "bash_exec",
			arguments: { id: created.id, script: "echo hello" },
		});
		const parsed = JSON.parse((execResult.content as Array<{ text?: string }>)[0]?.text ?? "") as {
			stdout: string;
			stderr: string;
			exitCode: number;
		};
		expect(parsed).toEqual({ stdout: "", stderr: "forbidden", exitCode: 1 });

		await clientB.close();
	});

	it("succeeds when caller owns sandbox", async () => {
		const sessionManager = new SessionManager({
			createFs: async () => new InMemoryFs(),
		});

		const server = createMcpServer();
		registerTools(server, sessionManager, "user-a", "default");

		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "test-client", version: "1.0.0" });
		await server.connect(serverTransport);
		await client.connect(clientTransport);

		const createResult = await client.callTool({ name: "sandbox_create", arguments: {} });
		const created = JSON.parse((createResult.content as Array<{ text?: string }>)[0]?.text ?? "") as { id: string };

		const execResult = await client.callTool({
			name: "bash_exec",
			arguments: { id: created.id, script: "echo hello" },
		});
		const content = execResult.content as Array<{ type: string; text?: string }>;
		const parsed = JSON.parse(content[0]?.text ?? "") as { stdout: string; stderr: string; exitCode: number };
		expect(parsed.stdout).toBe("hello\n");
		expect(parsed.exitCode).toBe(0);

		await client.close();
	});
});

describe("MCP tool — fs_ingest", () => {
	it("ingests 3 files and verifies they are readable via bash_exec cat", async () => {
		const sessionManager = new SessionManager({
			createFs: async () => new InMemoryFs(),
		});

		const server = createMcpServer();
		registerTools(server, sessionManager, "test-owner", "default");

		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "test-client", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);

		// Create a sandbox
		const createResult = await client.callTool({ name: "sandbox_create", arguments: {} });
		const createContent = createResult.content as Array<{ type: string; text?: string }>;
		const created = JSON.parse(createContent[0]?.text ?? "") as { id: string };

		// Ingest 3 files
		const ingestResult = await client.callTool({
			name: "fs_ingest",
			arguments: {
				id: created.id,
				basePath: "/home/user/project",
				files: {
					"a.txt": "hello from a",
					"subdir/b.txt": "hello from b",
					"subdir/c.txt": "hello from c",
				},
			},
		});

		const ingestContent = ingestResult.content as Array<{ type: string; text?: string }>;
		expect(ingestContent).toHaveLength(1);
		const ingestParsed = JSON.parse(ingestContent[0]?.text ?? "") as { ok: boolean; count: number };
		expect(ingestParsed.ok).toBe(true);
		expect(ingestParsed.count).toBe(3);

		// Verify files are readable via cat
		for (const [rel, expected] of [
			["a.txt", "hello from a"],
			["subdir/b.txt", "hello from b"],
			["subdir/c.txt", "hello from c"],
		] as Array<[string, string]>) {
			const execResult = await client.callTool({
				name: "bash_exec",
				arguments: { id: created.id, script: `cat /home/user/project/${rel}` },
			});
			const execContent = execResult.content as Array<{ type: string; text?: string }>;
			const execParsed = JSON.parse(execContent[0]?.text ?? "") as { stdout: string; exitCode: number };
			expect(execParsed.exitCode).toBe(0);
			expect(execParsed.stdout).toBe(expected);
		}

		await client.close();
	});
});

describe("MCP tool — fs_export", () => {
	it("exports files written to sandbox as a JSON map", async () => {
		const sessionManager = new SessionManager({
			createFs: async () => new InMemoryFs(),
		});

		const server = createMcpServer();
		registerTools(server, sessionManager, "test-owner", "default");

		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "test-client", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);

		// Create a sandbox and ingest files
		const createResult = await client.callTool({ name: "sandbox_create", arguments: {} });
		const createContent = createResult.content as Array<{ type: string; text?: string }>;
		const created = JSON.parse(createContent[0]?.text ?? "") as { id: string };

		await client.callTool({
			name: "fs_ingest",
			arguments: {
				id: created.id,
				basePath: "/home/user/proj",
				files: {
					"a.txt": "content of a",
					"sub/b.txt": "content of b",
					"sub/c.txt": "content of c",
				},
			},
		});

		// Export the files
		const exportResult = await client.callTool({
			name: "fs_export",
			arguments: { id: created.id, basePath: "/home/user/proj" },
		});

		const exportContent = exportResult.content as Array<{ type: string; text?: string }>;
		expect(exportContent).toHaveLength(1);
		const parsed = JSON.parse(exportContent[0]?.text ?? "") as { files: Record<string, string> };
		expect(parsed.files["a.txt"]).toBe("content of a");
		expect(parsed.files["sub/b.txt"]).toBe("content of b");
		expect(parsed.files["sub/c.txt"]).toBe("content of c");
		// Should not include directories
		expect(Object.keys(parsed.files)).toHaveLength(3);

		await client.close();
	});
});

/**
 * Unit tests for MCP server setup.
 * US-077: MCP server setup and streamable HTTP transport
 * US-078: MCP tool — sandbox_create
 * US-079: MCP tool — sandbox_delete
 * US-080: MCP tool — bash_exec
 * US-086: MCP tool — fs_ingest
 * US-087: MCP tool — fs_export
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryFs } from "just-bash";
import type { IFileSystem } from "just-bash";
import { describe, expect, it } from "vitest";
import type { ICoherentFs } from "../../../fs/sql-fs/sql-fs.js";
import type { BulkIngestFile, SandboxMeta } from "../../../fs/sql-fs/types.js";
import { createMcpServer } from "../../mcp/server.js";
import { registerTools } from "../../mcp/tools.js";
import { SessionManager } from "../../session-manager.js";
import type { Session } from "../../session-manager.js";

/**
 * Wraps `InMemoryFs` with a `bulkIngest` shim so MCP fs_ingest tests (which
 * cast to ICoherentFs) work without standing up Postgres. Behaves like the
 * real bulkIngest for the assertions we make: files become readable.
 */
function withBulkIngest(fs: IFileSystem): IFileSystem & Pick<ICoherentFs, "bulkIngest"> {
	const wrapped = fs as IFileSystem & Pick<ICoherentFs, "bulkIngest">;
	wrapped.bulkIngest = async (files: BulkIngestFile[]) => {
		for (const f of files) {
			const lastSlash = f.path.lastIndexOf("/");
			const parentDir = lastSlash > 0 ? f.path.slice(0, lastSlash) : "/";
			if (parentDir !== "/") {
				try {
					await fs.mkdir(parentDir, { recursive: true });
				} catch (e) {
					const code = (e as Error & { code?: string }).code;
					if (code !== "EEXIST") throw e;
				}
			}
			await fs.writeFile(f.path, f.content);
		}
	};
	return wrapped;
}

const b64 = (s: string): string => Buffer.from(s, "utf-8").toString("base64");

/**
 * Boots an in-memory MCP server + client, registers tools, and creates a
 * sandbox. Returns `{ client, sandboxId }` plus a `close()` shortcut.
 *
 * Used by the fs_ingest tests below — every one of them needs the same
 * ~10 lines of bootstrap; centralizing here keeps the per-test bodies
 * focused on the behavior under test.
 */
async function bootIngestHarness(
	opts: { withBulk?: boolean } = {},
): Promise<{ client: Client; sandboxId: string; close: () => Promise<void> }> {
	const withBulk = opts.withBulk ?? true;
	const sessionManager = new SessionManager({
		createFs: async () => (withBulk ? withBulkIngest(new InMemoryFs()) : new InMemoryFs()),
	});
	const server = createMcpServer();
	registerTools(server, sessionManager, "test-owner", "default");
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test-client", version: "1.0.0" });
	await server.connect(serverTransport);
	await client.connect(clientTransport);

	const createResult = await client.callTool({ name: "sandbox_create", arguments: {} });
	const { id: sandboxId } = JSON.parse((createResult.content as Array<{ text?: string }>)[0]?.text ?? "") as {
		id: string;
	};

	return { client, sandboxId, close: () => client.close() };
}

function parseToolJson<T>(res: unknown): T {
	const content = (res as { content: Array<{ text?: string }> }).content;
	return JSON.parse(content[0]?.text ?? "") as T;
}

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
			getOrCreate: async (_tenantId: string, id: string, _runtime?: unknown, owner = ""): Promise<Session> => {
				const session = { owner } as unknown as Session;
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
			createFs: async () => withBulkIngest(new InMemoryFs()),
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

		// Ingest 3 files (values are base64-encoded — see fs_ingest tool description)
		const ingestResult = await client.callTool({
			name: "fs_ingest",
			arguments: {
				id: created.id,
				basePath: "/home/user/project",
				files: {
					"a.txt": b64("hello from a"),
					"subdir/b.txt": b64("hello from b"),
					"subdir/c.txt": b64("hello from c"),
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

	it("rejects malformed manifest entries before any DB work and reports both bad paths and bad base64", async () => {
		const sessionManager = new SessionManager({
			createFs: async () => withBulkIngest(new InMemoryFs()),
		});
		const server = createMcpServer();
		registerTools(server, sessionManager, "test-owner", "default");
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "test-client", version: "1.0.0" });
		await server.connect(serverTransport);
		await client.connect(clientTransport);

		const createResult = await client.callTool({ name: "sandbox_create", arguments: {} });
		const createContent = createResult.content as Array<{ type: string; text?: string }>;
		const created = JSON.parse(createContent[0]?.text ?? "") as { id: string };

		const res = await client.callTool({
			name: "fs_ingest",
			arguments: {
				id: created.id,
				basePath: "/home/user/proj",
				files: {
					"": b64("empty key"),
					"dir/": b64("trailing slash"),
					"good.txt": "%%%not-base64%%%",
				},
			},
		});

		const content = res.content as Array<{ type: string; text?: string }>;
		const parsed = JSON.parse(content[0]?.text ?? "") as { ok: boolean; error: string };
		// Deterministic full payload: empty key + "dir/" → invalid paths,
		// "good.txt"/"%%%not-base64%%%" → invalid base64. Asserting the entire
		// shape catches accidental delimiter/format changes that substring
		// matches would silently miss.
		expect(parsed).toEqual({
			ok: false,
			error: "invalid paths: , dir/; invalid base64: good.txt",
		});

		await client.close();
	});

	it.each([
		["tmp", "no leading slash"],
		["./proj", "relative path"],
		["/home/user/../etc", ".. segment escapes basePath"],
		["/home/user;rm -rf /", "shell metachar"],
	])("rejects unsafe basePath %p (%s) before any DB work", async (basePath) => {
		// The HTTP route validates basePath via isValidBasePath; the MCP tool
		// shares the same helper. Without this guard, /home/user/../etc would
		// silently normalize to /home/etc inside SqlFs.bulkIngest — diverging
		// the two ingest contracts. This test pins both surfaces to one rule.
		const sessionManager = new SessionManager({
			createFs: async () => withBulkIngest(new InMemoryFs()),
		});
		const server = createMcpServer();
		registerTools(server, sessionManager, "test-owner", "default");
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "test-client", version: "1.0.0" });
		await server.connect(serverTransport);
		await client.connect(clientTransport);

		const createResult = await client.callTool({ name: "sandbox_create", arguments: {} });
		const createContent = createResult.content as Array<{ type: string; text?: string }>;
		const created = JSON.parse(createContent[0]?.text ?? "") as { id: string };

		const res = await client.callTool({
			name: "fs_ingest",
			arguments: { id: created.id, basePath, files: { "a.txt": b64("hello") } },
		});
		const content = res.content as Array<{ type: string; text?: string }>;
		const parsed = JSON.parse(content[0]?.text ?? "") as { ok: boolean; error: string };
		expect(parsed).toEqual({ ok: false, error: "basePath must be a safe absolute path" });

		await client.close();
	});

	it("ingests via paths — server reads host files without model generating base64 tokens", async () => {
		const tmpDir = await mkdtemp(join(tmpdir(), "sqlfs-test-"));
		try {
			await writeFile(join(tmpDir, "a.txt"), "hello from a", "utf-8");
			await writeFile(join(tmpDir, "b.txt"), "hello from b", "utf-8");

			const { client, sandboxId, close } = await bootIngestHarness();

			const ingestResult = await client.callTool({
				name: "fs_ingest",
				arguments: {
					id: sandboxId,
					basePath: "/home/user/project",
					paths: {
						"a.txt": join(tmpDir, "a.txt"),
						"b.txt": join(tmpDir, "b.txt"),
					},
				},
			});
			expect(parseToolJson<{ ok: boolean; count: number }>(ingestResult)).toEqual({ ok: true, count: 2 });

			for (const [rel, expected] of [
				["a.txt", "hello from a"],
				["b.txt", "hello from b"],
			] as Array<[string, string]>) {
				const execResult = await client.callTool({
					name: "bash_exec",
					arguments: { id: sandboxId, script: `cat /home/user/project/${rel}` },
				});
				const exec = parseToolJson<{ stdout: string; exitCode: number }>(execResult);
				expect(exec.exitCode).toBe(0);
				expect(exec.stdout).toBe(expected);
			}

			await close();
		} finally {
			await rm(tmpDir, { recursive: true, force: true });
		}
	});

	// Audit H3: host files in `paths` mode must be read ONLY after the ownership
	// check passes. A non-owner must get an identical `forbidden` response whether
	// the host path exists or not — otherwise the pre-authz read becomes a
	// cross-principal host-file existence/readability oracle.
	it("does not read host files for a non-owner (forbidden, no readability oracle)", async () => {
		const tmpDir = await mkdtemp(join(tmpdir(), "sqlfs-h3-"));
		try {
			const existing = join(tmpDir, "exists.txt");
			const missing = join(tmpDir, "nope.txt");
			await writeFile(existing, "secret host bytes", "utf-8");

			// user-a creates + owns the sandbox; meta persisted to a shared store.
			const meta = new Map<string, SandboxMeta>();
			const ownerManager = new SessionManager({
				createFs: async () => withBulkIngest(new InMemoryFs()),
				getSandboxMetaFn: async (_t, id) => meta.get(id) ?? null,
				persistSandboxMetaFn: async (_t, id, m) => {
					meta.set(id, m);
				},
			});
			const serverA = createMcpServer();
			registerTools(serverA, ownerManager, "user-a", "default");
			const [ctA, stA] = InMemoryTransport.createLinkedPair();
			const clientA = new Client({ name: "a", version: "1.0.0" });
			await serverA.connect(stA);
			await clientA.connect(ctA);
			const createResult = await clientA.callTool({ name: "sandbox_create", arguments: {} });
			const { id } = JSON.parse((createResult.content as Array<{ text?: string }>)[0]?.text ?? "") as { id: string };
			await clientA.close();

			// user-b (non-owner) on a cold replica attempts to ingest by host path.
			const coldReplica = new SessionManager({
				createFs: async () => withBulkIngest(new InMemoryFs()),
				getSandboxMetaFn: async (_t, sid) => meta.get(sid) ?? null,
			});
			const serverB = createMcpServer();
			registerTools(serverB, coldReplica, "user-b", "default");
			const [ctB, stB] = InMemoryTransport.createLinkedPair();
			const clientB = new Client({ name: "b", version: "1.0.0" });
			await serverB.connect(stB);
			await clientB.connect(ctB);

			const ingest = (hostPath: string) =>
				clientB
					.callTool({
						name: "fs_ingest",
						arguments: { id, basePath: "/home/user/p", paths: { "x.txt": hostPath } },
					})
					.then((r) => parseToolJson<{ ok: boolean; error: string }>(r));

			// Both an existing and a missing host path must yield the SAME forbidden
			// response. A divergent "unreadable host paths" error would prove the read
			// happened before authorization (the bug H3 fixes).
			expect(await ingest(existing)).toEqual({ ok: false, error: "forbidden" });
			expect(await ingest(missing)).toEqual({ ok: false, error: "forbidden" });

			await clientB.close();
		} finally {
			await rm(tmpDir, { recursive: true, force: true });
		}
	});

	it("merges files and paths in one call", async () => {
		const tmpDir = await mkdtemp(join(tmpdir(), "sqlfs-test-"));
		try {
			await writeFile(join(tmpDir, "from-disk.txt"), "disk content", "utf-8");

			const { client, sandboxId, close } = await bootIngestHarness();

			const ingestResult = await client.callTool({
				name: "fs_ingest",
				arguments: {
					id: sandboxId,
					basePath: "/home/user/project",
					files: { "generated.txt": b64("generated content") },
					paths: { "from-disk.txt": join(tmpDir, "from-disk.txt") },
				},
			});
			expect(parseToolJson<{ ok: boolean; count: number }>(ingestResult)).toEqual({ ok: true, count: 2 });

			await close();
		} finally {
			await rm(tmpDir, { recursive: true, force: true });
		}
	});

	it("rejects relative host path values before any I/O", async () => {
		const { client, sandboxId, close } = await bootIngestHarness();
		const res = await client.callTool({
			name: "fs_ingest",
			arguments: {
				id: sandboxId,
				basePath: "/home/user/proj",
				paths: { "a.txt": "relative/path/not/absolute" },
			},
		});
		expect(parseToolJson<{ ok: boolean; error: string }>(res)).toEqual({
			ok: false,
			error: "invalid host paths: a.txt",
		});
		await close();
	});

	it("returns unreadable error when a host path does not exist", async () => {
		const { client, sandboxId, close } = await bootIngestHarness();
		const res = await client.callTool({
			name: "fs_ingest",
			arguments: {
				id: sandboxId,
				basePath: "/home/user/proj",
				paths: { "missing.txt": "/tmp/does-not-exist-sqlfs-test-12345.txt" },
			},
		});
		const parsed = parseToolJson<{ ok: boolean; error: string }>(res);
		expect(parsed.ok).toBe(false);
		expect(parsed.error).toContain("unreadable host paths");
		expect(parsed.error).toContain("missing.txt");
		await close();
	});

	it("rejects when both files and paths are absent", async () => {
		const { client, sandboxId, close } = await bootIngestHarness();
		const res = await client.callTool({
			name: "fs_ingest",
			arguments: { id: sandboxId, basePath: "/home/user/proj" },
		});
		const parsed = parseToolJson<{ ok: boolean; error: string }>(res);
		expect(parsed.ok).toBe(false);
		expect(parsed.error).toContain("at least one");
		await close();
	});

	it("rejects duplicate keys between files and paths", async () => {
		const tmpDir = await mkdtemp(join(tmpdir(), "sqlfs-test-"));
		try {
			await writeFile(join(tmpDir, "dup.txt"), "from disk", "utf-8");
			const { client, sandboxId, close } = await bootIngestHarness();
			const res = await client.callTool({
				name: "fs_ingest",
				arguments: {
					id: sandboxId,
					basePath: "/home/user/proj",
					files: { "dup.txt": b64("from inline") },
					paths: { "dup.txt": join(tmpDir, "dup.txt") },
				},
			});
			const parsed = parseToolJson<{ ok: boolean; error: string }>(res);
			expect(parsed.ok).toBe(false);
			expect(parsed.error).toContain("duplicate keys in files and paths: dup.txt");
			await close();
		} finally {
			await rm(tmpDir, { recursive: true, force: true });
		}
	});

	it("returns a sanitized internal error (no backend wiring) when the FS lacks bulkIngest", async () => {
		// Use a plain InMemoryFs WITHOUT the bulkIngest shim so the runtime guard
		// fires and synthesizes an ENOTSUP error. The raw "bulkIngest not supported
		// by this fs backend" message must NOT leak to the MCP client.
		const sessionManager = new SessionManager({
			createFs: async () => new InMemoryFs(),
		});
		const server = createMcpServer();
		registerTools(server, sessionManager, "test-owner", "default");
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "test-client", version: "1.0.0" });
		await server.connect(serverTransport);
		await client.connect(clientTransport);

		const createResult = await client.callTool({ name: "sandbox_create", arguments: {} });
		const createContent = createResult.content as Array<{ type: string; text?: string }>;
		const created = JSON.parse(createContent[0]?.text ?? "") as { id: string };

		const res = await client.callTool({
			name: "fs_ingest",
			arguments: {
				id: created.id,
				basePath: "/home/user/proj",
				files: { "a.txt": b64("hello") },
			},
		});

		const content = res.content as Array<{ type: string; text?: string }>;
		const parsed = JSON.parse(content[0]?.text ?? "") as { ok: boolean; error: string };
		expect(parsed.ok).toBe(false);
		expect(parsed.error).toBe("internal error");
		expect(parsed.error).not.toContain("bulkIngest");
		expect(parsed.error).not.toContain("backend");

		await client.close();
	});
});

describe("MCP tool — fs_export", () => {
	it("exports files written to sandbox as a JSON map", async () => {
		const sessionManager = new SessionManager({
			createFs: async () => withBulkIngest(new InMemoryFs()),
		});

		const server = createMcpServer();
		registerTools(server, sessionManager, "test-owner", "default");

		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "test-client", version: "1.0.0" });

		await server.connect(serverTransport);
		await client.connect(clientTransport);

		// Create a sandbox and ingest files (base64 per fs_ingest contract)
		const createResult = await client.callTool({ name: "sandbox_create", arguments: {} });
		const createContent = createResult.content as Array<{ type: string; text?: string }>;
		const created = JSON.parse(createContent[0]?.text ?? "") as { id: string };

		await client.callTool({
			name: "fs_ingest",
			arguments: {
				id: created.id,
				basePath: "/home/user/proj",
				files: {
					"a.txt": b64("content of a"),
					"sub/b.txt": b64("content of b"),
					"sub/c.txt": b64("content of c"),
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

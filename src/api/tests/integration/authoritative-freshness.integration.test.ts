import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Hono } from "hono";
import { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PostgresDialect } from "../../../sql-fs/dialects/postgres.js";
import { createPostgresSandboxFs, destroyPostgresSandbox } from "../../../sql-fs/index.js";
import type { SqlFs } from "../../../sql-fs/sql-fs.js";
import { deferred } from "../../../sql-fs/tests/unit/freshness-helpers.js";
import type { AuthVariables } from "../../auth.js";
import { rwLockKeys } from "../../distributed-rw-lock.js";
import { apiErrorHandler } from "../../errors.js";
import { registerTools } from "../../mcp/tools.js";
import { execRoutes } from "../../routes/exec.js";
import { fileRoutes } from "../../routes/files.js";
import { SessionManager } from "../../session-manager.js";
import { loadTenantConfig } from "../../tenants.js";

const owner = "issue-215-integration";
const tenant = "default";
type ToolResult = { isError?: boolean; content: Array<{ text: string }> };
type Handler = (args: { id: string; path: string }) => Promise<ToolResult>;

describe.skipIf(!process.env.DATABASE_URL || !process.env.REDIS_URL)("authoritative PostgreSQL freshness", () => {
	let id: string;
	let redis: Redis;
	let writer: SessionManager;
	let reader: SessionManager;
	let app: Hono<{ Variables: AuthVariables }>;
	let fileRead: Handler;

	beforeEach(async () => {
		id = `fresh-${randomUUID()}`;
		redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: 1 });
		const options = {
			tenantConfig: loadTenantConfig(),
			redis,
			execLockOptions: { leaseMs: 5000, renewMs: 1000, acquireTimeoutMs: 8000, acquireRetryMs: 10 },
		};
		writer = new SessionManager(options);
		reader = new SessionManager(options);
		await writer.getOrCreate(tenant, id, undefined, owner);
		await writer.withSession(tenant, id, async (session) => {
			await session.fs.writeFile("/value", "old");
		});
		await reader.getOrCreate(tenant, id, undefined, owner);
		app = new Hono<{ Variables: AuthVariables }>();
		app.onError(apiErrorHandler);
		app.use("*", async (c, next) => {
			c.set("owner", owner);
			c.set("tenant", tenant);
			await next();
		});
		app.route("/v1/sandboxes", fileRoutes(reader));
		app.route("/v1/sandboxes", execRoutes(reader));
		const handlers = new Map<string, Handler>();
		registerTools(
			{
				tool: (name: string, ...args: unknown[]) => handlers.set(name, args.at(-1) as Handler),
			} as unknown as McpServer,
			reader,
			owner,
			tenant,
		);
		fileRead = handlers.get("file_read")!;
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await Promise.all([writer?.shutdown(), reader?.shutdown()]);
		if (id) {
			await destroyPostgresSandbox(process.env.DATABASE_URL!, id);
			const cleanup = new PostgresDialect(process.env.DATABASE_URL!);
			try {
				await cleanup.connect();
				await cleanup.transaction(async (tx) => {
					await tx`DELETE FROM sandbox_epochs WHERE sandbox_id = ${id}`;
					const remaining = await tx`SELECT sandbox_id FROM sandbox_epochs WHERE sandbox_id = ${id}`;
					expect(remaining).toHaveLength(0);
				});
			} finally {
				await cleanup.disconnect();
			}
		}
		if (redis) {
			const { writer: writerKey, readers } = rwLockKeys(tenant, id);
			await redis.del(writerKey, readers, `vfs:${tenant}:ver:${id}`, `vfs:${tenant}:snap:${id}`);
			await redis.quit();
		}
	});

	async function readRest(exec = false): Promise<{ status: number; value: string }> {
		const response = await app.request(
			`/v1/sandboxes/${id}/${exec ? "exec-sync" : "files/value"}`,
			exec
				? {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ script: "cat /value", readOnly: true }),
					}
				: undefined,
		);
		return {
			status: response.status,
			value: exec && response.ok ? ((await response.json()) as { stdout: string }).stdout : await response.text(),
		};
	}

	it("all read surfaces see a committed append after the writer exits with unchanged legacy metadata", async () => {
		await redis.set(`vfs:${tenant}:ver:${id}`, "1");
		await redis.set(`vfs:${tenant}:snap:${id}`, "obsolete snapshot");
		const incr = vi.spyOn(redis, "incr").mockRejectedValue(new Error("legacy publication failed"));
		await writer.withSession(tenant, id, (session) => writer.execWithRuntimeThrottle(session, "printf x >> /value"));
		await writer.shutdown();
		expect(incr).not.toHaveBeenCalled();
		expect(await redis.get(`vfs:${tenant}:ver:${id}`)).toBe("1");
		expect(await readRest()).toEqual({ status: 200, value: "oldx" });
		expect(await readRest(true)).toEqual({ status: 200, value: "oldx" });
		const mcp = await fileRead({ id, path: "/value" });
		expect(mcp.isError).not.toBe(true);
		expect(JSON.parse(mcp.content[0]!.text).content).toBe("oldx");
	});

	it("all read surfaces fail closed when SQL authority is unavailable", async () => {
		vi.spyOn(PostgresDialect.prototype, "getSandboxEpoch").mockRejectedValue(
			Object.assign(new Error("SQL authority unavailable"), { code: "08006" }),
		);
		expect((await readRest()).status).toBe(503);
		expect((await readRest(true)).status).toBe(503);
		const mcp = await fileRead({ id, path: "/value" });
		expect(JSON.parse(mcp.content[0]!.text)).toMatchObject({ ok: false, error: "Internal server error" });
		expect(mcp.content[0]!.text).not.toContain('"content":"old"');
	});

	it("a shared read after authoritative deletion returns ENOENT and drains teardown", async () => {
		await destroyPostgresSandbox(process.env.DATABASE_URL!, id);
		const session = reader.getSession(tenant, id)!;
		expect((await readRest()).status).toBe(404);
		await session.destroyPromise;
		expect(reader.getSession(tenant, id)).toBeUndefined();
	});

	it("cold and recovery loads keep their original epoch when another transaction commits during path loading", async () => {
		const sampled = deferred();
		const resume = deferred();
		const original = PostgresDialect.prototype.loadAllPaths;
		vi.spyOn(PostgresDialect.prototype, "loadAllPaths").mockImplementationOnce(async function (
			this: PostgresDialect,
			tx,
		) {
			const rows = await original.call(this, tx);
			sampled.resolve();
			await resume.promise;
			return rows;
		});
		const cold = createPostgresSandboxFs({ connectionString: process.env.DATABASE_URL! }, id, owner);
		await sampled.promise;
		await writer.withSession(tenant, id, async (session) => {
			await session.fs.writeFile("/value", "new");
		});
		resume.resolve();
		const { fs } = await cold;
		const sqlFs = fs as SqlFs;
		try {
			expect(await sqlFs.readFile("/value")).toBe("old");
			await sqlFs.ensureFresh();
			expect(await sqlFs.readFile("/value")).toBe("new");
			await sqlFs.reload();
			expect(await sqlFs.readFile("/value")).toBe("new");
		} finally {
			await sqlFs.disconnect();
		}
	});
});

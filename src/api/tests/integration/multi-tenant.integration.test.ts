/**
 * Phase 5 — multi-tenant Postgres routing integration tests.
 *
 * Uses two fresh Postgres databases plus one Redis instance to verify:
 * - same sandbox ids in different tenants do not serialize
 * - tenant-scoped API requests stay isolated across create/exec/ingest/destroy
 * - legacy single-tenant mode still accepts tokens without a tenant claim
 *
 * Skipped unless both DATABASE_URL and REDIS_URL are set.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { Redis } from "ioredis";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RedisPathSnapshot } from "../../../sql-fs/redis-path-snapshot.js";
import { type AuthVariables, createAuthMiddleware } from "../../auth.js";
import { mapFsErrorToStatus } from "../../errors.js";
import { signToken } from "../../lib/jwt.js";
import { runMigrations } from "../../migrations.js";
import { execRoutes } from "../../routes/exec.js";
import { fileRoutes } from "../../routes/files.js";
import { ingestRoutes } from "../../routes/ingest.js";
import { sandboxRoutes } from "../../routes/sandboxes.js";
import { SessionManager } from "../../session-manager.js";
import { type TenantConfig, loadTenantConfig } from "../../tenants.js";

const AUTH_SECRET = "phase-5-multi-tenant-secret-at-least-32b";
const SKIP = !process.env.DATABASE_URL || !process.env.REDIS_URL;
const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";

function withDatabase(connectionString: string, database: string): string {
	const u = new URL(connectionString);
	u.pathname = `/${database}`;
	return u.toString();
}

function adminConnectionString(connectionString: string): string {
	const u = new URL(connectionString);
	u.pathname = "/postgres";
	return u.toString();
}

function makeDbName(prefix: string): string {
	return `${prefix}_${randomBytes(6).toString("hex")}`;
}

function versionKey(tenantId: string, sandboxId: string): string {
	return `vfs:${tenantId}:ver:${sandboxId}`;
}

function legacyLockKey(sandboxId: string): string {
	return `vfs:lock:${sandboxId}`;
}

function makeApp(tenantConfig: TenantConfig, redis: Redis) {
	const sessionManager = new SessionManager({
		tenantConfig,
		redis,
		execLockOptions: {
			leaseMs: 5_000,
			renewMs: 1_500,
			acquireTimeoutMs: 8_000,
			acquireRetryMs: 50,
		},
		pathSnapshot: new RedisPathSnapshot(redis, { ttlMs: 60_000 }),
	});
	const app = new Hono<{ Variables: AuthVariables }>();
	app.use("/v1/*", createAuthMiddleware(tenantConfig));
	app.route("/v1/sandboxes", sandboxRoutes(sessionManager));
	app.route("/v1/sandboxes", fileRoutes(sessionManager));
	app.route("/v1/sandboxes", execRoutes(sessionManager));
	app.route("/v1/sandboxes", ingestRoutes(sessionManager));
	// Mirror server.ts global error handler so FS error codes (ENOENT etc.) map
	// to the correct HTTP status instead of bubbling up as 500.
	app.onError((err, c) => {
		const status = mapFsErrorToStatus(err) as ContentfulStatusCode;
		const code = (err as Error & { code?: string }).code ?? "INTERNAL_ERROR";
		return c.json({ error: err.message, code }, status);
	});
	return { app, sessionManager };
}

async function makeAuthHeader(sub: string, tenant?: string): Promise<{ Authorization: string }> {
	const token = await signToken({ sub, tenant, secret: AUTH_SECRET, expiresIn: "24h" });
	return { Authorization: `Bearer ${token}` };
}

function extractId(body: unknown): string {
	const id = (body as { id?: unknown }).id;
	if (typeof id !== "string" || id.length === 0) {
		throw new Error(`expected sandbox id in response body, got ${JSON.stringify(body)}`);
	}
	return id;
}

async function sandboxCount(sql: postgres.Sql): Promise<number> {
	const rows = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM sandboxes`;
	return Number(rows[0]?.n ?? "0");
}

describe.skipIf(SKIP)("Phase 5 — multi-tenant Postgres routing", () => {
	const originalAuthSecret = process.env.AUTH_SECRET;
	let admin: postgres.Sql | undefined;
	let tenantASql: postgres.Sql | undefined;
	let tenantBSql: postgres.Sql | undefined;
	let redis: Redis | undefined;
	let dbA: string;
	let dbB: string;
	let multiTenantConfig: TenantConfig;

	beforeAll(async () => {
		const base = process.env.DATABASE_URL;
		if (!base) throw new Error("DATABASE_URL required for this suite");
		dbA = makeDbName("vfs_phase5_a");
		dbB = makeDbName("vfs_phase5_b");
		process.env.AUTH_SECRET = AUTH_SECRET;
		admin = postgres(adminConnectionString(base), { prepare: false, max: 1 });
		await admin.unsafe(`CREATE DATABASE ${dbA}`);
		await admin.unsafe(`CREATE DATABASE ${dbB}`);
		const urlA = withDatabase(base, dbA);
		const urlB = withDatabase(base, dbB);
		multiTenantConfig = loadTenantConfig({
			TENANT_DATABASES: JSON.stringify({ [TENANT_A]: urlA, [TENANT_B]: urlB }),
		});
		await runMigrations(multiTenantConfig);
		tenantASql = postgres(urlA, { prepare: false, max: 1 });
		tenantBSql = postgres(urlB, { prepare: false, max: 1 });
		redis = new Redis(process.env.REDIS_URL!, { lazyConnect: true, maxRetriesPerRequest: 1 });
		await redis.connect();
	});

	afterAll(async () => {
		process.env.AUTH_SECRET = originalAuthSecret;
		if (redis) await redis.quit();
		if (tenantASql) await tenantASql.end({ timeout: 5 });
		if (tenantBSql) await tenantBSql.end({ timeout: 5 });
		if (admin) {
			try {
				await admin`
					SELECT pg_terminate_backend(pid)
					FROM pg_stat_activity
					WHERE (datname = ${dbA} OR datname = ${dbB}) AND pid <> pg_backend_pid()
				`;
				await admin.unsafe(`DROP DATABASE IF EXISTS ${dbA}`);
				await admin.unsafe(`DROP DATABASE IF EXISTS ${dbB}`);
			} finally {
				await admin.end({ timeout: 5 });
			}
		}
	});

	it("same sandbox id in different tenant databases does not serialize", async () => {
		if (!redis) throw new Error("Redis client not initialized");
		const { sessionManager } = makeApp(multiTenantConfig, redis);
		const sandboxId = `phase5-shared-${randomUUID()}`;
		const holdMs = 300;
		const started = Date.now();
		await Promise.all([
			sessionManager.withSession(TENANT_A, sandboxId, async (session) => {
				await session.bash.exec(`sleep ${holdMs / 1000} && echo A > /home/user/a.txt`);
			}),
			sessionManager.withSession(TENANT_B, sandboxId, async (session) => {
				await session.bash.exec(`sleep ${holdMs / 1000} && echo B > /home/user/b.txt`);
			}),
		]);
		expect(Date.now() - started).toBeLessThan(holdMs + 250);
		await Promise.all([sessionManager.destroy(TENANT_A, sandboxId), sessionManager.destroy(TENANT_B, sandboxId)]);
	});

	it("isolates create, exec, ingest, export, unknown tenant handling, and destroy across tenants", async () => {
		if (!redis || !tenantASql || !tenantBSql) throw new Error("test infrastructure not initialized");
		const { app } = makeApp(multiTenantConfig, redis);
		const authA = await makeAuthHeader("alice", TENANT_A);
		const authB = await makeAuthHeader("bob", TENANT_B);
		const createHeaders = { "Content-Type": "application/json" };
		const [createA, createB] = await Promise.all([
			app.request("/v1/sandboxes", { method: "POST", headers: { ...authA, ...createHeaders }, body: "{}" }),
			app.request("/v1/sandboxes", { method: "POST", headers: { ...authB, ...createHeaders }, body: "{}" }),
		]);
		expect(createA.status).toBe(201);
		expect(createB.status).toBe(201);
		const sandboxA = extractId(await createA.json());
		const sandboxB = extractId(await createB.json());

		const [execA, execB] = await Promise.all([
			app.request(`/v1/sandboxes/${sandboxA}/exec-sync`, {
				method: "POST",
				headers: { ...authA, ...createHeaders },
				body: JSON.stringify({
					script: "for i in 1 2 3; do echo a-$i >> /home/user/log.txt; done && wc -l /home/user/log.txt",
				}),
			}),
			app.request(`/v1/sandboxes/${sandboxB}/exec-sync`, {
				method: "POST",
				headers: { ...authB, ...createHeaders },
				body: JSON.stringify({
					script: "for i in 1 2 3; do echo b-$i >> /home/user/log.txt; done && wc -l /home/user/log.txt",
				}),
			}),
		]);
		expect(((await execA.json()) as { exitCode: number; stdout: string }).exitCode).toBe(0);
		expect(((await execB.json()) as { exitCode: number; stdout: string }).stdout.trim()).toMatch(/^3 /);

		const ingest = await app.request(`/v1/sandboxes/${sandboxA}/ingest-files`, {
			method: "POST",
			headers: { ...authA, ...createHeaders },
			body: JSON.stringify({
				basePath: "/home/user/project",
				files: { "tenant-a.txt": Buffer.from("hello-from-a").toString("base64") },
			}),
		});
		expect(ingest.status).toBe(200);

		const readLogRes = await app.request(`/v1/sandboxes/${sandboxB}/exec-sync`, {
			method: "POST",
			headers: { ...authB, ...createHeaders },
			body: JSON.stringify({ script: "cat /home/user/log.txt" }),
		});
		expect(readLogRes.status).toBe(200);
		expect(((await readLogRes.json()) as { stdout: string; exitCode: number }).stdout).toContain("b-1");

		const crossTenantRead = await app.request(`/v1/sandboxes/${sandboxB}/files/home/user/log.txt`, { headers: authA });
		expect(crossTenantRead.status).toBe(404);

		const badAuth = await makeAuthHeader("eve", "tenant-ghost");
		const unknownTenant = await app.request("/v1/sandboxes", {
			method: "POST",
			headers: { ...badAuth, ...createHeaders },
			body: "{}",
		});
		expect(unknownTenant.status).toBe(401);
		expect(((await unknownTenant.json()) as { code: string }).code).toBe("AUTH_UNKNOWN_TENANT");

		const sandboxesA = await tenantASql<{ id: string }[]>`SELECT id FROM sandboxes`;
		const sandboxesB = await tenantBSql<{ id: string }[]>`SELECT id FROM sandboxes`;
		expect(sandboxesA.map((row) => row.id)).toEqual([sandboxA]);
		expect(sandboxesB.map((row) => row.id)).toEqual([sandboxB]);

		expect(await redis.exists(versionKey(TENANT_A, sandboxA))).toBe(1);
		expect(await redis.exists(versionKey(TENANT_B, sandboxB))).toBe(1);
		expect(await redis.exists(RedisPathSnapshot.key(TENANT_A, sandboxA))).toBe(1);
		expect(await redis.exists(RedisPathSnapshot.key(TENANT_B, sandboxB))).toBe(1);
		expect(await redis.exists(legacyLockKey(sandboxA))).toBe(0);
		expect(await redis.exists(legacyLockKey(sandboxB))).toBe(0);

		const wrongTenantDestroy = await app.request(`/v1/sandboxes/${sandboxB}`, { method: "DELETE", headers: authA });
		expect(wrongTenantDestroy.status).toBe(404);
		expect((await app.request(`/v1/sandboxes/${sandboxA}`, { method: "DELETE", headers: authA })).status).toBe(204);
		expect((await app.request(`/v1/sandboxes/${sandboxB}`, { method: "DELETE", headers: authB })).status).toBe(204);
		expect(await sandboxCount(tenantASql)).toBe(0);
		expect(await sandboxCount(tenantBSql)).toBe(0);
	});

	it("legacy single-tenant mode accepts tokens without tenant claims and uses the default prefix", async () => {
		if (!redis) throw new Error("Redis client not initialized");
		const legacyConfig = loadTenantConfig({
			DATABASE_URL: multiTenantConfig.getConnectionString(TENANT_A),
		});
		const { app } = makeApp(legacyConfig, redis);
		const auth = await makeAuthHeader("legacy-user");
		const create = await app.request("/v1/sandboxes", {
			method: "POST",
			headers: { ...auth, "Content-Type": "application/json" },
			body: "{}",
		});
		expect(create.status).toBe(201);
		const sandboxId = extractId(await create.json());
		const execRes = await app.request(`/v1/sandboxes/${sandboxId}/exec-sync`, {
			method: "POST",
			headers: { ...auth, "Content-Type": "application/json" },
			body: JSON.stringify({ script: "echo legacy-ok > /home/user/legacy.txt && cat /home/user/legacy.txt" }),
		});
		expect(execRes.status).toBe(200);
		expect(((await execRes.json()) as { stdout: string; exitCode: number }).stdout).toBe("legacy-ok\n");
		expect(await redis.exists(versionKey("default", sandboxId))).toBe(1);
		const destroyRes = await app.request(`/v1/sandboxes/${sandboxId}`, { method: "DELETE", headers: auth });
		expect(destroyRes.status).toBe(204);
	});
});

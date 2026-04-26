/**
 * Hono HTTP server entry point.
 * US-056: Hono server bootstrap
 */

import { serve } from "@hono/node-server";
import { swaggerUI } from "@hono/swagger-ui";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { PostgresDialect } from "../fs/sql-fs/dialects/postgres.js";
import { translateSqlError } from "../fs/sql-fs/errors.js";
import { RedisBlobCache } from "../fs/sql-fs/redis-blob-cache.js";
import { RedisPathSnapshot } from "../fs/sql-fs/redis-path-snapshot.js";
import type { SandboxMeta } from "../fs/sql-fs/types.js";
import { getRedisClient } from "../redis/client.js";
import { parseNonNegativeInt } from "../redis/config.js";
import { type AuthVariables, createAuthMiddleware } from "./auth.js";
import { mapFsErrorToStatus } from "./errors.js";
import { mcpOptionsResponse, withMcpCors } from "./mcp-cors.js";
import { handleMcpRequest } from "./mcp/server.js";
import { runMigrations } from "./migrations.js";
import { openapiSpec } from "./openapi-spec.js";
import { authRoutes } from "./routes/auth.js";
import { execRoutes } from "./routes/exec.js";
import { fileRoutes } from "./routes/files.js";
import { ingestRoutes } from "./routes/ingest.js";
import { sandboxRoutes } from "./routes/sandboxes.js";
import { SessionManager } from "./session-manager.js";
import { loadTenantConfig } from "./tenants.js";

export const app = new Hono<{ Variables: AuthVariables }>();

// ── Tenant config + session manager ───────────────────────────────────────────

const tenantConfig = loadTenantConfig();

const redisClient = getRedisClient();
// Only parse Redis-scoped env vars when Redis is actually enabled. Parsing
// them unconditionally would abort startup on a malformed Redis option even
// in deployments that never touch Redis (REDIS_URL unset).
const execLockOptions = redisClient
	? {
			leaseMs: parseNonNegativeInt("REDIS_EXEC_LOCK_LEASE_MS", 60_000),
			renewMs: parseNonNegativeInt("REDIS_EXEC_LOCK_RENEW_MS", 20_000),
			acquireTimeoutMs: parseNonNegativeInt("REDIS_EXEC_LOCK_ACQUIRE_TIMEOUT_MS", 300_000),
		}
	: undefined;
const pathSnapshotEnabled = redisClient && process.env.REDIS_PATH_SNAPSHOT_ENABLED === "true";
const pathSnapshot =
	pathSnapshotEnabled && redisClient
		? new RedisPathSnapshot(redisClient, {
				ttlMs: parseNonNegativeInt("REDIS_PATH_SNAPSHOT_TTL_MS", 60 * 60 * 1000),
			})
		: undefined;

const blobCacheEnabled = redisClient && process.env.REDIS_BLOB_CACHE_ENABLED !== "false";
const blobCacheOptions = blobCacheEnabled
	? {
			ttlMs: parseNonNegativeInt("REDIS_BLOB_CACHE_TTL_MS", 24 * 60 * 60 * 1000),
			maxBytes: parseNonNegativeInt("REDIS_BLOB_MAX_BYTES", 8 * 1024 * 1024),
		}
	: undefined;

// Per-tenant metadata dialects for session rehydration on cold replicas. Each
// tenant gets a single long-lived dialect (connection-pooled internally).
interface MetaBackend {
	readonly dialect: PostgresDialect;
	connected: boolean;
	connectPromise?: Promise<void>;
}
const metaBackends: Map<string, MetaBackend> = new Map();

function getOrInitMetaBackend(tenantId: string): MetaBackend {
	const existing = metaBackends.get(tenantId);
	if (existing !== undefined) return existing;
	const url = tenantConfig.getConnectionString(tenantId);
	const backend: MetaBackend = { dialect: new PostgresDialect(url), connected: false };
	metaBackends.set(tenantId, backend);
	return backend;
}

async function ensureMetaConnected(backend: MetaBackend): Promise<void> {
	if (backend.connected) return;
	if (backend.connectPromise !== undefined) {
		await backend.connectPromise;
		return;
	}
	backend.connectPromise = (async () => {
		await backend.dialect.connect();
		backend.connected = true;
	})();
	try {
		await backend.connectPromise;
	} finally {
		backend.connectPromise = undefined;
	}
}

async function getSandboxMetaFn(tenantId: string, sandboxId: string): Promise<SandboxMeta | null> {
	const backend = getOrInitMetaBackend(tenantId);
	await ensureMetaConnected(backend);
	try {
		return await backend.dialect.transaction((tx) => backend.dialect.getSandboxMeta(tx, sandboxId));
	} catch (err) {
		throw translateSqlError(err, sandboxId);
	}
}

async function persistSandboxMetaFn(tenantId: string, sandboxId: string, meta: SandboxMeta): Promise<void> {
	const backend = getOrInitMetaBackend(tenantId);
	await ensureMetaConnected(backend);
	try {
		await backend.dialect.transaction((tx) => backend.dialect.updateSandboxMeta(tx, sandboxId, meta));
	} catch (err) {
		throw translateSqlError(err, sandboxId);
	}
}

async function closeMetaFns(): Promise<void> {
	for (const backend of metaBackends.values()) {
		if (backend.connected) {
			backend.connected = false;
			await backend.dialect.disconnect();
		}
	}
	metaBackends.clear();
}

const sessionManager = new SessionManager({
	tenantConfig,
	redis: redisClient,
	execLockOptions,
	pathSnapshot,
	blobCacheFactory:
		redisClient && blobCacheOptions
			? (tenantId: string) => new RedisBlobCache(redisClient, tenantId, blobCacheOptions)
			: undefined,
	getSandboxMetaFn,
	persistSandboxMetaFn,
});

// ── Auth middleware (all /v1/* routes) ────────────────────────────────────────

const authMiddleware = createAuthMiddleware(tenantConfig);
app.use("/v1/*", authMiddleware);

// ── Routes ────────────────────────────────────────────────────────────────────

app.route("/v1/auth", authRoutes());
app.route("/v1/sandboxes", sandboxRoutes(sessionManager));
app.route("/v1/sandboxes", fileRoutes(sessionManager));
app.route("/v1/sandboxes", execRoutes(sessionManager));
app.route("/v1/sandboxes", ingestRoutes(sessionManager));

// ── MCP endpoint (requires auth) + CORS for browser MCP clients (Inspector UI) ─

app.use("/mcp", async (c, next) => {
	if (c.req.method === "OPTIONS") {
		return mcpOptionsResponse(c.req.raw);
	}
	await next();
	if (c.res !== undefined) {
		c.res = withMcpCors(c.req.raw, c.res);
	}
});
app.use("/mcp", authMiddleware);
app.all("/mcp", (c) => handleMcpRequest(c.req.raw, sessionManager, c.get("owner"), c.get("tenant")));

// ── Middleware ─────────────────────────────────────────────────────────────────

/** Structured JSON request logging */
app.use("*", async (c, next) => {
	const start = Date.now();
	await next();
	const durationMs = Date.now() - start;
	console.log(
		JSON.stringify({
			method: c.req.method,
			path: c.req.path,
			status: c.res.status,
			durationMs,
		}),
	);
});

// ── Health endpoints ───────────────────────────────────────────────────────────

app.get("/healthz", (c) => c.json({ status: "ok" }));
app.get("/readyz", (c) => c.json({ status: "ok" }));

// ── OpenAPI / Swagger ──────────────────────────────────────────────────────────

app.get("/openapi.json", (c) => c.json(openapiSpec));
app.get("/docs", swaggerUI({ url: "/openapi.json" }));

// ── Global error handler ───────────────────────────────────────────────────────

app.onError((err, c) => {
	const status = mapFsErrorToStatus(err) as ContentfulStatusCode;
	const code = (err as Error & { code?: string }).code ?? "INTERNAL_ERROR";

	const knownFsCodes = [
		"ENOENT",
		"EEXIST",
		"EISDIR",
		"ENOTDIR",
		"EPERM",
		"FORBIDDEN",
		"ENOTEMPTY",
		"ESESSIONCLOSING",
		"ELOOP",
		"EINVAL",
		"ELOCKTIMEOUT",
		"ELOCKLOST",
	];
	const message = knownFsCodes.includes(code) ? err.message : "Internal server error";

	return c.json({ error: message, code }, status);
});

// ── Server bootstrap (only when run as entry point) ───────────────────────────

const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ""));

if (isMain) {
	void (async () => {
		try {
			if (process.env.SKIP_STARTUP_MIGRATIONS !== "true") {
				await runMigrations(tenantConfig);
			}
		} catch (err) {
			console.error(JSON.stringify({ event: "startup_failed", error: (err as Error).message }));
			process.exit(1);
		}
		const port = Number(process.env.PORT ?? "8080");
		const server = serve({ fetch: app.fetch, port }, () => {
			console.log(JSON.stringify({ event: "server_start", port, tenantCount: tenantConfig.tenantIds.length }));
		});

		let shuttingDown = false;
		const shutdown = (): void => {
			if (shuttingDown) return;
			shuttingDown = true;
			server.close(async () => {
				try {
					await closeMetaFns();
				} finally {
					process.exit(0);
				}
			});
		};
		process.once("SIGINT", shutdown);
		process.once("SIGTERM", shutdown);
	})();
}

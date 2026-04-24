/**
 * Hono HTTP server entry point.
 * US-056: Hono server bootstrap
 */

import { serve } from "@hono/node-server";
import { swaggerUI } from "@hono/swagger-ui";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { PostgresDialect } from "../fs/sql-fs/dialects/postgres.js";
import type { StorageBackend } from "../fs/sql-fs/index.js";
import { RedisPathSnapshot } from "../fs/sql-fs/redis-path-snapshot.js";
import { getRedisClient } from "../redis/client.js";
import { parseNonNegativeInt } from "../redis/config.js";
import { type AuthVariables, authMiddleware } from "./auth.js";
import { mapFsErrorToStatus } from "./errors.js";
import { mcpOptionsResponse, withMcpCors } from "./mcp-cors.js";
import { handleMcpRequest } from "./mcp/server.js";
import { openapiSpec } from "./openapi-spec.js";
import { adminRoutes } from "./routes/admin.js";
import { execRoutes } from "./routes/exec.js";
import { fileRoutes } from "./routes/files.js";
import { ingestRoutes } from "./routes/ingest.js";
import { sandboxRoutes } from "./routes/sandboxes.js";
import { SessionManager } from "./session-manager.js";

export const app = new Hono<{ Variables: AuthVariables }>();

// ── Session manager (lazy — no DB access until first request) ─────────────────

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

const backend = (process.env.FS_BACKEND as StorageBackend | undefined) ?? "memory";

// Postgres existence check for session rehydration on cold replicas.
// Uses a single long-lived dialect (connection-pooled internally by the postgres driver).
let sandboxExistsFn: ((sandboxId: string) => Promise<boolean>) | undefined;
if (backend === "postgres" && process.env.DATABASE_URL) {
	const existsDialect = new PostgresDialect(process.env.DATABASE_URL);
	let connected = false;
	sandboxExistsFn = async (sandboxId: string): Promise<boolean> => {
		if (!connected) {
			await existsDialect.connect();
			connected = true;
		}
		return existsDialect.transaction(async (tx) => {
			return existsDialect.sandboxExists(tx, sandboxId);
		});
	};
}

const sessionManager = new SessionManager({
	backend,
	redis: redisClient,
	execLockOptions,
	pathSnapshot,
	sandboxExistsFn,
});

// ── Auth middleware (all /v1/* routes) ────────────────────────────────────────

app.use("/v1/*", authMiddleware);

// ── Routes ────────────────────────────────────────────────────────────────────

app.route("/v1/admin", adminRoutes);
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
app.all("/mcp", (c) => handleMcpRequest(c.req.raw, sessionManager, c.get("owner")));

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

	// Sanitize error messages: only expose FS error codes/messages, not internal details
	// FS errors have well-known codes; internal errors get a generic message
	const knownFsCodes = [
		"ENOENT",
		"EEXIST",
		"EISDIR",
		"ENOTDIR",
		"EPERM",
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
	const port = Number(process.env.PORT ?? "8080");
	serve({ fetch: app.fetch, port }, () => {
		console.log(JSON.stringify({ event: "server_start", port }));
	});
}

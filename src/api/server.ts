/**
 * Hono HTTP server entry point.
 * US-056: Hono server bootstrap
 */

import { serve } from "@hono/node-server";
import { swaggerUI } from "@hono/swagger-ui";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { closeRedisClient, getRedisClient } from "../redis/client.js";
import { parseNonNegativeInt, parsePositiveInt } from "../redis/config.js";
import { PostgresDialect } from "../sql-fs/dialects/postgres.js";
import { translateSqlError } from "../sql-fs/errors.js";
import { RedisBlobCache } from "../sql-fs/redis-blob-cache.js";
import { RedisPathSnapshot } from "../sql-fs/redis-path-snapshot.js";
import type { SandboxListEntry, SandboxMeta } from "../sql-fs/types.js";
import { type AuthVariables, createAuthMiddleware, loadStaticMcpAuthConfig } from "./auth.js";
import { clientSafeErrorMessage, mapFsErrorToStatus } from "./errors.js";
import { DEFAULT_SAMPLE_INTERVAL_MS, startEventLoopMonitor, stopEventLoopMonitor } from "./event-loop-monitor.js";
import { mcpOptionsResponse, withMcpCors } from "./mcp-cors.js";
import { handleMcpRequest, shutdownMcp, startMcpSessionSweeper } from "./mcp/server.js";
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
			// F9d: tunable acquire poll interval (jittered to [retryMs/2, retryMs]).
			acquireRetryMs: parsePositiveInt("REDIS_EXEC_LOCK_ACQUIRE_RETRY_MS", 50),
			readerLeaseMs: parseNonNegativeInt("REDIS_RWLOCK_READER_LEASE_MS", 60_000),
		}
	: undefined;
const rwlockEnabled = process.env.REDIS_RWLOCK_ENABLED !== "false";
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

async function listSandboxesFn(tenantId: string, owner?: string): Promise<SandboxListEntry[]> {
	const backend = getOrInitMetaBackend(tenantId);
	await ensureMetaConnected(backend);
	try {
		return await backend.dialect.transaction((tx) => backend.dialect.listSandboxes(tx, owner));
	} catch (err) {
		throw translateSqlError(err, "listSandboxes");
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
	rwlockEnabled,
	pathSnapshot,
	blobCacheFactory:
		redisClient && blobCacheOptions
			? (tenantId: string) => new RedisBlobCache(redisClient, tenantId, blobCacheOptions)
			: undefined,
	getSandboxMetaFn,
	persistSandboxMetaFn,
	listSandboxesFn,
});

// ── Structured JSON request logging ───────────────────────────────────────────
// Registered BEFORE the routes so it actually wraps /v1/* and /mcp (audit L6 —
// it previously sat after the terminal handlers and never ran for them).
app.use("*", async (c, next) => {
	const start = Date.now();
	await next();
	const durationMs = Date.now() - start;
	console.log(
		JSON.stringify({
			method: c.req.method,
			path: c.req.path,
			status: c.res?.status,
			durationMs,
		}),
	);
});

// ── Global request body-size backstop (audit H11) ─────────────────────────────
// Hard ceiling applied BEFORE auth/handlers so a multi-GB body can never be
// buffered into memory (OOM). Sits above the tighter per-route limits
// (raw-file write, bulk write, ingest). Configurable via MAX_REQUEST_BODY_BYTES.
const MAX_REQUEST_BODY_BYTES = Number(process.env.MAX_REQUEST_BODY_BYTES ?? `${256 * 1024 * 1024}`);
const bodyLimitMiddleware = bodyLimit({
	maxSize: MAX_REQUEST_BODY_BYTES,
	onError: (c) =>
		c.json(
			{
				error: "payload_too_large",
				code: "PAYLOAD_TOO_LARGE",
				details: [`Request body exceeds limit (${MAX_REQUEST_BODY_BYTES} bytes)`],
			},
			413 as ContentfulStatusCode,
		),
});
app.use("/v1/*", bodyLimitMiddleware);
app.use("/mcp", bodyLimitMiddleware);

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

// Static-header (API-key) auth for MCP clients that cannot mint a per-request
// JWT (e.g. LibreChat). Enabled only when MCP_API_KEY is set; otherwise /mcp
// keeps JWT-only behaviour. A non-matching Bearer token still falls through to
// JWT verification, so existing JWT clients keep working on /mcp regardless.
const staticMcpAuth = loadStaticMcpAuthConfig(tenantConfig);
if (staticMcpAuth !== undefined) {
	console.log(
		JSON.stringify({
			event: "mcp_static_auth_enabled",
			identityHeader: staticMcpAuth.identityHeader,
			tenant: staticMcpAuth.tenant,
			// Log only whether a fallback owner is configured — MCP_DEFAULT_SUB can be
			// an email/identifier and must not be written verbatim to process logs.
			hasDefaultSub: staticMcpAuth.defaultSub !== undefined,
		}),
	);
}
const mcpAuthMiddleware = createAuthMiddleware(tenantConfig, { staticAuth: staticMcpAuth });

app.use("/mcp", async (c, next) => {
	if (c.req.method === "OPTIONS") {
		return mcpOptionsResponse(c.req.raw, staticMcpAuth?.identityHeader);
	}
	await next();
	if (c.res !== undefined) {
		c.res = withMcpCors(c.req.raw, c.res);
	}
});
app.use("/mcp", mcpAuthMiddleware);
app.all("/mcp", (c) => handleMcpRequest(c.req.raw, sessionManager, c.get("owner"), c.get("tenant")));

// ── Health endpoints ───────────────────────────────────────────────────────────

app.get("/healthz", (c) => c.json({ status: "ok" }));
app.get("/readyz", async (c) => {
	// F5: reflect Redis health. When Redis is configured but unreachable, the
	// service is degraded (lock acquire will fast-fail 503), so /readyz must not
	// report ready. The PING is bounded by the client's commandTimeout (2 s) and
	// races a local timeout so a hung socket cannot stall the probe.
	if (redisClient !== undefined) {
		try {
			const pong = await Promise.race([
				redisClient.ping(),
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error("ping_timeout")), 2_000)),
			]);
			if (pong !== "PONG") {
				return c.json({ status: "degraded", redis: "unexpected_reply" }, 503);
			}
		} catch (err) {
			return c.json({ status: "degraded", redis: (err as Error).message }, 503);
		}
	}
	return c.json({ status: "ok" });
});

// ── OpenAPI / Swagger ──────────────────────────────────────────────────────────

app.get("/openapi.json", (c) => c.json(openapiSpec));
app.get("/docs", swaggerUI({ url: "/openapi.json" }));

// ── Global error handler ───────────────────────────────────────────────────────

app.onError((err, c) => {
	const status = mapFsErrorToStatus(err) as ContentfulStatusCode;
	const code = (err as Error & { code?: string }).code ?? "INTERNAL_ERROR";
	const message = clientSafeErrorMessage(err);

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

		// Wire production lifecycle: reaper sweeps idle warm sessions; MCP
		// sweeper evicts idle MCP transports.
		sessionManager.startReaper();
		startMcpSessionSweeper();

		// F8: process-wide event-loop-lag monitor. Purely observational — surfaces
		// the GC-pause / sync-stall class that can silently void a Redis lease
		// (see event-loop-monitor.ts). The sampling timer is unref()'d internally.
		startEventLoopMonitor({
			sampleIntervalMs: parsePositiveInt("EVENT_LOOP_MONITOR_INTERVAL_MS", DEFAULT_SAMPLE_INTERVAL_MS),
		});

		let shuttingDown = false;
		const shutdown = (): void => {
			if (shuttingDown) return;
			shuttingDown = true;
			console.log(JSON.stringify({ event: "shutdown_begin" }));
			stopEventLoopMonitor();
			// Force-exit guard so a hung Postgres or Redis cleanup cannot keep
			// the process alive past the orchestrator's grace period.
			const forceExit = setTimeout(() => {
				console.error(JSON.stringify({ event: "shutdown_force_exit" }));
				process.exit(1);
			}, 60_000);
			if (typeof forceExit.unref === "function") forceExit.unref();
			server.close(async () => {
				try {
					await shutdownMcp();
				} catch (err) {
					console.error(JSON.stringify({ event: "shutdown_mcp_error", error: (err as Error).message }));
				}
				try {
					await sessionManager.shutdown();
				} catch (err) {
					console.error(JSON.stringify({ event: "shutdown_session_manager_error", error: (err as Error).message }));
				}
				try {
					await closeMetaFns();
				} catch (err) {
					console.error(JSON.stringify({ event: "shutdown_close_meta_error", error: (err as Error).message }));
				}
				try {
					await closeRedisClient();
				} catch (err) {
					console.error(JSON.stringify({ event: "shutdown_redis_error", error: (err as Error).message }));
				}
				console.log(JSON.stringify({ event: "shutdown_complete" }));
				process.exit(0);
			});
		};
		process.once("SIGINT", shutdown);
		process.once("SIGTERM", shutdown);
	})();
}

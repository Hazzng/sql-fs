/**
 * Hono HTTP server entry point.
 * US-056: Hono server bootstrap
 */

import { serve } from "@hono/node-server";
import { swaggerUI } from "@hono/swagger-ui";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { getRedisCircuitBreaker } from "../redis/circuit-breaker.js";
import { closeRedisClient, getRedisClient } from "../redis/client.js";
import { parseNonNegativeInt, parsePositiveInt } from "../redis/config.js";
import { startEvictionPolicyCheck } from "../redis/eviction-policy.js";
import { PostgresDialect } from "../sql-fs/dialects/postgres.js";
import { installDriverFaultGuard, raceDriverFault } from "../sql-fs/driver-fault.js";
import { translateSqlError } from "../sql-fs/errors.js";
import { RedisBlobCache } from "../sql-fs/redis-blob-cache.js";
import { RedisPathSnapshot } from "../sql-fs/redis-path-snapshot.js";
import type { SandboxListEntry, SandboxMeta } from "../sql-fs/types.js";
import { type AuthVariables, createAuthMiddleware, loadStaticMcpAuthConfig } from "./auth.js";
import { clientSafeErrorCode, clientSafeErrorMessage, isRetryableError, mapFsErrorToStatus } from "./errors.js";
import {
	DEFAULT_SAMPLE_INTERVAL_MS,
	DEFAULT_STALL_THRESHOLD_MS,
	eventLoopLagSnapshot,
	startEventLoopMonitor,
	stopEventLoopMonitor,
} from "./event-loop-monitor.js";
import { loadExecLockOptions } from "./exec-lock-config.js";
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

// #167: two connections. `redisClient` (control) carries the locks, the version
// counter and session state; `redisDataClient` carries the blob cache and path
// snapshot. Multi-MiB cache writes must not head-of-line block an INCR.
const redisClient = getRedisClient("control");
// Read data-plane demand from env BEFORE opening the data connection: a
// lock-only deployment (blob cache off, snapshot off) must not pay for a
// second socket nothing will ever use. REDIS_DATA_URL falls back to REDIS_URL
// inside getRedisClient, so calling it unconditionally would always connect.
const blobCacheEnvEnabled = process.env.REDIS_BLOB_CACHE_ENABLED !== "false";
const snapshotEnvEnabled = process.env.REDIS_PATH_SNAPSHOT_ENABLED === "true";
const redisDataClient = blobCacheEnvEnabled || snapshotEnvEnabled ? getRedisClient("data") : undefined;
// Only parse Redis-scoped env vars when Redis is actually enabled. Parsing
// them unconditionally would abort startup on a malformed Redis option even
// in deployments that never touch Redis (REDIS_URL unset).
const execLockOptions = redisClient ? loadExecLockOptions() : undefined;
const rwlockEnabled = process.env.REDIS_RWLOCK_ENABLED !== "false";
// Snapshots are version-checked against the control-side counter on every read
// (and written only alongside its INCR), so without the control connection a
// snapshot cache could never hit — require both clients.
const pathSnapshotEnabled = redisClient !== undefined && redisDataClient !== undefined && snapshotEnvEnabled;
const pathSnapshot =
	pathSnapshotEnabled && redisDataClient
		? new RedisPathSnapshot(redisDataClient, {
				ttlMs: parseNonNegativeInt("REDIS_PATH_SNAPSHOT_TTL_MS", 60 * 60 * 1000),
			})
		: undefined;

const blobCacheEnabled = redisDataClient !== undefined && blobCacheEnvEnabled;
const blobCacheOptions = blobCacheEnabled
	? {
			ttlMs: parseNonNegativeInt("REDIS_BLOB_CACHE_TTL_MS", 24 * 60 * 60 * 1000),
			maxBytes: parseNonNegativeInt("REDIS_BLOB_MAX_BYTES", 8 * 1024 * 1024),
			maxInFlight: parsePositiveInt("REDIS_BLOB_SET_MAX_IN_FLIGHT", 32),
			maxInFlightBytes: parsePositiveInt("REDIS_BLOB_SET_MAX_IN_FLIGHT_BYTES", 32 * 1024 * 1024),
			breaker: getRedisCircuitBreaker("data"),
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
		redisDataClient && blobCacheOptions
			? (tenantId: string) => new RedisBlobCache(redisDataClient, tenantId, blobCacheOptions)
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
	// #168: the lag histogram had no egress but a console.log, so nothing could poll how close this
	// replica was running to the 2 s Redis commandTimeout. Reading it does not reset the histogram,
	// so a scraper cannot perturb the windowed `event_loop_lag` line. Absent when the monitor is not
	// running (unit tests, and any embed that does not boot via the entry point).
	const eventLoop = eventLoopLagSnapshot();
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
				return c.json({ status: "degraded", redis: "unexpected_reply", ...(eventLoop && { eventLoop }) }, 503);
			}
		} catch (err) {
			return c.json({ status: "degraded", redis: (err as Error).message, ...(eventLoop && { eventLoop }) }, 503);
		}
	}
	return c.json({ status: "ok", ...(eventLoop && { eventLoop }) });
});

// ── OpenAPI / Swagger ──────────────────────────────────────────────────────────

app.get("/openapi.json", (c) => c.json(openapiSpec));
app.get("/docs", swaggerUI({ url: "/openapi.json" }));

// ── Global error handler ───────────────────────────────────────────────────────

app.onError((err, c) => {
	const status = mapFsErrorToStatus(err) as ContentfulStatusCode;
	const code = clientSafeErrorCode(err);
	const message = clientSafeErrorMessage(err);
	// #175: six distinct codes share 503, and they disagree about durability.
	// `retryable` is the discriminator so a client never has to enumerate codes
	// to learn whether a retry can double-apply a write.
	const retryable = isRetryableError(err);

	return c.json({ error: message, code, retryable }, status);
});

/**
 * Boot migrations, behind the same driver-fault race as every other DB await (#169 M5).
 *
 * Before the guard, a driver fault here was an uncaught exception: loud, exit 1, the orchestrator
 * restarts the replica. With the guard absorbing that frame and nothing ever settling the query
 * the driver dropped, an unraced `runMigrations` hangs forever and the process never reaches
 * `listen` — no health check to fail, no restart, nothing in the log after startup. Suppressing
 * the crash without racing the await just trades a loud failure for a silent one.
 *
 * Exported so the race is testable; the bootstrap below is the only production caller.
 */
export async function runStartupMigrations(): Promise<void> {
	if (process.env.SKIP_STARTUP_MIGRATIONS === "true") return;
	await raceDriverFault(() => runMigrations(tenantConfig));
}

// ── Server bootstrap (only when run as entry point) ───────────────────────────

const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ""));

if (isMain) {
	// Before anything opens a connection: postgres.js can throw a fatal TypeError out of its own
	// socket-write path when a backend is reaped mid-transaction, killing the replica and every
	// other in-flight request on it (#169). The guard absorbs exactly that frame and fails the
	// in-flight DB awaits with EDRIVERFAULT; everything else still crashes the process.
	installDriverFaultGuard();

	void (async () => {
		try {
			await runStartupMigrations();
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

		// #188: the Redis backing the blob cache must evict under memory pressure.
		// Under `noeviction` a full instance refuses writes and never recovers,
		// because blob entries carry a 24h TTL. Warn only, and never await: a
		// managed Redis that refuses CONFIG GET must still boot.
		//
		// #188 M8: only when this client actually carries data-plane state. With
		// the blob cache off and no path snapshot, `REDIS_DATA_URL`'s fallback
		// makes the data client the CONTROL instance, and a control-only Redis
		// holds nothing evictable worth trading: paging its operator to switch to
		// allkeys-* would make the exec-lock leases, version counters and destroy
		// tombstones evictable — the remediation would be the outage.
		startEvictionPolicyCheck(redisDataClient, {
			carriesDataPlane: Boolean(blobCacheEnabled) || Boolean(pathSnapshotEnabled),
		});

		// F8: process-wide event-loop-lag monitor. Purely observational — surfaces
		// the GC-pause / sync-stall class that can silently void a Redis lease
		// (see event-loop-monitor.ts). The sampling timer is unref()'d internally.
		startEventLoopMonitor({
			sampleIntervalMs: parsePositiveInt("EVENT_LOOP_MONITOR_INTERVAL_MS", DEFAULT_SAMPLE_INTERVAL_MS),
			stallThresholdMs: parsePositiveInt("EVENT_LOOP_STALL_THRESHOLD_MS", DEFAULT_STALL_THRESHOLD_MS),
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

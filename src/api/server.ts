/**
 * Hono HTTP server entry point.
 * US-056: Hono server bootstrap
 */

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { StorageBackend } from "../fs/sql-fs/index.js";
import { type AuthVariables, authMiddleware } from "./auth.js";
import { mapFsErrorToStatus } from "./errors.js";
import { mcpOptionsResponse, withMcpCors } from "./mcp-cors.js";
import { handleMcpRequest } from "./mcp/server.js";
import { adminRoutes } from "./routes/admin.js";
import { execRoutes } from "./routes/exec.js";
import { fileRoutes } from "./routes/files.js";
import { ingestRoutes } from "./routes/ingest.js";
import { sandboxRoutes } from "./routes/sandboxes.js";
import { SessionManager } from "./session-manager.js";

export const app = new Hono<{ Variables: AuthVariables }>();

// ── Session manager (lazy — no DB access until first request) ─────────────────

const sessionManager = new SessionManager({
	backend: (process.env.FS_BACKEND as StorageBackend | undefined) ?? "memory",
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

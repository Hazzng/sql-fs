import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthVariables } from "../../auth.js";
import { signToken } from "../../lib/jwt.js";

const SECRET = "metrics-auth-test-secret-at-least-32-bytes";
let app: Hono<{ Variables: AuthVariables }>;

beforeAll(async () => {
	vi.stubEnv("AUTH_SECRET", SECRET);
	vi.stubEnv(
		"TENANT_DATABASES",
		JSON.stringify({ default: "postgres://stub/default", other: "postgres://stub/other" }),
	);
	vi.stubEnv("REDIS_URL", undefined);
	vi.stubEnv("REDIS_DATA_URL", undefined);
	vi.stubEnv("SQL_FS_WORKERS_ENABLED", "false");
	({ app } = await import("../../server.js"));
});

afterAll(() => vi.unstubAllEnvs());

describe("GET /metrics authentication", () => {
	it.each([
		[undefined, "AUTH_REQUIRED", "unauthorized"],
		["Basic invalid", "AUTH_REQUIRED", "unauthorized"],
		["Bearer", "AUTH_REQUIRED", "unauthorized"],
		["Bearer malformed-token", "AUTH_INVALID", "invalid_token"],
	])("rejects authorization %s without exposing metrics", async (authorization, code, error) => {
		const response = await app.request("/metrics", {
			headers: authorization === undefined ? {} : { Authorization: authorization },
		});
		expect(response.status).toBe(401);
		expect(response.headers.get("Content-Type")).toBe("application/json");
		expect(await response.json()).toEqual({ error, code });
	});

	it.each([
		["wrong signing key", { secret: "wrong-metrics-auth-secret-at-least-32-bytes" }, "AUTH_INVALID", "invalid_token"],
		["expired token", { expiresIn: "-1s" }, "AUTH_INVALID", "invalid_token"],
		["unknown tenant", { tenant: "unconfigured" }, "AUTH_UNKNOWN_TENANT", "unknown_tenant"],
	])("rejects %s without exposing metrics", async (_name, options, code, error) => {
		const token = await signToken({ sub: "metrics-reader", secret: SECRET, ...options });
		const response = await app.request("/metrics", { headers: { Authorization: `Bearer ${token}` } });
		expect(response.status).toBe(401);
		expect(response.headers.get("Content-Type")).toBe("application/json");
		expect(await response.json()).toEqual({ error, code });
	});

	it.each([undefined, "other"])("returns unchanged Prometheus text for a valid tenant %s JWT", async (tenant) => {
		const token = await signToken({ sub: "metrics-reader", secret: SECRET, tenant });
		const response = await app.request("/metrics", { headers: { Authorization: `Bearer ${token}` } });
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("text/plain; version=0.0.4; charset=utf-8");
		expect(await response.text()).toBe(
			"# TYPE sql_fs_workers_enabled gauge\nsql_fs_workers_enabled 0\n# TYPE sql_fs_ingress_enabled gauge\nsql_fs_ingress_enabled 0\n",
		);
	});

	it.each(["/healthz", "/readyz"])("keeps %s available without authentication", async (path) => {
		const response = await app.request(path);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: "ok" });
	});
});

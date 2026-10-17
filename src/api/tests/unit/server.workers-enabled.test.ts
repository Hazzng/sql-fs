import { afterEach, expect, it, vi } from "vitest";
import { signToken } from "../../lib/jwt.js";

const SECRET = "workers-enabled-test-secret-at-least-32-bytes";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.resetModules();
});

function stubServerEnv(workersEnabled: string | undefined): void {
	vi.stubEnv("AUTH_SECRET", SECRET);
	vi.stubEnv("TENANT_DATABASES", JSON.stringify({ default: "postgres://unused/test" }));
	vi.stubEnv("REDIS_URL", undefined);
	vi.stubEnv("REDIS_DATA_URL", undefined);
	vi.stubEnv("SQL_FS_WORKERS_ENABLED", workersEnabled);
}

it.each([
	[undefined, 1],
	["true", 1],
	["false", 0],
])("SQL_FS_WORKERS_ENABLED=%s sets worker and ingress mode to %i", async (value, enabled) => {
	stubServerEnv(value);
	const { app } = await import("../../server.js");
	const token = await signToken({ sub: "metrics-reader", secret: SECRET });
	const response = await app.request("/metrics", { headers: { Authorization: `Bearer ${token}` } });
	const metrics = await response.text();
	expect(metrics).toContain(`sql_fs_workers_enabled ${enabled}\n`);
	expect(metrics).toContain(`sql_fs_ingress_enabled ${enabled}\n`);
});

it("rejects an invalid SQL_FS_WORKERS_ENABLED at startup", async () => {
	stubServerEnv("yes");
	await expect(import("../../server.js")).rejects.toThrow("SQL_FS_WORKERS_ENABLED must be true or false");
});

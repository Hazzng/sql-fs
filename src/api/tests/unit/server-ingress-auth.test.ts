import { SignJWT } from "jose";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllEnvs());

it("authenticates production worker-mode routes before body admission", async () => {
	const secret = "server-ingress-auth-test-secret-32";
	vi.stubEnv("AUTH_SECRET", secret);
	vi.stubEnv("ADMIN_SECRET", "admin-test-secret");
	vi.stubEnv("SQL_FS_WORKERS_ENABLED", "true");
	vi.stubEnv("REDIS_URL", "");
	vi.stubEnv("REDIS_DATA_URL", "");
	vi.stubEnv("TENANT_DATABASES", JSON.stringify({ default: "postgres://unused/test" }));
	vi.stubEnv("MCP_API_KEY", "static-test-key-32-characters-long");
	vi.stubEnv("MCP_DEFAULT_SUB", "test-owner");
	vi.stubEnv("MCP_STATIC_TENANT", "default");
	vi.stubEnv("MAX_REQUEST_BODY_BYTES", "10");
	const { app, ingressAdmission } = await import("../../server.js");
	const token = await new SignJWT({ sub: "owner", tenant: "default" })
		.setProtectedHeader({ alg: "HS256" })
		.sign(new TextEncoder().encode(secret));
	const requests = [
		["/v1/sandboxes", {}, 401],
		["/v1/sandboxes", { Authorization: `Bearer ${token}` }, 413],
		["/v1/auth/bootstrap", {}, 403],
		["/v1/auth/bootstrap", { "X-Auth-Secret": secret }, 413],
		["/v1/auth/admin", { Authorization: `Bearer ${token}` }, 403],
		["/v1/auth/admin", { Authorization: `Bearer ${token}`, "X-Admin-Secret": "admin-test-secret" }, 413],
		["/mcp", { Authorization: "Bearer invalid" }, 401],
		["/mcp", { Authorization: "Bearer static-test-key-32-characters-long" }, 413],
	] as const;
	for (const [path, headers, status] of requests) {
		const response = await app.request(path, {
			method: "POST",
			headers: { ...headers, "Content-Length": "11" },
			body: "12345678901",
		});
		expect(response.status).toBe(status);
	}
	expect(ingressAdmission?.metrics).toMatchObject({
		activeRequests: 0,
		retainedRawBytes: 0,
		refused: 0,
		payloadTooLarge: 4,
	});
});

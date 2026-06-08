/**
 * Unit tests for loadStaticMcpAuthConfig + sanitizeIdentity (issue #117).
 * Config is validated at load time (fail-fast at startup), not per-request.
 */

import { describe, expect, it } from "vitest";
import { loadStaticMcpAuthConfig, sanitizeIdentity } from "../../auth.js";
import type { TenantConfig } from "../../tenants.js";

function makeTenantConfig(ids: readonly string[]): TenantConfig {
	const set = new Set(ids);
	return {
		tenantIds: [...ids],
		hasTenant: (id) => set.has(id),
		getConnectionString: (id) => {
			if (!set.has(id)) throw new Error(`Unknown tenant: ${id}`);
			return `postgres://stub/${id}`;
		},
	};
}

const tenants = makeTenantConfig(["default", "tenant-a"]);
const STRONG_KEY = "static-mcp-api-key-1234567890";

describe("loadStaticMcpAuthConfig", () => {
	it("returns undefined when MCP_API_KEY is unset (static auth disabled)", () => {
		expect(loadStaticMcpAuthConfig(tenants, {})).toBeUndefined();
	});

	it("returns undefined when MCP_API_KEY is empty", () => {
		expect(loadStaticMcpAuthConfig(tenants, { MCP_API_KEY: "" })).toBeUndefined();
	});

	it("applies defaults: identity header x-librechat-user-id, default tenant", () => {
		const config = loadStaticMcpAuthConfig(tenants, { MCP_API_KEY: STRONG_KEY });
		expect(config).toEqual({
			apiKey: STRONG_KEY,
			identityHeader: "x-librechat-user-id",
			defaultSub: undefined,
			tenant: "default",
		});
	});

	it("lowercases and trims a custom identity header", () => {
		const config = loadStaticMcpAuthConfig(tenants, {
			MCP_API_KEY: STRONG_KEY,
			MCP_IDENTITY_HEADER: "  X-User-Email  ",
		});
		expect(config?.identityHeader).toBe("x-user-email");
	});

	it("carries a valid defaultSub and configured tenant", () => {
		const config = loadStaticMcpAuthConfig(tenants, {
			MCP_API_KEY: STRONG_KEY,
			MCP_DEFAULT_SUB: "shared-owner",
			MCP_STATIC_TENANT: "tenant-a",
		});
		expect(config).toEqual({
			apiKey: STRONG_KEY,
			identityHeader: "x-librechat-user-id",
			defaultSub: "shared-owner",
			tenant: "tenant-a",
		});
	});

	it("throws when MCP_API_KEY is shorter than 16 characters", () => {
		expect(() => loadStaticMcpAuthConfig(tenants, { MCP_API_KEY: "short" })).toThrow(/at least 16 characters/);
	});

	it("throws when MCP_IDENTITY_HEADER is not a valid header name", () => {
		expect(() =>
			loadStaticMcpAuthConfig(tenants, { MCP_API_KEY: STRONG_KEY, MCP_IDENTITY_HEADER: "bad header" }),
		).toThrow(/not a valid HTTP header name/);
	});

	it("throws when MCP_DEFAULT_SUB is invalid", () => {
		expect(() =>
			loadStaticMcpAuthConfig(tenants, { MCP_API_KEY: STRONG_KEY, MCP_DEFAULT_SUB: "a".repeat(257) }),
		).toThrow(/MCP_DEFAULT_SUB is invalid/);
	});

	it("throws when MCP_STATIC_TENANT is not configured", () => {
		expect(() => loadStaticMcpAuthConfig(tenants, { MCP_API_KEY: STRONG_KEY, MCP_STATIC_TENANT: "ghost" })).toThrow(
			/not a configured tenant/,
		);
	});
});

describe("sanitizeIdentity", () => {
	it("returns undefined for undefined input", () => {
		expect(sanitizeIdentity(undefined)).toBeUndefined();
	});

	it("trims surrounding whitespace", () => {
		expect(sanitizeIdentity("  alice@example.com  ")).toBe("alice@example.com");
	});

	it("returns undefined for empty / whitespace-only input", () => {
		expect(sanitizeIdentity("")).toBeUndefined();
		expect(sanitizeIdentity("   ")).toBeUndefined();
	});

	it("returns undefined for values longer than 256 chars", () => {
		expect(sanitizeIdentity("a".repeat(257))).toBeUndefined();
		expect(sanitizeIdentity("a".repeat(256))).toBe("a".repeat(256));
	});

	it("returns undefined when an internal control character is present", () => {
		expect(sanitizeIdentity("alice\u0000bob")).toBeUndefined(); // NUL
		expect(sanitizeIdentity("alice\nbob")).toBeUndefined(); // newline (0x0A)
		expect(sanitizeIdentity("alice\tbob")).toBeUndefined(); // tab (0x09)
		expect(sanitizeIdentity("alice\u007fbob")).toBeUndefined(); // DEL (0x7F)
	});

	it("allows common identity characters (@ . + - _)", () => {
		expect(sanitizeIdentity("user.name+tag-1_2@example.com")).toBe("user.name+tag-1_2@example.com");
	});
});

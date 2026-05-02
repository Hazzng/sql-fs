/**
 * Unit tests for loadTenantConfig.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_TENANT_ID, loadTenantConfig } from "../../tenants.js";

function env(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
	return overrides as NodeJS.ProcessEnv;
}

describe("loadTenantConfig", () => {
	it("parses TENANT_DATABASES JSON into a tenant map", () => {
		const cfg = loadTenantConfig(
			env({
				TENANT_DATABASES: JSON.stringify({
					"tenant-a": "postgres://localhost/a",
					"tenant-b": "postgres://localhost/b",
				}),
			}),
		);

		expect(cfg.tenantIds).toEqual(["tenant-a", "tenant-b"]);
		expect(cfg.hasTenant("tenant-a")).toBe(true);
		expect(cfg.hasTenant("tenant-b")).toBe(true);
		expect(cfg.hasTenant("ghost")).toBe(false);
		expect(cfg.getConnectionString("tenant-a")).toBe("postgres://localhost/a");
		expect(cfg.getConnectionString("tenant-b")).toBe("postgres://localhost/b");
	});

	it("falls back to DATABASE_URL under tenant 'default' when TENANT_DATABASES is unset", () => {
		const cfg = loadTenantConfig(
			env({
				DATABASE_URL: "postgres://localhost/legacy",
			}),
		);

		expect(cfg.tenantIds).toEqual([DEFAULT_TENANT_ID]);
		expect(cfg.hasTenant(DEFAULT_TENANT_ID)).toBe(true);
		expect(cfg.getConnectionString(DEFAULT_TENANT_ID)).toBe("postgres://localhost/legacy");
	});

	it("TENANT_DATABASES takes precedence over DATABASE_URL when both are set", () => {
		const cfg = loadTenantConfig(
			env({
				TENANT_DATABASES: JSON.stringify({ alpha: "postgres://alpha" }),
				DATABASE_URL: "postgres://legacy",
			}),
		);

		expect(cfg.tenantIds).toEqual(["alpha"]);
		expect(cfg.hasTenant(DEFAULT_TENANT_ID)).toBe(false);
	});

	it("throws when neither env var is set", () => {
		expect(() => loadTenantConfig(env({}))).toThrow(/Tenant configuration missing/);
	});

	it("throws on invalid JSON", () => {
		expect(() => loadTenantConfig(env({ TENANT_DATABASES: "not-json{" }))).toThrow(
			/TENANT_DATABASES is not valid JSON/,
		);
	});

	it("throws when TENANT_DATABASES is not a JSON object", () => {
		expect(() => loadTenantConfig(env({ TENANT_DATABASES: "[]" }))).toThrow(/must be a JSON object/);
		expect(() => loadTenantConfig(env({ TENANT_DATABASES: "null" }))).toThrow(/must be a JSON object/);
		expect(() => loadTenantConfig(env({ TENANT_DATABASES: '"hello"' }))).toThrow(/must be a JSON object/);
	});

	it("throws when TENANT_DATABASES is an empty object", () => {
		expect(() => loadTenantConfig(env({ TENANT_DATABASES: "{}" }))).toThrow(/empty/);
	});

	it("throws when a tenant id contains invalid characters", () => {
		expect(() => loadTenantConfig(env({ TENANT_DATABASES: JSON.stringify({ "bad tenant": "postgres://x" }) }))).toThrow(
			/invalid characters/,
		);
		expect(() => loadTenantConfig(env({ TENANT_DATABASES: JSON.stringify({ "bad:tenant": "postgres://x" }) }))).toThrow(
			/invalid characters/,
		);
	});

	it("throws when a connection string is empty or non-string", () => {
		expect(() => loadTenantConfig(env({ TENANT_DATABASES: JSON.stringify({ a: "" }) }))).toThrow(
			/non-empty connection string/,
		);
		expect(() => loadTenantConfig(env({ TENANT_DATABASES: JSON.stringify({ a: 42 }) }))).toThrow(
			/non-empty connection string/,
		);
	});

	it("accepts all allowed characters in tenant ids", () => {
		const cfg = loadTenantConfig(
			env({
				TENANT_DATABASES: JSON.stringify({
					"Abc.Def_123-xyz": "postgres://x",
				}),
			}),
		);
		expect(cfg.hasTenant("Abc.Def_123-xyz")).toBe(true);
	});

	it("getConnectionString throws on unknown tenant", () => {
		const cfg = loadTenantConfig(env({ DATABASE_URL: "postgres://legacy" }));
		expect(() => cfg.getConnectionString("ghost")).toThrow(/Unknown tenant: ghost/);
	});
});

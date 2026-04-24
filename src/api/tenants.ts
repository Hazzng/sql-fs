/**
 * Tenant configuration loader.
 *
 * Sources of truth, in priority order:
 *   1. TENANT_DATABASES — JSON blob mapping tenantId → postgres connection string.
 *   2. DATABASE_URL (legacy single-tenant) — registered under tenant id "default".
 *
 * Exactly one must be set. TENANT_DATABASES takes precedence when both exist.
 *
 * Tenant id charset is restricted to A-Za-z0-9_.- so the id is safe to embed
 * verbatim in Redis keys (Phase 3) without ambiguity or injection concerns.
 */

export interface TenantConfig {
	readonly tenantIds: readonly string[];
	hasTenant(tenantId: string): boolean;
	/** Returns the connection string for a tenant; throws on unknown tenant. */
	getConnectionString(tenantId: string): string;
}

export const DEFAULT_TENANT_ID = "default";

const TENANT_ID_PATTERN = /^[A-Za-z0-9_.-]+$/;

/**
 * Load tenant configuration from the process environment.
 *
 * @param env - Environment to read from. Defaults to `process.env`.
 * @returns A frozen `TenantConfig` resolved from `TENANT_DATABASES` or legacy `DATABASE_URL`.
 * @throws If neither env var is set, or if `TENANT_DATABASES` is malformed.
 */
export function loadTenantConfig(env: NodeJS.ProcessEnv = process.env): TenantConfig {
	const raw = env.TENANT_DATABASES;
	if (raw !== undefined && raw.length > 0) {
		return fromMap(parseTenantJson(raw));
	}
	const legacy = env.DATABASE_URL;
	if (legacy !== undefined && legacy.length > 0) {
		return fromMap(new Map([[DEFAULT_TENANT_ID, legacy]]));
	}
	throw new Error("Tenant configuration missing: set TENANT_DATABASES (JSON) or DATABASE_URL (single-tenant legacy).");
}

function parseTenantJson(raw: string): Map<string, string> {
	let obj: unknown;
	try {
		obj = JSON.parse(raw);
	} catch (e) {
		throw new Error(`TENANT_DATABASES is not valid JSON: ${(e as Error).message}`);
	}
	if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
		throw new Error("TENANT_DATABASES must be a JSON object of { tenantId: connectionString }.");
	}
	const m = new Map<string, string>();
	for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
		if (!TENANT_ID_PATTERN.test(k)) {
			throw new Error(`TENANT_DATABASES tenant id "${k}" contains invalid characters; allowed: A-Z a-z 0-9 _ . -`);
		}
		if (typeof v !== "string" || v.length === 0) {
			throw new Error(`TENANT_DATABASES[${k}] must be a non-empty connection string.`);
		}
		m.set(k, v);
	}
	if (m.size === 0) {
		throw new Error("TENANT_DATABASES is empty.");
	}
	return m;
}

function fromMap(m: Map<string, string>): TenantConfig {
	const ids = Object.freeze([...m.keys()]);
	return {
		tenantIds: ids,
		hasTenant: (id) => m.has(id),
		getConnectionString: (id) => {
			const v = m.get(id);
			if (v === undefined) throw new Error(`Unknown tenant: ${id}`);
			return v;
		},
	};
}

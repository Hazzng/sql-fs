/**
 * Shared test helpers for constructing a stub TenantConfig.
 */

import type { TenantConfig } from "../../tenants.js";

/**
 * Build a stub TenantConfig suitable for unit tests that exercise the auth
 * middleware without touching env vars. Defaults to a single `default` tenant,
 * matching the tenant id that auth middleware assigns to tokens without a
 * `tenant` claim.
 */
export function stubTenantConfig(ids: readonly string[] = ["default"]): TenantConfig {
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

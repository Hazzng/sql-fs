/**
 * Vitest setup — runs before each test file imports.
 *
 * Seeds default env vars needed by modules with load-time side effects
 * (notably `src/api/server.ts` which calls `loadTenantConfig()` at import).
 *
 * `TENANT_DATABASES` is used instead of `DATABASE_URL` so integration tests
 * that skip via `!process.env.DATABASE_URL` still skip correctly when a real
 * DB is not configured. Individual tests are free to override.
 */

process.env.AUTH_SECRET ??= "vitest-default-auth-secret-at-least-32-bytes!";

const hasTenantDatabases = typeof process.env.TENANT_DATABASES === "string" && process.env.TENANT_DATABASES.length > 0;
const hasDatabaseUrl = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL.length > 0;

if (!hasTenantDatabases && !hasDatabaseUrl) {
	process.env.TENANT_DATABASES = JSON.stringify({
		default: "postgres://test@localhost:5432/test_default",
	});
}

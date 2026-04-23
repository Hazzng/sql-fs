/**
 * Startup-time parsing + validation for Redis-related numeric env vars.
 *
 * Using `Number(process.env.X ?? default)` directly is unsafe: a malformed
 * value (e.g., `FOO=abc`) yields `NaN`, which silently breaks downstream
 * `setTimeout` / `setInterval` / `PEXPIRE` instead of failing fast.
 *
 * These helpers validate once at startup and throw a clear `Error` naming
 * the offending env var so the process aborts before accepting traffic.
 */

/**
 * Parses a non-negative finite integer from an env var. Returns the default
 * when the var is unset or empty. Throws when the value is present but not
 * a finite, non-negative integer — floats, NaN, and Infinity are all rejected.
 *
 * Integer-only because every consumer feeds the result into APIs that silently
 * truncate fractional parts (`setInterval`/`setTimeout`, Redis `PX`/`PEXPIRE`,
 * byte-size comparisons). Accepting floats would turn `REDIS_BLOB_MAX_BYTES=1.5`
 * into a byte cap of 1, which is the kind of config drift this helper exists
 * to prevent.
 */
export function parseNonNegativeInt(envVar: string, defaultValue: number): number {
	const raw = process.env[envVar];
	if (raw === undefined || raw === "") return defaultValue;
	const parsed = Number(raw);
	// `Number.isInteger` already implies finiteness and excludes NaN/Infinity,
	// so the earlier `isFinite` check is subsumed.
	if (!Number.isInteger(parsed) || parsed < 0) {
		throw new Error(`Invalid value for ${envVar}: "${raw}" — expected a non-negative integer (got ${parsed}).`);
	}
	return parsed;
}

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
 * a finite, non-negative number.
 */
export function parseNonNegativeInt(envVar: string, defaultValue: number): number {
	const raw = process.env[envVar];
	if (raw === undefined || raw === "") return defaultValue;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed < 0) {
		throw new Error(`Invalid value for ${envVar}: "${raw}" — expected a finite, non-negative number (got ${parsed}).`);
	}
	return parsed;
}

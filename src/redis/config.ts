/**
 * Parses a non-negative integer from an env var, or returns `defaultValue`
 * when unset. Throws on malformed values so the process fails at startup
 * rather than silently passing NaN to setTimeout/Redis PX.
 */
export function parseNonNegativeInt(envVar: string, defaultValue: number): number {
	const raw = process.env[envVar];
	if (raw === undefined || raw === "") return defaultValue;
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed < 0) {
		throw new Error(`Invalid value for ${envVar}: "${raw}" — expected a non-negative integer (got ${parsed}).`);
	}
	return parsed;
}

export function parsePositiveInt(envVar: string, defaultValue: number): number {
	const raw = process.env[envVar];
	if (raw === undefined || raw === "") return defaultValue;
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new Error(`Invalid value for ${envVar}: "${raw}" — expected a positive integer (got ${parsed}).`);
	}
	return parsed;
}

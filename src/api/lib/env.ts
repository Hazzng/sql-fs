/**
 * Small helpers for reading numeric environment configuration safely.
 */

/**
 * Parse a positive-integer env var, falling back when the value is unset, empty,
 * non-numeric, or non-positive. A fractional value is floored.
 *
 * Required for any value used as a loop increment / batch size: a `0` would spin
 * the loop forever (it never advances) and a `NaN` would make the first
 * `slice(0, NaN)` empty so the loop silently processes nothing.
 *
 * @param value    Raw env value (`process.env.X`).
 * @param fallback Value returned when `value` is unset/invalid; must be > 0.
 */
export function positiveIntEnv(value: string | undefined, fallback: number): number {
	if (value === undefined || value === "") return fallback;
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

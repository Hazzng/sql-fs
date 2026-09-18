/**
 * Small helpers for reading numeric environment configuration safely.
 */

import { DEFAULT_CONTENT_CACHE_MAX_BYTES } from "../../sql-fs/sql-fs.js";

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

/**
 * Largest single file body any write surface accepts (PUT, PATCH, MCP file_write).
 * One owner, so the HTTP and MCP limits cannot drift apart.
 *
 * Defaulted to the contentCache cap, not above it: a file the LRU accepts is retained once, while
 * one it rejects is retained twice over — and again per pool connection that read it, so load
 * testing measured a 64 MiB file costing 256 MB per warm session for the full `SESSION_IDLE_MS`.
 * Raising this past `DEFAULT_CONTENT_CACHE_MAX_BYTES` buys larger writes at 4x the memory each.
 */
export const MAX_FILE_WRITE_BYTES = positiveIntEnv(process.env.MAX_FILE_WRITE_BYTES, DEFAULT_CONTENT_CACHE_MAX_BYTES);

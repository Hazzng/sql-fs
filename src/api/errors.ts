/**
 * HTTP error helpers for the API layer.
 * US-056: Hono server bootstrap
 */

import { sanitizeFsError } from "../fs/sql-fs/errors.js";

/**
 * FS error codes whose `.message` is safe to surface to API/MCP clients. These
 * messages are produced by our own error constructors and contain only
 * sandbox-internal detail (e.g. a virtual path) — never connection strings,
 * host paths, or table names. Any error whose code is NOT in this set has its
 * message replaced with a generic fallback so raw SQL/driver text cannot leak
 * to clients (audit H5).
 */
export const SAFE_FS_ERROR_CODES: ReadonlySet<string> = new Set([
	"ENOENT",
	"EEXIST",
	"EISDIR",
	"ENOTDIR",
	"EPERM",
	"FORBIDDEN",
	"ENOTEMPTY",
	"ESESSIONCLOSING",
	"ESHUTTINGDOWN",
	"ELOOP",
	"EINVAL",
	"ELOCKTIMEOUT",
	"ELOCKLOST",
	"ECOHERENCE",
	"ERUNTIME_BUSY",
	"EREADONLY",
	"EREADONLY_VIOLATION",
]);

/**
 * Returns a client-safe error message. For a known-safe FS error code the real
 * (additionally sanitized) message is returned; otherwise `fallback` is used so
 * that unexpected/raw errors never echo infrastructure detail to clients.
 */
export function clientSafeErrorMessage(err: unknown, fallback = "Internal server error"): string {
	if (err instanceof Error) {
		const code = (err as Error & { code?: string }).code;
		if (code !== undefined && SAFE_FS_ERROR_CODES.has(code)) {
			return sanitizeFsError(err).message;
		}
	}
	return fallback;
}

/**
 * Maps an FS error code to an HTTP status code.
 *
 * ENOENT         → 404  Not Found
 * EEXIST         → 409  Conflict
 * EISDIR         → 400  Bad Request
 * ENOTDIR        → 400  Bad Request
 * EPERM          → 403  Forbidden
 * FORBIDDEN      → 403  Forbidden
 * ENOTEMPTY      → 409  Conflict
 * ESESSIONCLOSING→ 503  Service Unavailable (session being destroyed)
 * ELOOP          → 400  Bad Request (symlink loop)
 * EINVAL         → 400  Bad Request (invalid argument)
 * ELOCKTIMEOUT   → 503  Service Unavailable (distributed lock acquire timed out)
 * ELOCKLOST      → 500  Internal Server Error (distributed lock heartbeat failed mid-operation)
 * others         → 500  Internal Server Error
 */
export function mapFsErrorToStatus(err: Error): number {
	const code = (err as Error & { code?: string }).code;
	switch (code) {
		case "ENOENT":
			return 404;
		case "EEXIST":
			return 409;
		case "EISDIR":
			return 400;
		case "ENOTDIR":
			return 400;
		case "EPERM":
			return 403;
		case "FORBIDDEN":
			return 403;
		case "ENOTEMPTY":
			return 409;
		case "ESESSIONCLOSING":
			return 503;
		case "ESHUTTINGDOWN":
			// Server is draining for shutdown — retryable (audit L5).
			return 503;
		case "ELOOP":
			return 400;
		case "EINVAL":
			return 400;
		case "ELOCKTIMEOUT":
			return 503;
		case "ELOCKLOST":
			return 500;
		case "ECOHERENCE":
			return 503;
		case "ERUNTIME_BUSY":
			return 503;
		default:
			return 500;
	}
}

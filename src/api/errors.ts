/**
 * HTTP error helpers for the API layer.
 * US-056: Hono server bootstrap
 */

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

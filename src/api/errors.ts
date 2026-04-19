/**
 * HTTP error helpers for the API layer.
 * US-056: Hono server bootstrap
 */

/**
 * Maps an FS error code to an HTTP status code.
 *
 * ENOENT    → 404  Not Found
 * EEXIST    → 409  Conflict
 * EISDIR    → 400  Bad Request
 * ENOTDIR   → 400  Bad Request
 * EPERM     → 403  Forbidden
 * ENOTEMPTY → 409  Conflict
 * others    → 500  Internal Server Error
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
		case "ENOTEMPTY":
			return 409;
		default:
			return 500;
	}
}

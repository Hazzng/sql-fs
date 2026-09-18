/**
 * HTTP error helpers for the API layer.
 * US-056: Hono server bootstrap
 */

import { sanitizeFsError } from "../sql-fs/errors.js";

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
	"ELOCKLOST_APPLIED",
	"ECOHERENCE",
	"ESTALE",
	"ECOHERENCE_UNAPPLIED",
	"ERUNTIME_BUSY",
	"EREADONLY",
	"EREADONLY_VIOLATION",
	"EDRIVERFAULT",
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
 * Postgres SQLSTATEs meaning "the database cannot take this work right now"
 * rather than "the request was malformed": the whole connection-exception class
 * 08xxx, plus the insufficient-resources / admin-shutdown conditions observed
 * under load (#174 — `53300` too_many_connections, `53400`
 * configuration_limit_exceeded, `57P03` cannot_connect_now). They are capacity
 * conditions, so they must surface as a retryable 503; a 500 tells clients to
 * give up rather than back off.
 */
const RETRYABLE_SQLSTATES: ReadonlySet<string> = new Set(["53300", "53400", "57P03"]);

/** SQLSTATE class 08 — connection_exception (08000, 08003, 08006, 08P01, ...). */
const CONNECTION_EXCEPTION_SQLSTATE = /^08[0-9A-Z]{3}$/;

function isConnectionClassSqlState(code: string | undefined): boolean {
	if (code === undefined) return false;
	return CONNECTION_EXCEPTION_SQLSTATE.test(code) || RETRYABLE_SQLSTATES.has(code);
}

/**
 * Code emitted for a retryable connection/capacity failure. A synthetic code, so
 * the raw SQLSTATE never reaches the client while the 503 still says *why*.
 */
const UNAVAILABLE_ERROR_CODE = "EUNAVAILABLE";

/**
 * #175: codes for which the server *knows* the request applied nothing and the
 * condition is transient — the breaker threw before the handler ran, or the
 * script transaction was definitively rolled back. These are the only errors we
 * advertise as `retryable: true`.
 *
 * `ECOHERENCE` is deliberately absent: the write committed to Postgres and only
 * the cross-replica version publish failed, so a blind retry re-applies a
 * non-idempotent script. So is `ELOCKLOST_APPLIED` — the lease lapsed only
 * *after* the guarded work returned, so its transaction is already durable
 * (#175 M1). So is the `08xxx` connection-exception class — a connection lost
 * mid-COMMIT leaves the outcome in doubt, which is not the same as
 * known-not-applied.
 *
 * `ELOCKLOST` is listed, and that is a claim about the FAILING OPERATION only:
 * the F2-L1 guard rolls the script transaction back before COMMIT, and the
 * read paths commit nothing. It is NOT a claim that the whole HTTP request
 * applied nothing — see `isRetryableError`.
 */
const RETRY_SAFE_ERROR_CODES: ReadonlySet<string> = new Set([
	"ESESSIONCLOSING",
	"ESHUTTINGDOWN",
	"ELOCKTIMEOUT",
	"ELOCKLOST",
	"ECOHERENCE_UNAPPLIED",
	"ERUNTIME_BUSY",
]);

/**
 * Whether a retry of the FAILING OPERATION is known to be both safe (that
 * operation applied nothing) and worthwhile (the condition is transient).
 * Surfaced to clients as the `retryable` field on every error body so a 503 no
 * longer has to be disambiguated by enumerating `code` values (#175). `false`
 * means "the effect may already be durable, or a retry will fail identically" —
 * retry only when the call is idempotent.
 *
 * #175 M2 — SCOPE. The guarantee covers the single operation that threw, not
 * the whole request. Routes that run several independent transactions can have
 * committed an earlier one before a later one fails retryably: `POST
 * /v1/sandboxes` persists the sandbox row, then creates the FS, then writes any
 * initial files, each in its own transaction, and `withSession` opens no script
 * transaction at all. A `53300` on a later step therefore answers
 * `retryable: true` with the sandbox row already durable, so a blind retry
 * orphans a sandbox that still shows in `GET /v1/sandboxes`. The same holds for
 * ingest and for `ESESSIONCLOSING` raised between steps. For those
 * non-idempotent multi-step routes, treat `retryable: true` as "retry, then
 * reconcile" — list and clean up, or retry with an idempotency key of your own.
 * Single-transaction routes (exec, the file routes) are fully covered.
 */
export function isRetryableError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	const code = (err as Error & { code?: string }).code;
	if (code === undefined) return false;
	if (RETRY_SAFE_ERROR_CODES.has(code)) return true;
	// Capacity refusals never got as far as running a statement. The 08xxx class
	// is excluded on purpose — see RETRY_SAFE_ERROR_CODES.
	return RETRYABLE_SQLSTATES.has(code);
}

/**
 * Returns a client-safe error `code`, the counterpart to `clientSafeErrorMessage`.
 * Use the two together: leaking the code while redacting the message still hands
 * clients raw driver identifiers (`ECONNRESET`, `CONNECTION_CLOSED`) and Postgres
 * SQLSTATEs (#174).
 */
export function clientSafeErrorCode(err: unknown, fallback = "INTERNAL_ERROR"): string {
	if (!(err instanceof Error)) return fallback;
	const code = (err as Error & { code?: string }).code;
	if (code !== undefined && SAFE_FS_ERROR_CODES.has(code)) return code;
	if (isConnectionClassSqlState(code)) return UNAVAILABLE_ERROR_CODE;
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
 * ELOCKLOST      → 503  Service Unavailable, RETRYABLE. F2-L1 aborts the exec
 *                       (script-tx rolled back) BEFORE any commit when the lease is
 *                       definitively lost, and the read paths commit nothing, so
 *                       ELOCKLOST means "not committed" — safe to retry.
 * ELOCKLOST_     → 503  Service Unavailable, NOT retryable. The lease was lost only
 *   APPLIED             after the guarded work RETURNED — the heartbeat tick can land
 *                       during the COMMIT itself or the INCR after it — so the write
 *                       is durable and a retry re-applies it (#175 M1).
 * ECOHERENCE     → 503  Service Unavailable, NOT retryable. The write COMMITTED;
 *                       only the cross-replica version publish failed (#175).
 * EDRIVERFAULT   → 503  Service Unavailable, NOT retryable. The Postgres driver threw
 *                       out of its own socket-write path and never settled the query
 *                       (#169); the commit status of the lost statement is unknowable.
 * ECOHERENCE_    → 503  Service Unavailable, RETRYABLE. Coherence is broken but
 *   UNAPPLIED           the transaction was rolled back, so nothing was applied.
 * 08xxx/53300/  → 503  Service Unavailable — the DB refused the connection or is
 * 53400/57P03          out of capacity, not a caller bug (#174). Only the
 *                      capacity SQLSTATEs are advertised retryable (#175).
 * others         → 500  Internal Server Error
 *
 * Status alone never answers "is a retry safe?" — six distinct codes share 503.
 * `isRetryableError` is the discriminator, surfaced as the `retryable` field.
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
			// F2-L1: the exec is aborted + rolled back before any commit on a
			// definitive lease loss, so ELOCKLOST is now retryable (not committed).
			return 503;
		case "ELOCKLOST_APPLIED":
			// #175 M1: lease lost AFTER the work committed — 503, but not retryable.
			return 503;
		case "ECOHERENCE":
			return 503;
		case "ESTALE":
			// Fencing epoch mismatch: a concurrent writer committed first.
			// Safe to retry with a fresh scope.
			return 409;
		case "EDRIVERFAULT":
			// #169: the driver threw out of its own socket-write path. The replica lost a
			// connection mid-statement; not a caller bug, and not advertised retryable
			// because the fault can land after a COMMIT was already on the wire.
			return 503;
		case "ECOHERENCE_UNAPPLIED":
			return 503;
		case "ERUNTIME_BUSY":
			return 503;
		default:
			return isConnectionClassSqlState(code) ? 503 : 500;
	}
}

/**
 * Filesystem error code from `.code`, falling back to the POSIX prefix in the message
 * ("ENOENT: no such file..." → "ENOENT"). just-bash's InMemoryFs sets no `.code`, so the
 * message fallback is required — this predicate decides 404 vs 409 vs 500 across the API.
 */
export function extractErrCode(e: unknown): string | undefined {
	if (!(e instanceof Error)) return undefined;
	const fe = e as Error & { code?: string };
	if (fe.code) return fe.code;
	return fe.message.match(/^([A-Z]+):/)?.[1];
}

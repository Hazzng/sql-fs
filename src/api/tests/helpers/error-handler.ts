/**
 * The production `app.onError` body, shared by every test that stands up its own
 * Hono app.
 *
 * #181: four test apps used to hand-roll `(err as Error & { code?: string }).code
 * ?? "INTERNAL_ERROR"` — the exact line #174 removed from production for leaking
 * raw driver codes and SQLSTATEs. Scaffolding that disagrees with production is
 * worse than no scaffolding: an assertion written against it encodes the *pre-fix*
 * contract, so a regression that reintroduces the leak still passes. Route every
 * test app through this one definition instead of copying the handler.
 *
 * Kept byte-for-byte equivalent to `src/api/server.ts`'s handler.
 */

import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { clientSafeErrorCode, clientSafeErrorMessage, isRetryableError, mapFsErrorToStatus } from "../../errors.js";

/** Drop-in for `app.onError(...)` in tests: `app.onError(testErrorHandler)`. */
export function testErrorHandler(err: Error, c: Context): Response {
	const status = mapFsErrorToStatus(err) as ContentfulStatusCode;
	return c.json(
		{ error: clientSafeErrorMessage(err), code: clientSafeErrorCode(err), retryable: isRetryableError(err) },
		status,
	);
}

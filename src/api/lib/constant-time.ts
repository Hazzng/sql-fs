/**
 * Constant-time secret comparison.
 *
 * Both inputs are hashed to fixed-length 32-byte SHA-256 digests before
 * `timingSafeEqual`, so the comparison cannot throw on a length mismatch and
 * there is no length oracle from an early return.
 */

import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Compares two secrets in constant time relative to their content.
 *
 * @param a - First value (e.g. a caller-supplied header).
 * @param b - Second value (e.g. the configured secret).
 * @returns `true` iff the two strings are byte-for-byte equal.
 */
export function constantTimeEqual(a: string, b: string): boolean {
	const aDigest = createHash("sha256").update(a, "utf8").digest();
	const bDigest = createHash("sha256").update(b, "utf8").digest();
	return timingSafeEqual(aDigest, bDigest);
}

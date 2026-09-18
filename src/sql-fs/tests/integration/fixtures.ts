/**
 * Helpers shared by the Postgres integration suites in this directory.
 *
 * Nothing here touches the database: these are the two content-addressing
 * conversions every package/blob suite otherwise redefined for itself.
 */

import { createHash } from "node:crypto";

/** Content-addressing hash of a string or byte array, as the `blobs` PK shape. */
export function sha256Of(bytes: Uint8Array | string): Uint8Array {
	return new Uint8Array(createHash("sha256").update(bytes).digest());
}

/** Lowercase hex of a hash, for map keys and assertion messages. */
export function hex(hash: Uint8Array): string {
	return Buffer.from(hash).toString("hex");
}

/**
 * Shared input validators for the manifest-based ingest paths
 * (HTTP `POST /v1/sandboxes/:id/ingest-files` and MCP `fs_ingest`).
 *
 * Both surfaces accept the same `{ basePath, files: { relPath: base64 } }`
 * shape and need the same checks. Keeping them here avoids drift between
 * the two entry points.
 */

/**
 * Strict relative-path check for manifest keys. Rejects paths that would
 * normalize to (or under) the basePath itself, paths with empty segments,
 * `.`/`..` segments, leading slashes, and embedded null bytes.
 *
 * `SqlFs.bulkIngest` runs every path through `validatePath` again before
 * touching SQL, but `""`, `"dir/"`, `"a//b"`, `"./x"` would all *normalize*
 * to something the user didn't intend (the basePath itself, an unrelated
 * sibling, etc.) — so we reject them up-front and surface a clear
 * `INVALID_INPUT` rather than a confusing `EEXIST` after dedup.
 */
export function isValidRelativePath(p: string): boolean {
	if (p.length === 0) return false;
	if (p.includes("\0")) return false;
	if (p.startsWith("/")) return false;
	if (p.endsWith("/")) return false;
	const segments = p.split("/");
	for (const seg of segments) {
		if (seg.length === 0) return false;
		if (seg === "." || seg === "..") return false;
	}
	return true;
}

/**
 * Strict canonical RFC 4648 base64 check.
 *
 * Two-step:
 *   1. Structural regex: 0+ groups of 4 alphabet chars, optionally followed
 *      by a final group of either 2 chars + `==` or 3 chars + `=`. This
 *      rejects whitespace, ragged lengths, and bare padding.
 *   2. Canonical round-trip: `Buffer.from(s, "base64")` silently tolerates
 *      non-zero pad bits (e.g. `AZ==` decodes to the same bytes as `AQ==`),
 *      so reject any input that doesn't re-encode to itself. Without this
 *      check a tampered manifest could pass validation while persisting
 *      bytes whose checksum no longer matches the value the caller sent.
 */
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
export function isValidBase64(s: string): boolean {
	if (!BASE64_RE.test(s)) return false;
	return Buffer.from(s, "base64").toString("base64") === s;
}

/**
 * Strict absolute-path check for the `basePath` parameter in both the HTTP
 * `/ingest-files` route and the MCP `fs_ingest` tool. Rejects shell-unsafe
 * characters and any `..` segment so the two surfaces share one contract.
 */
export function isValidBasePath(p: string): boolean {
	if (!/^\/[a-zA-Z0-9_\-./]*$/.test(p)) return false;
	if (p.includes("..")) return false;
	return true;
}

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
 * Strict RFC 4648 base64 check (no whitespace, length divisible by 4 once
 * padded). `Buffer.from(_, "base64")` silently drops invalid chars and
 * accepts ragged lengths, so we screen here to reject corrupt manifests
 * before bytes hit the database.
 */
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
export function isValidBase64(s: string): boolean {
	if (s.length % 4 !== 0) return false;
	return BASE64_RE.test(s);
}

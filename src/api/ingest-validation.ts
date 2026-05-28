/**
 * Shared input validators for the ingest entry points
 * (HTTP `POST /v1/sandboxes/:id/ingest-files` and MCP `fs_ingest`).
 *
 * Ingest accepts two payload modes that can be combined in one call:
 *   - `files`: { relPath: base64 }   — inline bytes (both surfaces)
 *   - `paths`: { relPath: hostPath } — server reads the host filesystem (MCP only)
 *
 * Both modes share basePath/relative-path rules; only the `paths` mode
 * needs `isValidHostPath`. Keeping every check here avoids drift between
 * the surfaces. The actual orchestration (read host files, dedup keys,
 * shape errors) lives in `ingest-manifest.ts`.
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

/**
 * Validates an absolute host-filesystem path supplied to `fs_ingest`'s `paths`
 * param. The server reads the file directly, so we only require the path to be
 * absolute and free of null bytes — the OS enforces access control.
 *
 * NOTE on `..`: unlike `isValidBasePath`, we do NOT reject `..` segments here.
 * The server resolves these at read time and the OS gates whether the
 * process can read the resulting target; rejecting them in the validator
 * would block legitimate uses (e.g. paths produced by tools that don't
 * canonicalize). The asymmetry is intentional — basePath is a path inside
 * the sandbox where `..` would escape isolation; hostPath is outside the
 * sandbox entirely.
 */
export function isValidHostPath(p: string): boolean {
	if (p.length === 0) return false;
	if (p.includes("\0")) return false;
	// Accept Unix absolute paths (/…) and Windows absolute paths (C:\…, \\…)
	return p.startsWith("/") || /^[a-zA-Z]:[/\\]/.test(p) || p.startsWith("\\\\");
}

/**
 * Path rules shared by the wheel reader (archive-relative paths) and by
 * `bulkGraft` (absolute sandbox paths), which re-validates because its rows
 * come from the database rather than from this writer.
 *
 * Each helper returns a reason string, or `null` when the path is acceptable,
 * so callers raise the error type of their own layer.
 */

/** Maximum length of a package path, matching the extractor this replaces. */
export const MAX_PACKAGE_PATH_LENGTH = 512;

function segmentProblem(path: string, segments: readonly string[]): string | null {
	for (const segment of segments) {
		if (segment === "") return `empty path segment in '${path}'`;
		if (segment === "." || segment === "..") return `path traversal segment in '${path}'`;
	}
	return null;
}

function commonProblem(path: string): string | null {
	if (path === "") return "empty path";
	if (path.length > MAX_PACKAGE_PATH_LENGTH) {
		return `path longer than ${MAX_PACKAGE_PATH_LENGTH} characters: '${path.slice(0, 64)}…'`;
	}
	if (path.includes("\0")) return `NUL byte in path '${path.replace(/\0/g, "")}'`;
	if (path.includes("\\")) return `backslash in path '${path}'`;
	return null;
}

/** Length of the `/site-packages/` prefix added at graft time. */
const GRAFT_PREFIX_LENGTH = "/site-packages/".length;

/**
 * Validates an archive-relative path (`pkg/mod.py`); the caller strips a
 * directory entry's trailing slash first.
 */
export function packageEntryPathProblem(path: string): string | null {
	const common = commonProblem(path);
	if (common !== null) return common;
	if (path.length + GRAFT_PREFIX_LENGTH > MAX_PACKAGE_PATH_LENGTH) {
		return `path would exceed ${MAX_PACKAGE_PATH_LENGTH} characters after install-root prefix: '${path.slice(0, 64)}…'`;
	}
	if (path.startsWith("/")) return `absolute path '${path}'`;
	if (/^[a-zA-Z]:/.test(path)) return `drive-letter path '${path}'`;
	return segmentProblem(path, path.split("/"));
}

/** Validates an absolute sandbox path for grafting, same segment rules. */
export function graftPathProblem(path: string): string | null {
	const common = commonProblem(path);
	if (common !== null) return common;
	if (!path.startsWith("/")) return `relative path '${path}'`;
	if (path === "/") return "cannot graft onto the filesystem root";
	if (path.endsWith("/")) return `trailing slash in path '${path}'`;
	return segmentProblem(path, path.slice(1).split("/"));
}

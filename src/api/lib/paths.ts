/**
 * Path normalization shared by the session layer and the MCP tools, so a path echoed back to a
 * client is the one the filesystem actually resolved.
 */

/** Longest path a tool accepts. POSIX PATH_MAX: past this a path is an amplification vector, not a path. */
export const MAX_PATH_CHARS = 4096;

/**
 * Lightweight POSIX normalization: resolves `.` and `..` and collapses repeated slashes, without
 * requiring the path to exist. Mirrors `normalizeFsPath` in sql-fs, which applies the same rule one
 * layer down — the backends normalize whatever they are handed, so a caller's un-normalized string
 * reads the right file while any echo of it stays as long as the caller made it.
 */
export function posixNormalizePath(p: string): string {
	if (!p || p === "/") return "/";
	const s = p.startsWith("/") ? p : `/${p}`;
	const parts = s.split("/").filter((seg) => seg !== "" && seg !== ".");
	const stack: string[] = [];
	for (const part of parts) {
		if (part === "..") stack.pop();
		else stack.push(part);
	}
	return `/${stack.join("/")}`;
}

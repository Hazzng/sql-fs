/**
 * Path normalization shared by the session layer and the MCP tools, so a path echoed back to a
 * client is the one the filesystem actually resolved.
 */

/** Longest path a tool accepts. POSIX PATH_MAX: past this a path is an amplification vector, not a path. */
export const MAX_PATH_CHARS = 4096;

/**
 * Normalize an ALREADY-ABSOLUTE POSIX path: resolves `.` and `..` and collapses repeated slashes,
 * without requiring the path to exist. Mirrors `normalizeFsPath` in sql-fs, which applies the same
 * rule one layer down — the backends normalize whatever they are handed, so a caller's
 * un-normalized string reads the right file while any echo of it stays as the caller wrote it.
 *
 * Rooting a relative path is deliberately NOT done here: whether `foo` means `/foo` or
 * `<cwd>/foo` is the caller's question, and answering it here once silently gave both callers the
 * same wrong answer.
 */
export function posixNormalizePath(absolutePath: string): string {
	if (!absolutePath || absolutePath === "/") return "/";
	const parts = absolutePath.split("/").filter((seg) => seg !== "" && seg !== ".");
	const stack: string[] = [];
	for (const part of parts) {
		if (part === "..") stack.pop();
		else stack.push(part);
	}
	return `/${stack.join("/")}`;
}

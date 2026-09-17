/**
 * File operations shared by the HTTP routes and the MCP tools, so both surfaces answer
 * "what does a write mean" the same way.
 *
 * The edit uniqueness rule is the load-bearing part: an edit whose `oldString` matches more
 * than once is rejected rather than guessed at, so an agent working from a stale read cannot
 * silently patch the wrong occurrence.
 */

import type { FsStat, IFileSystem } from "just-bash";
import { extractErrCode } from "../errors.js";
import type { Session } from "../session-manager.js";

/** Parent directory of an absolute path ("/" for a top-level entry). */
export function parentDir(filePath: string): string {
	const lastSlash = filePath.lastIndexOf("/");
	return lastSlash <= 0 ? "/" : filePath.slice(0, lastSlash);
}

/** Create the parent directories a write needs. An existing parent is not an error. */
export async function ensureParentDir(fs: IFileSystem, filePath: string): Promise<void> {
	const parent = parentDir(filePath);
	if (parent === "/") return;
	try {
		await fs.mkdir(parent, { recursive: true });
	} catch (e) {
		if (extractErrCode(e) !== "EEXIST") throw e;
	}
}

export interface EditRequest {
	readonly oldString: string;
	readonly newString: string;
	readonly replaceAll?: boolean;
}

export type EditOutcome =
	| { kind: "ok"; replacements: number; size: number }
	| { kind: "not_found" }
	| { kind: "eisdir" }
	| { kind: "binary" }
	| { kind: "no_match" }
	| { kind: "not_unique"; count: number }
	| { kind: "too_large" };

/** Non-overlapping occurrences of `needle`, counted without regex so the input needs no escaping. */
function countOccurrences(haystack: string, needle: string): number {
	let count = 0;
	let idx = haystack.indexOf(needle);
	while (idx !== -1) {
		count += 1;
		idx = haystack.indexOf(needle, idx + needle.length);
	}
	return count;
}

async function applyEdit(session: Session, filePath: string, req: EditRequest, maxBytes: number): Promise<EditOutcome> {
	let stat: FsStat;
	try {
		stat = await session.fs.stat(filePath);
	} catch (e) {
		if (extractErrCode(e) === "ENOENT") return { kind: "not_found" };
		throw e;
	}
	if (stat.isDirectory) return { kind: "eisdir" };

	const bytes = await session.fs.readFileBuffer(filePath);

	let text: string;
	try {
		// `fatal` rejects invalid UTF-8, so a binary file is refused rather than
		// silently rewritten with replacement characters.
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return { kind: "binary" };
	}
	if (text.includes("\0")) return { kind: "binary" };

	const count = countOccurrences(text, req.oldString);
	if (count === 0) return { kind: "no_match" };
	if (count > 1 && req.replaceAll !== true) return { kind: "not_unique", count };

	const index = text.indexOf(req.oldString);
	const updated =
		req.replaceAll === true
			? text.split(req.oldString).join(req.newString)
			: text.slice(0, index) + req.newString + text.slice(index + req.oldString.length);

	// Encode once: `writeFile` would otherwise re-encode the same string internally.
	const encoded = new TextEncoder().encode(updated);
	if (encoded.byteLength > maxBytes) return { kind: "too_large" };

	await session.fs.writeFile(filePath, encoded);
	return { kind: "ok", replacements: req.replaceAll === true ? count : 1, size: encoded.byteLength };
}

/**
 * Read-modify-write inside one script-tx scope, so a concurrent reader never observes the
 * file mid-edit and a failed write rolls back. Backends without script-tx (in-memory) apply
 * the edit directly.
 */
export async function editFile(
	session: Session,
	filePath: string,
	req: EditRequest,
	maxBytes: number,
): Promise<EditOutcome> {
	const scriptTx = session.scriptTx;
	if (scriptTx === undefined) return applyEdit(session, filePath, req, maxBytes);
	return scriptTx.run(() => applyEdit(session, filePath, req, maxBytes));
}

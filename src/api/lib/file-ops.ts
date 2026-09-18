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
import { runInScriptTx } from "./script-tx.js";

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
	| { kind: "too_large" }
	| { kind: "lone_surrogate" };

/**
 * True when `s` holds a surrogate without its pair. A file decoded from UTF-8 never contains one, so
 * such an `oldString` can only match half of a supplementary character — and re-encoding the result
 * turns the orphaned half into U+FFFD, rewriting bytes the edit never matched. It also breaks the
 * size projection below, whose arithmetic assumes the match encodes to the bytes it replaces.
 */
function hasLoneSurrogate(s: string): boolean {
	for (let i = 0; i < s.length; i += 1) {
		const code = s.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = i + 1 < s.length ? s.charCodeAt(i + 1) : Number.NaN;
			if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
			i += 1;
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			return true;
		}
	}
	return false;
}

/** Mode `writeFile` assigns to a freshly created file on every backend. */
const DEFAULT_FILE_MODE = 0o644;

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

/** Pieces buffered before flushing, two per match. Sized off a peak-RSS sweep; 1024 is the knee. */
export const REPLACE_FLUSH_PIECES = 1024;

/**
 * Replace `needle` left-to-right and non-overlapping, matching how `countOccurrences` counts.
 *
 * Hand-rolled because both `split().join()` and `String.replaceAll` allocate per occurrence, and
 * a one-character `oldString` repeated through a file at `MAX_FILE_WRITE_BYTES` has tens of
 * millions of them: measured peak RSS at 64 MiB is 357 MB here against 1184 MB for split/join and
 * 2474 MB for the builtin. Flushing keeps the pending array bounded, so memory tracks the output.
 */
function replaceOccurrences(text: string, needle: string, replacement: string, all: boolean): string {
	let out = "";
	const pending: string[] = [];
	let from = 0;
	let idx = text.indexOf(needle);
	while (idx !== -1) {
		pending.push(text.slice(from, idx), replacement);
		if (pending.length >= REPLACE_FLUSH_PIECES) {
			out += pending.join("");
			pending.length = 0;
		}
		from = idx + needle.length;
		if (!all) break;
		idx = text.indexOf(needle, from);
	}
	pending.push(text.slice(from));
	return out + pending.join("");
}

async function applyEdit(session: Session, filePath: string, req: EditRequest, maxBytes: number): Promise<EditOutcome> {
	if (hasLoneSurrogate(req.oldString) || hasLoneSurrogate(req.newString)) return { kind: "lone_surrogate" };

	let stat: FsStat;
	try {
		stat = await session.fs.stat(filePath);
	} catch (e) {
		if (extractErrCode(e) === "ENOENT") return { kind: "not_found" };
		throw e;
	}
	if (stat.isDirectory) return { kind: "eisdir" };
	// Refuse before reading: a file already past the write limit cannot be edited into a
	// legal one without first decoding it into a string roughly twice its size.
	if (stat.size > maxBytes) return { kind: "too_large" };

	const bytes = await session.fs.readFileBuffer(filePath);

	let text: string;
	try {
		// `fatal` rejects invalid UTF-8, so a binary file is refused rather than
		// silently rewritten with replacement characters. `ignoreBOM` keeps a leading
		// U+FEFF in the string instead of consuming it, so re-encoding preserves the
		// file's original byte prefix — an edit must not touch bytes it did not match.
		text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		return { kind: "binary" };
	}
	if (text.includes("\0")) return { kind: "binary" };

	const all = req.replaceAll === true;
	const count = countOccurrences(text, req.oldString);
	if (count === 0) return { kind: "no_match" };
	if (count > 1 && !all) return { kind: "not_unique", count };

	const replacements = all ? count : 1;
	const encoder = new TextEncoder();

	// Project the result size before building it. A fatal, BOM-preserving decode round-trips
	// byte-for-byte, so the arithmetic is exact — and an oversized edit is rejected without
	// ever materializing the oversized string or its encoding.
	const delta = encoder.encode(req.newString).byteLength - encoder.encode(req.oldString).byteLength;
	if (bytes.byteLength + replacements * delta > maxBytes) return { kind: "too_large" };

	const updated = replaceOccurrences(text, req.oldString, req.newString, all);

	// Encode once: `writeFile` would otherwise re-encode the same string internally.
	const encoded = encoder.encode(updated);
	// The projection above is a cheap pre-filter that avoids building an oversized result at all;
	// this is the guarantee. They agree for well-formed input, and only this one governs the write.
	if (encoded.byteLength > maxBytes) return { kind: "too_large" };

	await session.fs.writeFile(filePath, encoded);
	// Every backend recreates the inode at the default mode on write, so an edit would
	// otherwise strip an executable bit or widen a restricted file. Restore what stat saw.
	if (stat.mode !== DEFAULT_FILE_MODE) await session.fs.chmod(filePath, stat.mode);
	return { kind: "ok", replacements, size: encoded.byteLength };
}

/**
 * Read-modify-write inside one script-tx scope, so a concurrent reader never observes the file
 * mid-edit, a failed write rolls back, and a lease lost mid-edit does not commit.
 */
export async function editFile(
	session: Session,
	filePath: string,
	req: EditRequest,
	maxBytes: number,
): Promise<EditOutcome> {
	return runInScriptTx(session, () => applyEdit(session, filePath, req, maxBytes));
}

export type WriteOutcome = { kind: "ok" } | { kind: "eisdir" };

/**
 * Overwrite a whole file, creating its parents, inside one script-tx scope — so the parents and
 * the file commit together and a lease lost mid-write does not commit at all.
 *
 * Owns its scope for the same reason `editFile` does: a write surface that has to remember to
 * wrap itself is a write surface that eventually forgets.
 */
export async function writeFileAtPath(session: Session, filePath: string, content: Uint8Array): Promise<WriteOutcome> {
	return runInScriptTx(session, async () => {
		// Guard here rather than relying on the backend: SqlFs rejects a write over a directory,
		// InMemoryFs silently clobbers it.
		try {
			if ((await session.fs.stat(filePath)).isDirectory) return { kind: "eisdir" };
		} catch (e) {
			if (extractErrCode(e) !== "ENOENT") throw e;
		}
		await ensureParentDir(session.fs, filePath);
		try {
			await session.fs.writeFile(filePath, content);
		} catch (e) {
			if (extractErrCode(e) === "EISDIR") return { kind: "eisdir" };
			throw e;
		}
		return { kind: "ok" };
	});
}

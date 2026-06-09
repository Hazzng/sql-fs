/**
 * Node-side IPC framing + integrity for the Pyodide runner.
 *
 * This is the trusted half of the channel to the untrusted Deno subprocess. It
 * mirrors the wire format defined in `../../pyodide-runner/protocol.ts`
 * (4-byte big-endian uint32 length prefix + UTF-8 JSON body) using Node
 * `Buffer`, and adds the *load-bearing* security control: `validateInbound`.
 *
 * SECURITY (spike S2 finding A): realm lockdown in the child CANNOT contain raw
 * stdout — `(await import("node:fs")).writeSync(1, …)` reaches it under the full
 * deny-belt. Untrusted code therefore *can* emit arbitrary bytes on the channel.
 * It still cannot produce an *accepted* frame: `requestId`/`seq`/`generation` are
 * unguessable secrets the manager assigns and NEVER exposes to the child's Python
 * (Phase 3 requirement), and a process cannot read its own stdout to replay a
 * real frame. `validateInbound` enforces those invariants; any violation is an
 * `IpcIntegrityError` the manager turns into kill-the-child. Treat this file as
 * security-critical — the worst an attacker achieves is a corrupt/forged frame →
 * kill-the-child (self-DoS), never a drain of forged files.
 */

import { Buffer } from "node:buffer";
import type { Frame, RunResponse } from "../../pyodide-runner/protocol.js";

const HEADER_BYTES = 4;

/**
 * Default per-frame wire cap (the declared JSON-body byte length). Because file
 * payloads are base64 in the body, this naturally measures the ~33%-expanded
 * size. Set ABOVE the staging total cap (`PYODIDE_MAX_TOTAL_BYTES`, 128 MiB) ×
 * ~1.33 base64 expansion so a single monolithic drain response carrying the full
 * 128 MiB total is reachable rather than killed mid-drain — the response is still
 * one frame today (see thoughts/.../streaming-staging-plan.md Phase 1 for the
 * per-file streaming that removes this coupling). Overridable via
 * `PYODIDE_MAX_FRAME_BYTES`. Stays below the protocol-level
 * {@link protocol.MAX_FRAME_BYTES} (256 MiB) ceiling.
 */
export const PYODIDE_MAX_FRAME_BYTES_DEFAULT = 192 * 1024 * 1024;

/**
 * Default aggregate cap: total bytes the manager will buffer from the child for a
 * single response (reset on each accepted `ready`/`result`/`error`). Bounds a
 * slowloris-style stream that never forms a complete/valid frame. Must be ≥ the
 * per-frame cap. Overridable via `PYODIDE_MAX_AGGREGATE_BYTES`.
 */
export const PYODIDE_MAX_AGGREGATE_BYTES_DEFAULT = 256 * 1024 * 1024;

/** A framing / integrity violation. The manager turns this into kill-the-child. */
export class IpcIntegrityError extends Error {
	readonly code = "EIPC_INTEGRITY";
	constructor(message: string) {
		super(`EIPC_INTEGRITY: ${message}`);
		this.name = "IpcIntegrityError";
	}
}

/** Raised when a declared frame length exceeds the configured per-frame cap. */
export class IpcFrameTooLargeError extends IpcIntegrityError {
	constructor(declared: number, cap: number) {
		super(`frame length ${declared} exceeds cap ${cap}`);
		this.name = "IpcFrameTooLargeError";
	}
}

/** Encode one frame to a length-prefixed Node `Buffer`. */
export function encodeFrame(obj: Frame): Buffer {
	const body = Buffer.from(JSON.stringify(obj), "utf8");
	const buf = Buffer.allocUnsafe(HEADER_BYTES + body.byteLength);
	buf.writeUInt32BE(body.byteLength, 0);
	body.copy(buf, HEADER_BYTES);
	return buf;
}

// Fatal decoder: invalid UTF-8 in a frame body is an integrity violation, not a
// silent U+FFFD replacement (matches the protocol's strictness).
const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Parse every complete frame at the front of `buf`. Returns the decoded frames
 * and the unconsumed tail (a partial frame still arriving). The caller
 * accumulates the tail and re-invokes as more bytes arrive.
 *
 * Throws {@link IpcFrameTooLargeError} on an oversized declared length and
 * {@link IpcIntegrityError} on malformed JSON / invalid UTF-8 — both of which the
 * manager treats as kill-the-child. Note: frames are returned UNVALIDATED; the
 * caller MUST run {@link validateInbound} on each before trusting it.
 */
export function decodeFrames(
	buf: Buffer,
	maxFrameBytes: number = PYODIDE_MAX_FRAME_BYTES_DEFAULT,
): { frames: Frame[]; rest: Buffer } {
	const frames: Frame[] = [];
	let offset = 0;

	while (buf.byteLength - offset >= HEADER_BYTES) {
		const len = buf.readUInt32BE(offset);
		if (len > maxFrameBytes) throw new IpcFrameTooLargeError(len, maxFrameBytes);
		const start = offset + HEADER_BYTES;
		const end = start + len;
		if (end > buf.byteLength) break; // incomplete frame; wait for more bytes
		let json: string;
		try {
			json = utf8.decode(buf.subarray(start, end));
		} catch {
			throw new IpcIntegrityError("invalid UTF-8 in frame body");
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(json);
		} catch (e) {
			throw new IpcIntegrityError(`malformed frame JSON: ${(e as Error).message}`);
		}
		frames.push(parsed as Frame);
		offset = end;
	}

	const rest = offset === 0 ? buf : buf.subarray(offset);
	return { frames, rest };
}

/** The manager's current expectation, against which an inbound frame is checked. */
export interface InboundContext {
	/** The current (live) child generation. Stale-generation frames are rejected. */
	readonly generation: number;
	/** Whether the one-time `ready` handshake has already been accepted. */
	readonly ready: boolean;
	/** The in-flight request awaiting its single response, or null if none. */
	readonly pending: { readonly requestId: string; readonly seq: number } | null;
}

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validate a single drain entry against the {@link protocol.FsEntry} shape.
 * `data` is base64 file contents for `kind:"file"` (`""` is a legal empty file)
 * and MUST be `""` for `kind:"dir"`. Throws {@link IpcIntegrityError} on any
 * mismatch so a protocol-invalid `created`/`modified` entry kills the child
 * rather than reaching the Phase 5 drain.
 */
function assertFsEntry(entry: unknown, label: string): void {
	if (!isObject(entry)) throw new IpcIntegrityError(`${label}: entry is not an object`);
	if (typeof entry.path !== "string" || entry.path.length === 0) {
		throw new IpcIntegrityError(`${label}: missing/invalid path`);
	}
	if (entry.kind !== "file" && entry.kind !== "dir") throw new IpcIntegrityError(`${label}: invalid kind`);
	if (typeof entry.mode !== "number" || !Number.isInteger(entry.mode) || entry.mode < 0) {
		throw new IpcIntegrityError(`${label}: missing/invalid mode`);
	}
	if (typeof entry.data !== "string") throw new IpcIntegrityError(`${label}: missing/invalid data`);
	if (entry.kind === "dir" && entry.data !== "")
		throw new IpcIntegrityError(`${label}: dir entry must have empty data`);
	// `data` MUST be valid base64 for a file (it is decoded straight into persisted
	// bytes by the drain). Reject malformed payloads here rather than silently
	// decoding garbage. (`""` is a legal empty file.)
	if (entry.kind === "file" && !isBase64(entry.data)) throw new IpcIntegrityError(`${label}: data is not valid base64`);
}

/** Strict canonical-base64 check: length a multiple of 4, only the base64 alphabet + padding. */
function isBase64(s: string): boolean {
	return s.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(s);
}

/**
 * Schema-validate AND enforce integrity on a single inbound frame. Throws
 * {@link IpcIntegrityError} on any violation; on success narrows `frame` to
 * {@link Frame} for the caller.
 *
 * - `ready` (one-time handshake, no requestId/seq): valid EXACTLY once, only with
 *   the current generation, and only before any response / outside an in-flight
 *   request. A duplicate `ready`, a post-response `ready`, a `ready` during an
 *   in-flight request, or a wrong-generation `ready` is a violation.
 * - `result` / `error` (the single response to a `run`): must arrive after the
 *   handshake, while a request is in-flight, and match its `requestId`, `seq`, and
 *   the current `generation`. A second response (none in-flight) is a violation.
 * - `run` / unknown types inbound are always violations (Node never receives them).
 */
export function validateInbound(frame: unknown, ctx: InboundContext): asserts frame is Frame {
	if (!isObject(frame)) throw new IpcIntegrityError("frame is not an object");
	const type = frame.type;

	if (type === "ready") {
		if (typeof frame.generation !== "number") throw new IpcIntegrityError("ready: missing/invalid generation");
		if (ctx.ready) throw new IpcIntegrityError("ready: duplicate handshake");
		if (ctx.pending !== null) throw new IpcIntegrityError("ready: arrived during an in-flight request");
		if (frame.generation !== ctx.generation) {
			throw new IpcIntegrityError(`ready: wrong generation ${frame.generation} (expected ${ctx.generation})`);
		}
		return;
	}

	if (type === "result" || type === "error") {
		// Schema: a response carries the full RunResponse shape.
		if (typeof frame.requestId !== "string") throw new IpcIntegrityError("response: missing/invalid requestId");
		if (typeof frame.seq !== "number") throw new IpcIntegrityError("response: missing/invalid seq");
		if (typeof frame.generation !== "number") throw new IpcIntegrityError("response: missing/invalid generation");
		if (typeof frame.stdout !== "string" || typeof frame.stderr !== "string") {
			throw new IpcIntegrityError("response: missing/invalid stdout/stderr");
		}
		if (typeof frame.exitCode !== "number") throw new IpcIntegrityError("response: missing/invalid exitCode");
		if (!Array.isArray(frame.created) || !Array.isArray(frame.modified) || !Array.isArray(frame.deleted)) {
			throw new IpcIntegrityError("response: missing/invalid created/modified/deleted");
		}
		// Element schema: created/modified are FsEntry[]; deleted is string[]. A
		// malformed element is a protocol violation (kill-the-child), not something
		// to defer to the Phase 5 drain.
		for (const e of frame.created) assertFsEntry(e, "response.created");
		for (const e of frame.modified) assertFsEntry(e, "response.modified");
		for (const p of frame.deleted) {
			if (typeof p !== "string" || p.length === 0) {
				throw new IpcIntegrityError("response: deleted contains a missing/invalid path");
			}
		}
		// Integrity: ordering + secret match.
		if (!ctx.ready) throw new IpcIntegrityError("response: arrived before the ready handshake");
		if (ctx.pending === null) throw new IpcIntegrityError("response: no in-flight request");
		if (frame.requestId !== ctx.pending.requestId) {
			throw new IpcIntegrityError("response: requestId mismatch");
		}
		if (frame.seq !== ctx.pending.seq) throw new IpcIntegrityError("response: seq mismatch / out of sequence");
		if (frame.generation !== ctx.generation) {
			throw new IpcIntegrityError(`response: wrong/stale generation ${frame.generation} (expected ${ctx.generation})`);
		}
		return;
	}

	throw new IpcIntegrityError(`unexpected inbound frame type: ${String(type)}`);
}

/** Narrow an already-validated frame to a {@link RunResponse}. */
export function asRunResponse(frame: Frame): RunResponse {
	return frame as RunResponse;
}

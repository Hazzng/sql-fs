/**
 * Shared IPC protocol contract for the Pyodide runner.
 *
 * RUNTIME-AGNOSTIC by design: uses only `Uint8Array` / `DataView` /
 * `TextEncoder` / `TextDecoder` — NO `Buffer`, NO `Deno` globals. `tsc` compiles
 * this file to `dist/pyodide-runner/protocol.js` for the Node side (see
 * `src/api/pyodide/ipc.ts`, Phase 4), and the Deno entry `runner.ts` imports the
 * raw `.ts` directly. Keep it free of any host-specific API.
 *
 * Wire format: length-prefixed JSON frames — a 4-byte big-endian uint32 byte
 * length followed by that many bytes of UTF-8 JSON.
 *
 * SECURITY (spike S2 finding A): the integrity fields `requestId` / `seq` /
 * `generation` are unguessable secrets held by Node (and the runner's JS
 * closure) and are NEVER exposed to untrusted Python. Node-side frame validation
 * keyed on these fields is the load-bearing control — realm lockdown in the
 * child cannot contain raw stdout writes, so an escaped process can emit bytes
 * but can never produce an *accepted* frame.
 */

export const PROTOCOL_VERSION = 1;

export type FrameType = "run" | "result" | "error" | "ready";

/**
 * A staged-in / drained-out filesystem entry. `kind` distinguishes regular files
 * from directories so the manager's drain (Phase 5) can apply dirs-before-files
 * and represent script-created EMPTY directories (a files-only shape could not).
 * `data` is base64 file contents for `kind: "file"` and `""` for `kind: "dir"`.
 */
export interface FsEntry {
	readonly path: string;
	readonly kind: "file" | "dir";
	readonly mode: number;
	readonly data: string; // base64 file contents; "" for dirs
}

/** Node → child: run untrusted Python. */
export interface RunRequest {
	readonly type: "run";
	readonly requestId: string; // random, set by Node
	readonly seq: number; // monotonic per child
	readonly generation: number; // child generation id
	readonly code: string; // resolved script or -c body
	readonly argv: readonly string[];
	readonly stdin: string; // base64
	readonly files: readonly FsEntry[]; // cwd subtree staged into MEMFS (files + dirs)
	readonly cwd: string;
}

/** child → Node: the single response to a `run`. */
export interface RunResponse {
	readonly type: "result" | "error";
	readonly requestId: string;
	readonly seq: number;
	readonly generation: number;
	readonly stdout: string; // base64
	readonly stderr: string; // base64
	readonly exitCode: number;
	// `created` is ordered dirs-before-files (dirs shallow→deep) so the drain can
	// apply it directly. `modified` carries changed files only. `deleted` is
	// depth-first (deepest paths first) so children are removed before parents.
	readonly created: readonly FsEntry[];
	readonly modified: readonly FsEntry[];
	readonly deleted: readonly string[];
}

/**
 * child → Node: a ONE-TIME pre-run handshake (no requestId/seq), validated
 * separately from per-request frames — see `ipc.ts` integrity rules. It carries
 * `generation` only, and marks the `starting → idle` transition.
 */
export interface ReadyFrame {
	readonly type: "ready";
	readonly generation: number;
}

export type Frame = RunRequest | RunResponse | ReadyFrame;

const HEADER_BYTES = 4;

/**
 * Hard ceiling on a single frame's JSON-body byte length. This is a framing-level
 * safety net against a malformed/hostile 4-byte length prefix (e.g. 0xFFFFFFFF)
 * triggering a multi-GB allocation while reassembling. It is intentionally
 * generous; the *policy* per-frame / per-response caps live in `ipc.ts` (Phase 4).
 */
export const MAX_FRAME_BYTES = 256 * 1024 * 1024;

/** Raised by `decodeFrames` when a length prefix exceeds {@link MAX_FRAME_BYTES}. */
export class FrameTooLargeError extends Error {
	constructor(declared: number) {
		super(`frame length ${declared} exceeds MAX_FRAME_BYTES ${MAX_FRAME_BYTES}`);
		this.name = "FrameTooLargeError";
	}
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** Encode one frame to a length-prefixed byte buffer. */
export function encodeFrame(obj: Frame): Uint8Array {
	const body = encoder.encode(JSON.stringify(obj));
	const buf = new Uint8Array(HEADER_BYTES + body.byteLength);
	new DataView(buf.buffer).setUint32(0, body.byteLength, false); // big-endian
	buf.set(body, HEADER_BYTES);
	return buf;
}

/**
 * Parse every complete frame at the front of `buf`. Returns the decoded frames
 * and the unconsumed tail (a partial frame still being received). The caller
 * accumulates the tail and re-invokes as more bytes arrive.
 *
 * Throws {@link FrameTooLargeError} on an oversized length prefix and a
 * `SyntaxError`/`TypeError` on malformed JSON or invalid UTF-8 — both of which
 * the Node side treats as an integrity violation (kill the child).
 */
export function decodeFrames(buf: Uint8Array): { frames: Frame[]; rest: Uint8Array } {
	const frames: Frame[] = [];
	let offset = 0;
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

	while (buf.byteLength - offset >= HEADER_BYTES) {
		const len = view.getUint32(offset, false);
		if (len > MAX_FRAME_BYTES) throw new FrameTooLargeError(len);
		const start = offset + HEADER_BYTES;
		const end = start + len;
		if (end > buf.byteLength) break; // incomplete frame; wait for more bytes
		const json = decoder.decode(buf.subarray(start, end));
		frames.push(JSON.parse(json) as Frame);
		offset = end;
	}

	const rest = offset === 0 ? buf : buf.subarray(offset);
	return { frames, rest };
}

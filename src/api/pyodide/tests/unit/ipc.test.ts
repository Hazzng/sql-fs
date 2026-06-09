/**
 * Unit tests for the Node-side IPC framing + integrity (`src/api/pyodide/ipc.ts`).
 *
 * Each integrity assertion names the spike-S2 invariant it protects: a forged,
 * interleaved, replayed, stale-generation, or bad-handshake frame must never be
 * *accepted* — `validateInbound` is the load-bearing control (finding A).
 */

import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import type { Frame, ReadyFrame, RunResponse } from "../../../../pyodide-runner/protocol.js";
import {
	type InboundContext,
	IpcFrameTooLargeError,
	IpcIntegrityError,
	decodeFrames,
	encodeFrame,
	validateInbound,
} from "../../ipc.js";

function readyFrame(generation: number): ReadyFrame {
	return { type: "ready", generation };
}

function responseFrame(over: Partial<RunResponse> = {}): RunResponse {
	return {
		type: "result",
		requestId: "req-1",
		seq: 1,
		generation: 1,
		stdout: "",
		stderr: "",
		exitCode: 0,
		created: [],
		modified: [],
		deleted: [],
		...over,
	};
}

const READY_CTX: InboundContext = { generation: 1, ready: false, pending: null };
const RESPONSE_CTX: InboundContext = { generation: 1, ready: true, pending: { requestId: "req-1", seq: 1 } };

describe("encodeFrame / decodeFrames", () => {
	it("round-trips a single frame", () => {
		const frame = responseFrame({ stdout: Buffer.from("hello", "utf8").toString("base64") });
		const { frames, rest } = decodeFrames(encodeFrame(frame));
		expect(frames).toHaveLength(1);
		expect(frames[0]).toEqual(frame);
		expect(rest.byteLength).toBe(0);
	});

	it("decodes multiple concatenated frames in order", () => {
		const a = readyFrame(1);
		const b = responseFrame({ seq: 1 });
		const buf = Buffer.concat([encodeFrame(a), encodeFrame(b)]);
		const { frames, rest } = decodeFrames(buf);
		expect(frames.map((f) => f.type)).toEqual(["ready", "result"]);
		expect(rest.byteLength).toBe(0);
	});

	it("returns the unconsumed tail when the trailing frame is incomplete", () => {
		const full = encodeFrame(responseFrame());
		const partial = full.subarray(0, full.byteLength - 3); // drop last 3 bytes
		const { frames, rest } = decodeFrames(partial);
		expect(frames).toHaveLength(0);
		expect(rest.byteLength).toBe(partial.byteLength);
	});

	it("re-assembles a frame split across two decode passes", () => {
		const full = encodeFrame(responseFrame({ stdout: "QUJD" }));
		const head = full.subarray(0, 5);
		const tail = full.subarray(5);
		const first = decodeFrames(head);
		expect(first.frames).toHaveLength(0);
		const second = decodeFrames(Buffer.concat([first.rest, tail]));
		expect(second.frames).toHaveLength(1);
		expect(second.frames[0]).toEqual(responseFrame({ stdout: "QUJD" }));
	});

	it("throws IpcFrameTooLargeError when the declared length exceeds the cap", () => {
		const big = encodeFrame(responseFrame({ stdout: "A".repeat(4096) }));
		expect(() => decodeFrames(big, 1024)).toThrow(IpcFrameTooLargeError);
	});

	it("counts base64-expanded wire size against the per-frame cap (S2 size guard)", () => {
		// 1 KiB of raw bytes → ~1368 base64 chars in the JSON body. A cap set
		// between the raw size and the expanded size must reject it.
		const rawBytes = Buffer.alloc(1024, 0x41);
		const frame = responseFrame({ stdout: rawBytes.toString("base64") });
		const wire = encodeFrame(frame);
		expect(wire.byteLength).toBeGreaterThan(1024 + 4); // base64 expansion is real
		expect(() => decodeFrames(wire, 1100)).toThrow(IpcFrameTooLargeError);
	});

	it("throws IpcIntegrityError on malformed JSON", () => {
		const body = Buffer.from("{ not json", "utf8");
		const buf = Buffer.allocUnsafe(4 + body.byteLength);
		buf.writeUInt32BE(body.byteLength, 0);
		body.copy(buf, 4);
		expect(() => decodeFrames(buf)).toThrow(IpcIntegrityError);
	});

	it("throws IpcIntegrityError on invalid UTF-8 in the body", () => {
		const body = Buffer.from([0xff, 0xfe, 0xfd]); // invalid UTF-8
		const buf = Buffer.allocUnsafe(4 + body.byteLength);
		buf.writeUInt32BE(body.byteLength, 0);
		body.copy(buf, 4);
		expect(() => decodeFrames(buf)).toThrow(IpcIntegrityError);
	});
});

describe("validateInbound — ready handshake", () => {
	it("accepts a current-generation ready before any request", () => {
		expect(() => validateInbound(readyFrame(1), READY_CTX)).not.toThrow();
	});

	it("rejects a duplicate ready (already handshaked)", () => {
		expect(() => validateInbound(readyFrame(1), { ...READY_CTX, ready: true })).toThrow(IpcIntegrityError);
	});

	it("rejects a wrong-generation ready", () => {
		expect(() => validateInbound(readyFrame(2), READY_CTX)).toThrow(IpcIntegrityError);
	});

	it("rejects a ready arriving during an in-flight request", () => {
		expect(() => validateInbound(readyFrame(1), { ...READY_CTX, pending: { requestId: "req-1", seq: 1 } })).toThrow(
			IpcIntegrityError,
		);
	});

	it("rejects a ready missing the generation field", () => {
		expect(() => validateInbound({ type: "ready" }, READY_CTX)).toThrow(IpcIntegrityError);
	});
});

describe("validateInbound — response", () => {
	it("accepts a matching result/error response", () => {
		expect(() => validateInbound(responseFrame(), RESPONSE_CTX)).not.toThrow();
		expect(() => validateInbound(responseFrame({ type: "error", exitCode: 1 }), RESPONSE_CTX)).not.toThrow();
	});

	it("rejects a response before the ready handshake", () => {
		expect(() => validateInbound(responseFrame(), { ...RESPONSE_CTX, ready: false })).toThrow(IpcIntegrityError);
	});

	it("rejects a response with no in-flight request (duplicate / replay)", () => {
		expect(() => validateInbound(responseFrame(), { ...RESPONSE_CTX, pending: null })).toThrow(IpcIntegrityError);
	});

	it("rejects a forged requestId", () => {
		expect(() => validateInbound(responseFrame({ requestId: "forged" }), RESPONSE_CTX)).toThrow(IpcIntegrityError);
	});

	it("rejects an out-of-sequence seq", () => {
		expect(() => validateInbound(responseFrame({ seq: 99 }), RESPONSE_CTX)).toThrow(IpcIntegrityError);
	});

	it("rejects a stale/wrong generation", () => {
		expect(() => validateInbound(responseFrame({ generation: 0 }), RESPONSE_CTX)).toThrow(IpcIntegrityError);
	});

	it("rejects a response missing schema fields", () => {
		expect(() => validateInbound({ type: "result", requestId: "req-1", seq: 1, generation: 1 }, RESPONSE_CTX)).toThrow(
			IpcIntegrityError,
		);
	});
});

describe("validateInbound — drain entry schema (FsEntry[] / string[])", () => {
	it("accepts well-formed created/modified/deleted (file, empty file, empty dir)", () => {
		const frame = responseFrame({
			created: [
				{ path: "/cwd/sub", kind: "dir", mode: 0o755, data: "" },
				{ path: "/cwd/sub/out.xlsx", kind: "file", mode: 0o644, data: "UEsD" },
				{ path: "/cwd/empty.txt", kind: "file", mode: 0o644, data: "" }, // empty file is legal
			],
			modified: [{ path: "/cwd/in.csv", kind: "file", mode: 0o644, data: "YQ==" }],
			deleted: ["/cwd/gone.tmp"],
		});
		expect(() => validateInbound(frame, RESPONSE_CTX)).not.toThrow();
	});

	it("rejects a created entry missing path", () => {
		const frame = responseFrame({ created: [{ kind: "file", mode: 0o644, data: "" }] as never });
		expect(() => validateInbound(frame, RESPONSE_CTX)).toThrow(IpcIntegrityError);
	});

	it("rejects a created entry with an invalid kind", () => {
		const frame = responseFrame({ created: [{ path: "/x", kind: "symlink", mode: 0o644, data: "" }] as never });
		expect(() => validateInbound(frame, RESPONSE_CTX)).toThrow(IpcIntegrityError);
	});

	it("rejects a dir entry carrying non-empty data", () => {
		const frame = responseFrame({ created: [{ path: "/d", kind: "dir", mode: 0o755, data: "QQ==" }] });
		expect(() => validateInbound(frame, RESPONSE_CTX)).toThrow(IpcIntegrityError);
	});

	it("rejects a modified entry with a non-numeric mode", () => {
		const frame = responseFrame({ modified: [{ path: "/x", kind: "file", mode: "755", data: "" }] as never });
		expect(() => validateInbound(frame, RESPONSE_CTX)).toThrow(IpcIntegrityError);
	});

	it("rejects a deleted list containing a non-string path", () => {
		const frame = responseFrame({ deleted: [42] as never });
		expect(() => validateInbound(frame, RESPONSE_CTX)).toThrow(IpcIntegrityError);
	});

	it("rejects a file entry whose data is not valid base64 (review #4)", () => {
		const frame = responseFrame({ created: [{ path: "/cwd/x", kind: "file", mode: 0o644, data: "not base64!!" }] });
		expect(() => validateInbound(frame, RESPONSE_CTX)).toThrow(IpcIntegrityError);
	});

	it("rejects a file entry whose base64 length is not a multiple of 4 (review #4)", () => {
		const frame = responseFrame({ created: [{ path: "/cwd/x", kind: "file", mode: 0o644, data: "QQQ" }] });
		expect(() => validateInbound(frame, RESPONSE_CTX)).toThrow(IpcIntegrityError);
	});
});

describe("validateInbound — direction / shape", () => {
	it("rejects an inbound run frame (Node never receives run)", () => {
		const run: Frame = {
			type: "run",
			requestId: "x",
			seq: 1,
			generation: 1,
			code: "",
			argv: [],
			stdin: "",
			files: [],
			cwd: "/",
		};
		expect(() => validateInbound(run, RESPONSE_CTX)).toThrow(IpcIntegrityError);
	});

	it("rejects an unknown frame type", () => {
		expect(() => validateInbound({ type: "bogus" }, RESPONSE_CTX)).toThrow(IpcIntegrityError);
	});

	it("rejects a non-object frame", () => {
		expect(() => validateInbound(null, RESPONSE_CTX)).toThrow(IpcIntegrityError);
		expect(() => validateInbound([1, 2, 3], RESPONSE_CTX)).toThrow(IpcIntegrityError);
	});
});

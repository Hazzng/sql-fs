import { describe, expect, it, vi } from "vitest";
import { ExecTimeoutError, ServerError, ValidationError } from "../src/index.js";
import { jsonResponse, makeClient, makeFetch, textResponse } from "./test-utils.js";

describe("TypeScript SQL-FS SDK execution", () => {
	it("executes sync and batch commands with flags", async () => {
		const { fetchMock, captured } = makeFetch([
			jsonResponse(200, {
				stdout: "hi\n",
				stderr: "",
				exitCode: 0,
				exitSignal: null,
				timedOut: false,
				durationMs: 12,
			}),
			jsonResponse(200, {
				results: [
					{ id: "a", stdout: "1", stderr: "", exitCode: 0, durationMs: 0 },
					{ id: "b", stdout: "", stderr: "boom", exitCode: 2, durationMs: 0 },
				],
			}),
		]);
		const sb = makeClient(fetchMock).sandboxes.attach("sb");

		const result = await sb.exec("echo hi", { readOnly: true });
		expect(result.ok).toBe(true);
		expect(result.error).toBe("");
		expect(captured[0]?.body).toMatchObject({ script: "echo hi", timeoutMs: 30000, readOnly: true });

		const batch = await sb.execBatch(
			[
				{ id: "a", script: "echo 1" },
				{ id: "b", script: "false" },
			],
			{ readOnly: true, perScriptTimeoutMs: 1000 },
		);
		expect(batch.map((item) => item.ok)).toEqual([true, false]);
		expect(captured[1]?.body).toMatchObject({ readOnly: true, perScriptTimeoutMs: 1000 });
	});

	it("maps exec timeout", async () => {
		const { fetchMock } = makeFetch([
			jsonResponse(408, { error: "timeout", code: "ETIMEDOUT", timedOut: true, durationMs: 30000 }),
		]);
		await expect(makeClient(fetchMock).sandboxes.attach("sb").exec("sleep 60")).rejects.toMatchObject(
			new ExecTimeoutError("timeout", { code: "ETIMEDOUT", status: 408, durationMs: 30000 }),
		);
	});

	it("streams SSE events until exit", async () => {
		const sseBody =
			'event: stdout\ndata: {"t":0.1,"data":"hello\\n"}\n\n' +
			'event: stderr\ndata: {"t":0.2,"data":"warn\\n"}\n\n' +
			'event: exit\ndata: {"t":0.3,"exitCode":0,"durationMs":42}\n\n';
		const { fetchMock } = makeFetch([textResponse(200, sseBody, { "Content-Type": "text/event-stream" })]);
		const events = [];

		for await (const event of makeClient(fetchMock).sandboxes.attach("sb").execStream("echo hello")) {
			events.push(event);
		}

		expect(events.map((event) => event.type)).toEqual(["stdout", "stderr", "exit"]);
		expect(events[0]?.data).toBe("hello\n");
		expect(events[2]?.exitCode).toBe(0);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it.each([
		["EEXEC_OUTCOME_UNKNOWN", false, 503, ServerError],
		["EWORKER_BUSY", true, 503, ServerError],
		["EWORKER_UNAVAILABLE", true, 503, ServerError],
		["ERUNTIME_BUSY", true, 503, ServerError],
		["ECOHERENCE", false, 503, ServerError],
		["ELOCKLOST_APPLIED", false, 503, ServerError],
		["EDRIVERFAULT", false, 503, ServerError],
		["EUNAVAILABLE", false, 503, ServerError],
		["ESESSIONCLOSING", true, 503, ServerError],
		["ESHUTTINGDOWN", true, 503, ServerError],
		["ELOCKTIMEOUT", true, 503, ServerError],
		["ELOCKLOST", true, 503, ServerError],
		["ECOHERENCE_UNAPPLIED", true, 503, ServerError],
		["EEXEC_INPUT_LIMIT", false, 413, ValidationError],
		["EFBIG", false, 413, ValidationError],
		["ESCRIPTBUFFER", false, 413, ValidationError],
		["EREADONLY_VIOLATION", false, 422, ValidationError],
		["INTERNAL_ERROR", false, 500, ServerError],
		["UNRECOGNIZED_CODE", false, 422, ValidationError],
	] as const)("preserves the received %s stream error without replay", async (code, retryable, status, ErrorType) => {
		const details = { source: "worker" };
		const frame = { error: "execution failed", code, retryable, details };
		const { fetchMock } = makeFetch([
			textResponse(200, `event: error\ndata: ${JSON.stringify(frame)}\n\n`, { "Content-Type": "text/event-stream" }),
		]);
		const sandbox = makeClient(fetchMock, { maxRetries: 3 }).sandboxes.attach("sb");
		const consume = async () => {
			for await (const _event of sandbox.execStream("curl -X POST https://example.test/effect", { readOnly: true })) {
			}
		};

		const failure = consume();
		await expect(failure).rejects.toBeInstanceOf(ErrorType);
		await expect(failure).rejects.toMatchObject({ message: "execution failed", code, status, retryable, details });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it.each(["EEXEC_INPUT_LIMIT", "EFBIG"])("maps HTTP 413 %s through the same validation policy", async (code) => {
		const { fetchMock } = makeFetch([
			jsonResponse(413, { error: "input too large", code, retryable: false, details: ["input"] }),
		]);
		const failure = makeClient(fetchMock).sandboxes.attach("sb").exec("wc -c large.txt");
		await expect(failure).rejects.toBeInstanceOf(ValidationError);
		await expect(failure).rejects.toMatchObject({
			message: "input too large",
			code,
			status: 413,
			retryable: false,
			details: ["input"],
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("does not interpret untyped stream retry hints as booleans", async () => {
		const frame = { error: "unknown", code: "EEXEC_OUTCOME_UNKNOWN", retryable: "false" };
		const { fetchMock } = makeFetch([textResponse(200, `event: error\ndata: ${JSON.stringify(frame)}\n\n`)]);
		try {
			for await (const _event of makeClient(fetchMock).sandboxes.attach("sb").execStream("echo hello")) {
			}
			throw new Error("expected stream failure");
		} catch (error) {
			expect(error).toBeInstanceOf(ServerError);
			expect(error).toHaveProperty("retryable", undefined);
		}
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("parses fragmented SSE and a trailing event without a newline", async () => {
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(': heartbeat\r\nevent: stdout\r\ndata: {"data":"hel'));
				controller.enqueue(encoder.encode('lo"}\r\n\r\nevent: exit\r\ndata: {"exitCode":0,"durationMs":7}'));
				controller.close();
			},
		});
		const fetchMock = vi.fn(async () => {
			return new Response(stream, {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			});
		});
		const events = [];

		for await (const event of makeClient(fetchMock).sandboxes.attach("sb").execStream("echo hello")) {
			events.push(event);
		}

		expect(events).toEqual([
			{ type: "stdout", data: "hello" },
			{ type: "exit", exitCode: 0, durationMs: 7 },
		]);
	});
});

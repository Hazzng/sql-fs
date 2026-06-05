import { describe, expect, it, vi } from "vitest";
import { ExecTimeoutError } from "../src/index.js";
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

import { describe, expect, it } from "vitest";
import { Client, TransportError } from "../src/index.js";
import { baseUrl, jsonResponse, makeFetch, textResponse } from "./test-utils.js";

const output = { stdout: "done", stderr: "", exitCode: 0, durationMs: 1, timedOut: false };

describe("TypeScript SQL-FS SDK lost execution responses", () => {
	it.each([
		'{"stdout":"partial"',
		"null",
		"{}",
		JSON.stringify({ ...output, exitCode: "0" }),
		JSON.stringify({ ...output, stderr: null }),
		JSON.stringify({ ...output, durationMs: null }),
		JSON.stringify({ ...output, timedOut: "false" }),
	])("reports an unknown outcome for invalid exec response %s", async (body) => {
		const { fetchMock } = makeFetch([textResponse(200, body), jsonResponse(200, output)]);
		const sandbox = new Client({ baseUrl, token: "t.k.n", maxRetries: 1, fetch: fetchMock }).sandboxes.attach("sb");

		await expect(
			sandbox.exec("curl -X POST https://example.test/effect", { readOnly: true, retryOn5xx: true }),
		).rejects.toMatchObject({ name: "TransportError", status: undefined, code: undefined });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it.each([
		{},
		{ results: null },
		{ results: [] },
		{ results: [{ id: "a", exitCode: 0 }] },
		{ results: [{ ...output, id: "wrong" }] },
		{ results: [{ ...output, id: "a", exitCode: null }] },
	])("reports an unknown outcome for incomplete batch response %j", async (body) => {
		const { fetchMock } = makeFetch([
			jsonResponse(200, body),
			jsonResponse(200, { results: [{ ...output, id: "a" }] }),
		]);
		const sandbox = new Client({ baseUrl, token: "t.k.n", maxRetries: 1, fetch: fetchMock }).sandboxes.attach("sb");

		await expect(
			sandbox.execBatch([{ id: "a", script: "curl -X POST https://example.test/effect" }], {
				readOnly: true,
				retryOn5xx: true,
			}),
		).rejects.toMatchObject({ name: "TransportError", status: undefined, code: undefined });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("does not manufacture success after a buffered response disconnects", async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('{"stdout":"partial'));
				controller.error(new TypeError("connection reset"));
			},
		});
		const { fetchMock } = makeFetch([new Response(stream), jsonResponse(200, output)]);
		const sandbox = new Client({ baseUrl, token: "t.k.n", maxRetries: 1, fetch: fetchMock }).sandboxes.attach("sb");

		await expect(sandbox.exec("printf done", { retryOn5xx: true })).rejects.toBeInstanceOf(TransportError);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it.each([
		"",
		'event: stdout\ndata: {"data":"partial"}\n\n',
		'event: exit\ndata: {"durationMs":1}\n\n',
		'event: exit\ndata: {"exitCode":"0","durationMs":1}\n\n',
	])("reports an unknown outcome when SSE lacks a valid exit: %s", async (body) => {
		const { fetchMock } = makeFetch([textResponse(200, body, { "Content-Type": "text/event-stream" })]);
		const sandbox = new Client({ baseUrl, token: "t.k.n", maxRetries: 1, fetch: fetchMock }).sandboxes.attach("sb");
		const consume = async () => {
			for await (const _event of sandbox.execStream("curl -X POST https://example.test/effect", { readOnly: true })) {
			}
		};

		await expect(consume()).rejects.toMatchObject({ name: "TransportError", status: undefined, code: undefined });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("reports a streaming disconnect without replay", async () => {
		const { fetchMock } = makeFetch([new TypeError("connection reset")]);
		const sandbox = new Client({ baseUrl, token: "t.k.n", maxRetries: 1, fetch: fetchMock }).sandboxes.attach("sb");
		const consume = async () => {
			for await (const _event of sandbox.execStream("printf done")) {
			}
		};

		await expect(consume()).rejects.toBeInstanceOf(TransportError);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("preserves partial stream output and reports a later disconnect", async () => {
		let reads = 0;
		const stream = new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					if (reads++ === 0) {
						controller.enqueue(new TextEncoder().encode('event: stdout\ndata: {"data":"partial"}\n\n'));
					} else {
						controller.error(new TypeError("connection reset"));
					}
				},
			},
			{ highWaterMark: 0 },
		);
		const { fetchMock } = makeFetch([new Response(stream)]);
		const sandbox = new Client({ baseUrl, token: "t.k.n", maxRetries: 1, fetch: fetchMock }).sandboxes.attach("sb");
		const execution = sandbox.execStream("printf partial; sleep 5");

		await expect(execution.next()).resolves.toMatchObject({ value: { type: "stdout", data: "partial" } });
		await expect(execution.next()).rejects.toMatchObject({
			name: "TransportError",
			status: undefined,
			code: undefined,
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

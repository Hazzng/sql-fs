import { describe, expect, it } from "vitest";
import { Transport } from "../src/http.js";
import {
	AuthError,
	Client,
	type ExecOptions,
	RateLimitError,
	ServerError,
	TransportError,
	ValidationError,
} from "../src/index.js";
import { baseUrl, jsonResponse, makeClient, makeFetch, textResponse } from "./test-utils.js";

describe("TypeScript SQL-FS SDK retries and errors", () => {
	it.each(["GET", "HEAD"] as const)("retries transient %s reads despite a conservative server flag", async (method) => {
		for (const code of ["EDRIVERFAULT", "EUNAVAILABLE", "08006"]) {
			const { fetchMock } = makeFetch([
				jsonResponse(503, { error: "database unavailable", code, retryable: false }, { "Retry-After": "0" }),
				jsonResponse(200, { sandboxes: [] }),
			]);
			const transport = new Transport({ baseUrl, token: "t.k.n", maxRetries: 1, fetch: fetchMock });
			expect((await transport.request(method, "/sandboxes")).status).toBe(200);
			expect(fetchMock).toHaveBeenCalledTimes(2);
		}
	});

	it("keeps explicit no-retry and unknown-outcome guards on GET", async () => {
		for (const [code, idempotent] of [
			["EDRIVERFAULT", false],
			["EEXEC_OUTCOME_UNKNOWN", true],
		] as const) {
			const { fetchMock } = makeFetch([
				jsonResponse(503, { error: "operation failed", code, retryable: false }),
				jsonResponse(200, { sandboxes: [] }),
			]);
			const transport = new Transport({ baseUrl, token: "t.k.n", maxRetries: 1, fetch: fetchMock });
			await expect(transport.request("GET", "/sandboxes", { idempotent })).rejects.toMatchObject({ code });
			expect(fetchMock).toHaveBeenCalledTimes(1);
		}
	});

	it.each<{ operation: "exec" | "batch" | "file"; options: ExecOptions }>([
		{ operation: "exec", options: {} },
		{ operation: "exec", options: { retryOn5xx: true } },
		{ operation: "exec", options: { readOnly: true } },
		{ operation: "batch", options: { retryOn5xx: true } },
		{ operation: "batch", options: { readOnly: true } },
		{ operation: "file", options: {} },
	])("never replays $operation after an unknown outcome with $options", async ({ operation, options }) => {
		const { fetchMock } = makeFetch([
			jsonResponse(503, { error: "outcome unknown", code: "EEXEC_OUTCOME_UNKNOWN", retryable: false }),
			jsonResponse(200, { stdout: "replayed\n", stderr: "", exitCode: 0, timedOut: false, durationMs: 1 }),
		]);
		const sandbox = new Client({ baseUrl, token: "t.k.n", maxRetries: 1, fetch: fetchMock }).sandboxes.attach("sb");
		const script = options.readOnly ? "cat /tmp/x" : "mkdir -p /tmp/x";
		const requests = {
			exec: () => sandbox.exec(script, options),
			batch: () => sandbox.execBatch([{ id: "a", script }], options),
			file: () => sandbox.fs.write("/tmp/x", "value"),
		};

		await expect(requests[operation]()).rejects.toMatchObject({ code: "EEXEC_OUTCOME_UNKNOWN", status: 503 });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it.each([
		{ code: "EWORKER_BUSY", options: { retryOn5xx: true } },
		{ code: "EWORKER_BUSY", options: { readOnly: true } },
		{ code: "EWORKER_UNAVAILABLE", options: { readOnly: true } },
		{ code: "EUNAVAILABLE", options: { retryOn5xx: true } },
	])("retries $code when authorized by $options", async ({ code, options }) => {
		const { fetchMock } = makeFetch([
			jsonResponse(503, { error: "worker unavailable", code, retryable: true }, { "Retry-After": "0" }),
			jsonResponse(200, { stdout: "ok\n", stderr: "", exitCode: 0, timedOut: false, durationMs: 1 }),
		]);
		const result = await new Client({ baseUrl, token: "t.k.n", maxRetries: 1, fetch: fetchMock }).sandboxes
			.attach("sb")
			.exec(options.readOnly ? "cat /tmp/x" : "mkdir -p /tmp/x", options);

		expect(result.stdout).toBe("ok\n");
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it.each<{ code: string; retryable?: boolean; batch: boolean; options: ExecOptions }>(
		[
			{ code: "ELOCKLOST_APPLIED", retryable: false },
			{ code: "EDRIVERFAULT", retryable: false },
			{ code: "08006", retryable: false },
			{ code: "EUNAVAILABLE", retryable: false },
			{ code: "INTERNAL_ERROR", retryable: false },
			{ code: "ELOCKLOST_APPLIED" },
			{ code: "EDRIVERFAULT" },
			{ code: "08006" },
			{ code: "EEXEC_OUTCOME_UNKNOWN" },
		].flatMap((error) => [
			{ ...error, batch: false, options: { readOnly: true } },
			{ ...error, batch: true, options: { retryOn5xx: true } },
		]),
	)(
		"never replays $code with retryable=$retryable, batch=$batch and $options",
		async ({ code, retryable, batch, options }) => {
			const { fetchMock } = makeFetch([
				jsonResponse(503, { error: "operation failed", code, retryable }),
				jsonResponse(200, { stdout: "replayed", stderr: "", exitCode: 0, timedOut: false, durationMs: 1 }),
			]);
			const sandbox = new Client({ baseUrl, token: "t.k.n", maxRetries: 1, fetch: fetchMock }).sandboxes.attach("sb");
			const request = batch
				? sandbox.execBatch([{ id: "a", script: "mkdir -p /tmp/x" }], options)
				: sandbox.exec("cat /tmp/x", options);
			await expect(request).rejects.toMatchObject({ code, status: 503 });
			expect(fetchMock).toHaveBeenCalledTimes(1);
		},
	);

	it("does not retry a busy write exec without authorization", async () => {
		const { fetchMock } = makeFetch([
			jsonResponse(503, { error: "worker busy", code: "EWORKER_BUSY", retryable: true }),
			jsonResponse(200, { stdout: "replayed\n", stderr: "", exitCode: 0, timedOut: false, durationMs: 1 }),
		]);
		await expect(
			new Client({ baseUrl, token: "t.k.n", maxRetries: 1, fetch: fetchMock }).sandboxes
				.attach("sb")
				.exec("echo mutation >> /tmp/log"),
		).rejects.toMatchObject({ code: "EWORKER_BUSY" });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("does not retry write exec 5xx by default or ECOHERENCE with opt-in", async () => {
		const write = makeFetch([
			jsonResponse(503, { error: "busy", code: "ERUNTIME_BUSY" }),
			jsonResponse(200, { stdout: "ok\n", stderr: "", exitCode: 0, timedOut: false, durationMs: 1 }),
		]);
		await expect(
			new Client({ baseUrl, token: "t.k.n", maxRetries: 3, fetch: write.fetchMock }).sandboxes
				.attach("sb")
				.exec("echo hi > /tmp/x"),
		).rejects.toBeInstanceOf(ServerError);
		expect(write.fetchMock).toHaveBeenCalledTimes(1);

		const coherence = makeFetch([jsonResponse(503, { error: "coherence", code: "ECOHERENCE" })]);
		await expect(
			new Client({ baseUrl, token: "t.k.n", maxRetries: 3, fetch: coherence.fetchMock }).sandboxes
				.attach("sb")
				.exec("echo hi > /tmp/x", { retryOn5xx: true }),
		).rejects.toMatchObject(new ServerError("coherence", { code: "ECOHERENCE", status: 503 }));
		expect(coherence.fetchMock).toHaveBeenCalledTimes(1);
	});

	it("does not retry network errors for sandbox creation or write exec", async () => {
		const create = makeFetch([
			new TypeError("connection reset"),
			jsonResponse(201, { id: "duplicate", owner: "alice" }),
		]);
		await expect(
			new Client({ baseUrl, token: "t.k.n", maxRetries: 3, fetch: create.fetchMock }).sandboxes.create(),
		).rejects.toBeInstanceOf(TransportError);
		expect(create.fetchMock).toHaveBeenCalledTimes(1);

		const exec = makeFetch([
			new TypeError("connection reset"),
			jsonResponse(200, { stdout: "ran twice\n", stderr: "", exitCode: 0, timedOut: false, durationMs: 1 }),
		]);
		await expect(
			new Client({ baseUrl, token: "t.k.n", maxRetries: 3, fetch: exec.fetchMock }).sandboxes
				.attach("sb")
				.exec("echo mutation >> /tmp/log"),
		).rejects.toBeInstanceOf(TransportError);
		expect(exec.fetchMock).toHaveBeenCalledTimes(1);
	});

	it.each<{ operation: "exec" | "batch"; options: ExecOptions; failure: Error }>(
		[
			new TypeError("connection reset after script dispatch"),
			new DOMException("response deadline exceeded", "AbortError"),
		].flatMap((failure) =>
			[{ readOnly: true }, { retryOn5xx: true }, { readOnly: true, retryOn5xx: true }].flatMap((options) => [
				{ operation: "exec", options, failure },
				{ operation: "batch", options, failure },
			]),
		),
	)("never replays $operation after $failure.name with $options", async ({ operation, options, failure }) => {
		const { fetchMock } = makeFetch([
			failure,
			jsonResponse(200, { stdout: "replayed\n", stderr: "", exitCode: 0, timedOut: false, durationMs: 1 }),
		]);
		const sandbox = new Client({ baseUrl, token: "t.k.n", maxRetries: 1, fetch: fetchMock }).sandboxes.attach("sb");
		const script = "curl -X POST https://example.test/effect";
		const request =
			operation === "batch" ? sandbox.execBatch([{ id: "a", script }], options) : sandbox.exec(script, options);

		await expect(request).rejects.toMatchObject(
			new TransportError(`network error after 1 attempts: ${failure.message}`),
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("retries network errors for file reads", async () => {
		const { fetchMock } = makeFetch([new TypeError("connection reset"), new Response("persisted")]);
		const sandbox = new Client({ baseUrl, token: "t.k.n", maxRetries: 1, fetch: fetchMock }).sandboxes.attach("sb");

		await expect(sandbox.fs.readText("/tmp/x")).resolves.toBe("persisted");
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("never replays read-only exec after ECOHERENCE", async () => {
		const { fetchMock } = makeFetch([
			jsonResponse(503, { error: "coherence", code: "ECOHERENCE", retryable: false }),
			jsonResponse(200, { stdout: "ok\n", stderr: "", exitCode: 0, timedOut: false, durationMs: 1 }),
		]);

		await expect(
			new Client({ baseUrl, token: "t.k.n", maxRetries: 1, fetch: fetchMock }).sandboxes
				.attach("sb")
				.exec("curl -X POST https://example.test/effect", { readOnly: true }),
		).rejects.toMatchObject({ code: "ECOHERENCE", status: 503 });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it.each<{ status: number; body: string; operation: "exec" | "batch"; options: ExecOptions }>(
		[
			{ status: 429, body: JSON.stringify({ error: "rate limited" }) },
			{ status: 500, body: JSON.stringify({ error: "internal error" }) },
			{ status: 502, body: "<html>Bad gateway</html>" },
			{ status: 503, body: JSON.stringify({ error: "busy", code: "ERUNTIME_BUSY" }) },
			{ status: 504, body: "<html>Gateway timeout</html>" },
			{ status: 503, body: JSON.stringify({ error: "busy", code: "EWORKER_BUSY", retryable: "true" }) },
		].flatMap((response) =>
			[{ readOnly: true }, { retryOn5xx: true }].flatMap((options) => [
				{ ...response, operation: "exec", options },
				{ ...response, operation: "batch", options },
			]),
		),
	)(
		"never replays $operation after ambiguous HTTP $status with $options",
		async ({ status, body, operation, options }) => {
			const { fetchMock } = makeFetch([
				textResponse(status, body),
				jsonResponse(200, { stdout: "replayed", stderr: "", exitCode: 0, durationMs: 1, timedOut: false }),
			]);
			const sandbox = new Client({ baseUrl, token: "t.k.n", maxRetries: 1, fetch: fetchMock }).sandboxes.attach("sb");
			const request =
				operation === "batch"
					? sandbox.execBatch([{ id: "a", script: "curl -X POST https://example.test/effect" }], options)
					: sandbox.exec("curl -X POST https://example.test/effect", options);

			await expect(request).rejects.toMatchObject({ status });
			expect(fetchMock).toHaveBeenCalledTimes(1);
		},
	);

	it("retains legacy transient HTTP retries for file reads", async () => {
		const { fetchMock } = makeFetch([textResponse(502, "Bad gateway"), new Response("persisted")]);
		const sandbox = new Client({ baseUrl, token: "t.k.n", maxRetries: 1, fetch: fetchMock }).sandboxes.attach("sb");

		await expect(sandbox.fs.readText("/tmp/x")).resolves.toBe("persisted");
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("retries opted-in write execs and whole batches", async () => {
		const exec = makeFetch([
			jsonResponse(503, { error: "busy", code: "ERUNTIME_BUSY", retryable: true }),
			jsonResponse(200, { stdout: "ok\n", stderr: "", exitCode: 0, timedOut: false, durationMs: 1 }),
		]);
		const execResult = await new Client({ baseUrl, token: "t.k.n", maxRetries: 3, fetch: exec.fetchMock }).sandboxes
			.attach("sb")
			.exec("mkdir -p /home/user/x", { retryOn5xx: true });
		expect(execResult.ok).toBe(true);
		expect(exec.fetchMock).toHaveBeenCalledTimes(2);
		expect(exec.captured[0]?.body).toMatchObject({ retryOn5xx: true });

		const batch = makeFetch([
			jsonResponse(503, { error: "busy", code: "ERUNTIME_BUSY", retryable: true }),
			jsonResponse(200, {
				results: [
					{ id: "a", stdout: "1", stderr: "", exitCode: 0, durationMs: 0 },
					{ id: "b", stdout: "2", stderr: "", exitCode: 0, durationMs: 0 },
				],
			}),
		]);
		const batchResults = await new Client({ baseUrl, token: "t.k.n", maxRetries: 3, fetch: batch.fetchMock }).sandboxes
			.attach("sb")
			.execBatch(
				[
					{ id: "a", script: "mkdir -p /a" },
					{ id: "b", script: "mkdir -p /b" },
				],
				{ retryOn5xx: true },
			);
		expect(batchResults.map((item) => item.id)).toEqual(["a", "b"]);
		expect(batch.fetchMock).toHaveBeenCalledTimes(2);
		expect(batch.captured[0]?.body).toMatchObject({ retryOn5xx: true });
	});

	it("maps validation, auth, and rate-limit errors", async () => {
		const validation = makeFetch([jsonResponse(400, { error: "bad", code: "EINVAL", details: ["x"] })]);
		await expect(makeClient(validation.fetchMock).sandboxes.create({ name: "x" })).rejects.toMatchObject(
			new ValidationError("bad", { code: "EINVAL", status: 400, details: ["x"] }),
		);

		const auth = makeFetch([jsonResponse(403, { error: "forbidden", code: "EPERM" })]);
		await expect(makeClient(auth.fetchMock).sandboxes.list()).rejects.toBeInstanceOf(AuthError);

		const limited = makeFetch([
			jsonResponse(429, { error: "rate_limited", code: "ERATELIMIT" }, { "Retry-After": "7" }),
		]);
		await expect(makeClient(limited.fetchMock).sandboxes.list()).rejects.toMatchObject(
			new RateLimitError("rate_limited", {
				code: "ERATELIMIT",
				status: 429,
				retryAfter: 7,
			}),
		);
	});
});

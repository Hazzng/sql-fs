import { describe, expect, it } from "vitest";
import { AuthError, Client, RateLimitError, ServerError, TransportError, ValidationError } from "../src/index.js";
import { baseUrl, jsonResponse, makeClient, makeFetch } from "./test-utils.js";

describe("TypeScript SQL-FS SDK retries and errors", () => {
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

	it("retries network errors only for read-only or explicitly idempotent exec", async () => {
		const readOnly = makeFetch([
			new TypeError("connection reset"),
			jsonResponse(200, { stdout: "ok\n", stderr: "", exitCode: 0, timedOut: false, durationMs: 1 }),
		]);
		await expect(
			new Client({ baseUrl, token: "t.k.n", maxRetries: 1, fetch: readOnly.fetchMock }).sandboxes
				.attach("sb")
				.exec("cat /tmp/x", { readOnly: true }),
		).resolves.toMatchObject({ stdout: "ok\n" });
		expect(readOnly.fetchMock).toHaveBeenCalledTimes(2);

		const optedIn = makeFetch([
			new TypeError("connection reset"),
			jsonResponse(200, { stdout: "ok\n", stderr: "", exitCode: 0, timedOut: false, durationMs: 1 }),
		]);
		await expect(
			new Client({ baseUrl, token: "t.k.n", maxRetries: 1, fetch: optedIn.fetchMock }).sandboxes
				.attach("sb")
				.exec("mkdir -p /tmp/x", { retryOn5xx: true }),
		).resolves.toMatchObject({ stdout: "ok\n" });
		expect(optedIn.fetchMock).toHaveBeenCalledTimes(2);
	});

	it("retries read-only exec 5xx and ECOHERENCE", async () => {
		const { fetchMock } = makeFetch([
			jsonResponse(503, { error: "coherence", code: "ECOHERENCE" }),
			jsonResponse(200, { stdout: "ok\n", stderr: "", exitCode: 0, timedOut: false, durationMs: 1 }),
		]);

		const result = await new Client({ baseUrl, token: "t.k.n", maxRetries: 3, fetch: fetchMock }).sandboxes
			.attach("sb")
			.exec("ls /home/user", { readOnly: true });

		expect(result.ok).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("retries opted-in write execs and whole batches", async () => {
		const exec = makeFetch([
			jsonResponse(503, { error: "busy", code: "ERUNTIME_BUSY" }),
			jsonResponse(200, { stdout: "ok\n", stderr: "", exitCode: 0, timedOut: false, durationMs: 1 }),
		]);
		const execResult = await new Client({ baseUrl, token: "t.k.n", maxRetries: 3, fetch: exec.fetchMock }).sandboxes
			.attach("sb")
			.exec("mkdir -p /home/user/x", { retryOn5xx: true });
		expect(execResult.ok).toBe(true);
		expect(exec.fetchMock).toHaveBeenCalledTimes(2);
		expect(exec.captured[0]?.body).toMatchObject({ retryOn5xx: true });

		const batch = makeFetch([
			jsonResponse(503, { error: "busy", code: "ERUNTIME_BUSY" }),
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

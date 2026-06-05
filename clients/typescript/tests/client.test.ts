import { describe, expect, it, vi } from "vitest";
import {
	AuthError,
	Client,
	ConflictError,
	ExecTimeoutError,
	NotFoundError,
	RateLimitError,
	ServerError,
	TransportError,
	ValidationError,
} from "../src/index.js";

const baseUrl = "https://api.test";

interface CapturedRequest {
	url: string;
	init: RequestInit;
	body?: unknown;
}

function jsonResponse(status: number, body: unknown, headers?: HeadersInit): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", ...headers },
	});
}

function textResponse(status: number, body = "", headers?: HeadersInit): Response {
	if (status === 204 || status === 205 || status === 304) {
		return new Response(null, { status, headers });
	}
	return new Response(body, { status, headers });
}

function makeFetch(responses: Array<Response | Error>) {
	const captured: CapturedRequest[] = [];
	const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const request: CapturedRequest = { url: String(input), init: init ?? {} };
		if (typeof init?.body === "string") {
			request.body = JSON.parse(init.body);
		} else if (init?.body instanceof Uint8Array) {
			request.body = init.body;
		}
		captured.push(request);
		const response = responses.shift();
		if (!response) {
			throw new Error("unexpected fetch call");
		}
		if (response instanceof Error) {
			throw response;
		}
		return response;
	});
	return { fetchMock, captured };
}

function makeClient(fetchImpl: typeof fetch, overrides: Partial<ConstructorParameters<typeof Client>[0]> = {}) {
	return new Client({ baseUrl, token: "t.k.n", maxRetries: 0, fetch: fetchImpl, ...overrides });
}

describe("TypeScript SQL-FS SDK", () => {
	it("bootstraps auth_secret lazily", async () => {
		const { fetchMock, captured } = makeFetch([
			jsonResponse(201, { token: "minted-jwt", sub: "alice", expiresAt: null }),
		]);
		const client = new Client({ baseUrl, authSecret: "s3cret", sub: "alice", maxRetries: 0, fetch: fetchMock });

		await expect(client.getToken()).resolves.toBe("minted-jwt");
		expect(captured[0]?.url).toBe(`${baseUrl}/v1/auth/bootstrap`);
		expect(captured[0]?.body).toEqual({ sub: "alice", expiresIn: "30d" });
		expect(new Headers(captured[0]?.init.headers).get("X-Auth-Secret")).toBe("s3cret");
	});

	it("deduplicates concurrent auth_secret bootstraps", async () => {
		let releaseBootstrap: (() => void) | undefined;
		const bootstrapGate = new Promise<void>((resolve) => {
			releaseBootstrap = resolve;
		});
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			if (url.endsWith("/v1/auth/bootstrap")) {
				await bootstrapGate;
				return jsonResponse(201, { token: "shared-jwt", sub: "alice", expiresAt: null });
			}
			return jsonResponse(200, { sandboxes: [] });
		});
		const client = new Client({ baseUrl, authSecret: "s3cret", sub: "alice", maxRetries: 0, fetch: fetchMock });

		const operations = Array.from({ length: 6 }, () => client.sandboxes.list());
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		releaseBootstrap?.();
		await expect(Promise.all(operations)).resolves.toEqual([[], [], [], [], [], []]);

		const bootstrapCalls = fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/v1/auth/bootstrap"));
		expect(bootstrapCalls).toHaveLength(1);
		expect(fetchMock).toHaveBeenCalledTimes(7);
	});

	it("uses admin endpoint for admin_secret bootstrap", async () => {
		const { fetchMock, captured } = makeFetch([jsonResponse(201, { token: "admin-jwt", sub: "root" })]);
		const client = new Client({
			baseUrl,
			token: "caller-jwt",
			adminSecret: "adm",
			sub: "root",
			maxRetries: 0,
			fetch: fetchMock,
		});

		await expect(client.getToken()).resolves.toBe("admin-jwt");
		expect(captured[0]?.url).toBe(`${baseUrl}/v1/auth/admin`);
		expect(new Headers(captured[0]?.init.headers).get("X-Admin-Secret")).toBe("adm");
		expect(new Headers(captured[0]?.init.headers).get("Authorization")).toBe("Bearer caller-jwt");
	});

	it("requires credentials and sub for secret bootstrap", () => {
		expect(() => new Client({ baseUrl })).toThrow("Provide one of");
		expect(() => new Client({ baseUrl, authSecret: "x" })).toThrow("sub is required");
		expect(() => new Client({ baseUrl, adminSecret: "x", sub: "root" })).toThrow("token is required");
		expect(
			() => new Client({ baseUrl, token: "caller", authSecret: "auth", adminSecret: "admin", sub: "root" }),
		).toThrow("mutually exclusive");
	});

	it("lists and creates sandboxes with feature flags", async () => {
		const { fetchMock, captured } = makeFetch([
			jsonResponse(200, {
				sandboxes: [
					{
						id: "id-1",
						name: "a",
						owner: "alice",
						createdAt: "2026-01-01T00:00:00Z",
						python: true,
						javascript: false,
					},
				],
			}),
			jsonResponse(201, {
				id: "sb-net",
				name: null,
				owner: "alice",
				createdAt: "2026-01-01T00:00:00Z",
				python: false,
				javascript: true,
			}),
		]);
		const client = makeClient(fetchMock);

		const sandboxes = await client.sandboxes.list();
		expect(sandboxes[0]?.id).toBe("id-1");
		expect(sandboxes[0]?.python).toBe(true);

		const sandbox = await client.sandboxes.create({ javascript: true, network: true });
		expect(sandbox.id).toBe("sb-net");
		expect(sandbox.record?.javascript).toBe(true);
		expect(captured[1]?.body).toEqual({ javascript: true, network: true });
	});

	it("maps not found and conflict errors", async () => {
		const get = makeFetch([jsonResponse(404, { error: "not_found", code: "ENOENT" })]);
		await expect(makeClient(get.fetchMock).sandboxes.get("missing")).rejects.toMatchObject(
			new NotFoundError("not_found", { code: "ENOENT", status: 404 }),
		);

		const del = makeFetch([jsonResponse(409, { error: "conflict", code: "ENOTEMPTY" })]);
		await expect(makeClient(del.fetchMock).sandboxes.attach("sb").fs.delete("/dir")).rejects.toMatchObject(
			new ConflictError("conflict", { code: "ENOTEMPTY", status: 409 }),
		);
	});

	it("reads, writes, deletes, mkdirs, and trees files", async () => {
		const stat = JSON.stringify({ kind: "file", mode: 0o644, size: 5, mtime: "t" });
		const { fetchMock, captured } = makeFetch([
			textResponse(200, "hello", { "X-FS-Stat": stat, "Content-Type": "text/plain" }),
			textResponse(204),
			textResponse(204),
			textResponse(204),
			jsonResponse(200, [
				{ path: "/a", kind: "dir", size: 0, mtime: "t" },
				{ path: "/a/b.txt", kind: "file", size: 5, mtime: "t" },
			]),
		]);
		const sb = makeClient(fetchMock).sandboxes.attach("sb");

		const read = await sb.fs.read("/home/user/x.txt");
		expect(read.text()).toBe("hello");
		expect(read.stat?.size).toBe(5);

		await sb.fs.write("/a/b.txt", "hello");
		expect(captured[1]?.url).toBe(`${baseUrl}/v1/sandboxes/sb/files/a/b.txt`);
		expect(new Headers(captured[1]?.init.headers).get("Content-Type")).toBe("application/octet-stream");

		await sb.fs.delete("/dir", { recursive: true });
		expect(captured[2]?.url).toBe(`${baseUrl}/v1/sandboxes/sb/files/dir?recursive=true`);

		await sb.fs.mkdir("/a/b/c", { recursive: true });
		expect(captured[3]?.body).toEqual({ path: "/a/b/c", recursive: true });

		const entries = await sb.fs.tree({ prefix: "/a", depth: 2 });
		expect(entries.map((entry) => entry.kind)).toEqual(["dir", "file"]);
		expect(captured[4]?.url).toBe(`${baseUrl}/v1/sandboxes/sb/tree?prefix=%2Fa&depth=2`);
	});

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

	it("ingests files as base64 and enforces max file size before sending", async () => {
		const { fetchMock, captured } = makeFetch([jsonResponse(200, { count: 1 })]);
		const sb = makeClient(fetchMock).sandboxes.attach("sb");
		await expect(
			sb.ingestFiles({ "a.txt": "hello", "b.bin": new Uint8Array([0, 1]) }, { basePath: "/home/user/p" }),
		).resolves.toEqual({ count: 1 });
		expect(captured[0]?.body).toEqual({
			basePath: "/home/user/p",
			files: { "a.txt": "aGVsbG8=", "b.bin": "AAE=" },
		});

		const blocked = makeFetch([jsonResponse(200, {})]);
		const limited = makeClient(blocked.fetchMock, { maxFileSize: 3 }).sandboxes.attach("sb");
		await expect(limited.fs.write("/too-big.txt", "hello")).rejects.toMatchObject(
			new ValidationError("file exceeds maxFileSize: /too-big.txt (5 bytes > 3 limit)", {
				code: "EFILE_TOO_LARGE",
				details: ["/too-big.txt (5 bytes > 3 limit)"],
			}),
		);
		expect(blocked.fetchMock).not.toHaveBeenCalled();
	});
});

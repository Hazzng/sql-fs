/**
 * PUT and PATCH /v1/sandboxes/:id/files/*path — body-size cap.
 *
 * A write is bounded by the same limit as the file it produces, and a Content-Length header is not
 * proof of anything: a chunked request carries none, and a declared one can lie. The cap therefore
 * has to be counted off the stream, not read off the header.
 */

import { Hono } from "hono";
import { InMemoryFs } from "just-bash";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthVariables } from "../../auth.js";

const SANDBOX_ID = "test-sandbox-body-limit";
const LIMIT = 1024;

/** Routes with a small write cap, mounted behind a stub for the auth middleware's variables. */
async function makeApp(): Promise<Hono<{ Variables: AuthVariables }>> {
	vi.stubEnv("MAX_FILE_WRITE_BYTES", `${LIMIT}`);
	vi.resetModules();
	const { fileRoutes } = await import("../../routes/files.js");
	const { SessionManager } = await import("../../session-manager.js");
	const sessionManager = new SessionManager({ createFs: async () => new InMemoryFs() });
	await sessionManager.getOrCreate("default", SANDBOX_ID, undefined, "agent-1");
	const app = new Hono<{ Variables: AuthVariables }>();
	app.use("/v1/*", async (c, next) => {
		c.set("tenant", "default");
		c.set("owner", "agent-1");
		await next();
	});
	app.route("/v1/sandboxes", fileRoutes(sessionManager));
	return app;
}

function chunked(totalBytes: number): ReadableStream<Uint8Array> {
	const chunk = new TextEncoder().encode("x".repeat(256));
	let sent = 0;
	return new ReadableStream({
		pull(controller) {
			if (sent >= totalBytes) return controller.close();
			controller.enqueue(chunk);
			sent += chunk.byteLength;
		},
	});
}

describe("PATCH file edit body limit", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.resetModules();
	});

	it("rejects an oversized body that declares its length", async () => {
		const app = await makeApp();
		const body = JSON.stringify({ oldString: "a", newString: "b".repeat(LIMIT * 2) });

		const res = await app.fetch(
			new Request(`http://localhost/v1/sandboxes/${SANDBOX_ID}/files/home/user/f.txt`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body,
			}),
		);

		expect(res.status).toBe(413);
		expect(await res.json()).toEqual({
			error: "payload_too_large",
			code: "PAYLOAD_TOO_LARGE",
			details: [`Edit body exceeds limit (${LIMIT} bytes)`],
		});
	});

	// A declared length is a claim, not a measurement: the cap has to survive one that lies low.
	it("rejects an oversized body that under-declares its Content-Length", async () => {
		const app = await makeApp();

		const res = await app.fetch(
			new Request(`http://localhost/v1/sandboxes/${SANDBOX_ID}/files/home/user/f.txt`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json", "Content-Length": "12" },
				body: chunked(LIMIT * 4),
				// Node requires `duplex` for a streamed request body.
				duplex: "half",
			}),
		);

		expect(res.status).toBe(413);
		expect(await res.json()).toEqual({
			error: "payload_too_large",
			code: "PAYLOAD_TOO_LARGE",
			details: [`Edit body exceeds limit (${LIMIT} bytes)`],
		});
	});

	it("rejects an oversized body streamed without a Content-Length", async () => {
		const app = await makeApp();

		const res = await app.fetch(
			new Request(`http://localhost/v1/sandboxes/${SANDBOX_ID}/files/home/user/f.txt`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: chunked(LIMIT * 4),
				// Node requires `duplex` for a streamed request body.
				duplex: "half",
			}),
		);

		expect(res.status).toBe(413);
		expect(await res.json()).toEqual({
			error: "payload_too_large",
			code: "PAYLOAD_TOO_LARGE",
			details: [`Edit body exceeds limit (${LIMIT} bytes)`],
		});
	});

	it("lets a body under the limit through to validation", async () => {
		const app = await makeApp();

		const res = await app.fetch(
			new Request(`http://localhost/v1/sandboxes/${SANDBOX_ID}/files/home/user/missing.txt`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ oldString: "a", newString: "b" }),
			}),
		);

		expect(res.status).toBe(404);
	});
});

describe("PUT raw file body limit", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.resetModules();
	});

	it("rejects an oversized body that declares its length", async () => {
		const app = await makeApp();

		const res = await app.fetch(
			new Request(`http://localhost/v1/sandboxes/${SANDBOX_ID}/files/home/user/f.bin`, {
				method: "PUT",
				body: "x".repeat(LIMIT * 2),
			}),
		);

		expect(res.status).toBe(413);
		expect(await res.json()).toEqual({
			error: "payload_too_large",
			code: "PAYLOAD_TOO_LARGE",
			details: [`File body exceeds limit (${LIMIT} bytes)`],
		});
	});

	it("rejects an oversized body that under-declares its Content-Length", async () => {
		const app = await makeApp();

		const res = await app.fetch(
			new Request(`http://localhost/v1/sandboxes/${SANDBOX_ID}/files/home/user/f.bin`, {
				method: "PUT",
				headers: { "Content-Length": "12" },
				body: chunked(LIMIT * 4),
				// Node requires `duplex` for a streamed request body.
				duplex: "half",
			}),
		);

		expect(res.status).toBe(413);
		expect(await res.json()).toEqual({
			error: "payload_too_large",
			code: "PAYLOAD_TOO_LARGE",
			details: [`File body exceeds limit (${LIMIT} bytes)`],
		});
	});

	it("rejects an oversized body streamed without a Content-Length", async () => {
		const app = await makeApp();

		const res = await app.fetch(
			new Request(`http://localhost/v1/sandboxes/${SANDBOX_ID}/files/home/user/f.bin`, {
				method: "PUT",
				body: chunked(LIMIT * 4),
				// Node requires `duplex` for a streamed request body.
				duplex: "half",
			}),
		);

		expect(res.status).toBe(413);
		expect(await res.json()).toEqual({
			error: "payload_too_large",
			code: "PAYLOAD_TOO_LARGE",
			details: [`File body exceeds limit (${LIMIT} bytes)`],
		});
	});

	it("writes a body under the limit", async () => {
		const app = await makeApp();

		const res = await app.fetch(
			new Request(`http://localhost/v1/sandboxes/${SANDBOX_ID}/files/home/user/f.bin`, {
				method: "PUT",
				body: "x".repeat(LIMIT / 2),
			}),
		);

		expect(res.status).toBe(204);
	});
});

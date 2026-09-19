/**
 * US-171: GET /files and GET /tree must take the SHARED session lock, not the
 * exclusive write lock. This buys reader-reader parallelism only — a shared
 * reader still excludes an in-flight exclusive writer.
 */

import { Hono } from "hono";
import { SignJWT } from "jose";
import { InMemoryFs } from "just-bash";
import type { IFileSystem } from "just-bash";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AuthVariables, authMiddleware } from "../../auth.js";
import { fileRoutes } from "../../routes/files.js";
import { SessionManager } from "../../session-manager.js";

const AUTH_SECRET = "test-secret-for-read-lock-tests-at-least-32b!";
const secretBytes = new TextEncoder().encode(AUTH_SECRET);
const SANDBOX_ID = "test-sandbox-read-lock";
const OWNER = "agent-1";

async function makeToken(): Promise<string> {
	return new SignJWT({ sub: OWNER }).setProtectedHeader({ alg: "HS256" }).sign(secretBytes);
}

/**
 * Wraps `stat` so every in-flight call parks until both concurrent readers
 * have entered. Under the exclusive lock the second reader never enters, so
 * the barrier times out and `maxConcurrent` stays 1.
 */
function instrumentStat(fs: IFileSystem, expected: number, timeoutMs = 750) {
	const tracker = { maxConcurrent: 0 };
	let inFlight = 0;
	let release: (() => void) | undefined;
	const allEntered = new Promise<void>((resolve) => {
		release = resolve;
	});
	const original = fs.stat.bind(fs);
	fs.stat = async (path: string) => {
		inFlight++;
		if (inFlight > tracker.maxConcurrent) tracker.maxConcurrent = inFlight;
		if (inFlight >= expected) release?.();
		try {
			// A timeout releases the barrier permanently, so the exclusive-lock
			// failure mode costs one `timeoutMs` for the whole test, not one per stat.
			await Promise.race([allEntered, new Promise<void>((r) => setTimeout(r, timeoutMs)).then(() => release?.())]);
			return await original(path);
		} finally {
			inFlight--;
		}
	};
	return tracker;
}

async function makeTestEnv(): Promise<{ sessionManager: SessionManager; fs: InMemoryFs }> {
	const fs = new InMemoryFs();
	const sessionManager = new SessionManager({ createFs: async () => fs });
	await sessionManager.getOrCreate("default", SANDBOX_ID, undefined, OWNER);
	return { sessionManager, fs };
}

function makeTestApp(sessionManager: SessionManager) {
	const app = new Hono<{ Variables: AuthVariables }>();
	app.use("/v1/*", authMiddleware);
	app.route("/v1/sandboxes", fileRoutes(sessionManager));
	return app;
}

describe("US-171: read routes take the shared session lock", () => {
	beforeEach(() => {
		process.env.AUTH_SECRET = AUTH_SECRET;
	});

	afterEach(() => {
		process.env.AUTH_SECRET = "";
		vi.restoreAllMocks();
	});

	it("GET /files routes through withSessionRead and never the exclusive path", async () => {
		const { sessionManager, fs } = await makeTestEnv();
		await fs.writeFile("/hello.txt", "hello world");
		const app = makeTestApp(sessionManager);
		const token = await makeToken();

		const read = vi.spyOn(sessionManager, "withSessionRead");
		const exclusive = vi.spyOn(sessionManager, "withSessionOrRehydrate");

		const res = await app.request(`/v1/sandboxes/${SANDBOX_ID}/files/hello.txt`, {
			headers: { Authorization: `Bearer ${token}` },
		});

		expect(res.status).toBe(200);
		expect(read).toHaveBeenCalledTimes(1);
		expect(exclusive).toHaveBeenCalledTimes(0);
	});

	it("GET /tree routes through withSessionRead and never the exclusive path", async () => {
		const { sessionManager, fs } = await makeTestEnv();
		await fs.writeFile("/hello.txt", "hello world");
		const app = makeTestApp(sessionManager);
		const token = await makeToken();

		const read = vi.spyOn(sessionManager, "withSessionRead");
		const exclusive = vi.spyOn(sessionManager, "withSessionOrRehydrate");

		const res = await app.request(`/v1/sandboxes/${SANDBOX_ID}/tree`, {
			headers: { Authorization: `Bearer ${token}` },
		});

		expect(res.status).toBe(200);
		expect(read).toHaveBeenCalledTimes(1);
		expect(exclusive).toHaveBeenCalledTimes(0);
	});

	it("two concurrent GET /files run inside the session lock at the same time", async () => {
		const { sessionManager, fs } = await makeTestEnv();
		await fs.writeFile("/hello.txt", "hello world");
		const app = makeTestApp(sessionManager);
		const token = await makeToken();
		const tracker = instrumentStat(fs, 2);

		const responses = await Promise.all([
			app.request(`/v1/sandboxes/${SANDBOX_ID}/files/hello.txt`, { headers: { Authorization: `Bearer ${token}` } }),
			app.request(`/v1/sandboxes/${SANDBOX_ID}/files/hello.txt`, { headers: { Authorization: `Bearer ${token}` } }),
		]);

		expect(responses.map((r) => r.status)).toEqual([200, 200]);
		expect(tracker.maxConcurrent).toBe(2);
	});

	it("two concurrent GET /tree run inside the session lock at the same time", async () => {
		const { sessionManager, fs } = await makeTestEnv();
		await fs.writeFile("/hello.txt", "hello world");
		const app = makeTestApp(sessionManager);
		const token = await makeToken();
		const tracker = instrumentStat(fs, 2);

		const responses = await Promise.all([
			app.request(`/v1/sandboxes/${SANDBOX_ID}/tree`, { headers: { Authorization: `Bearer ${token}` } }),
			app.request(`/v1/sandboxes/${SANDBOX_ID}/tree`, { headers: { Authorization: `Bearer ${token}` } }),
		]);

		expect(responses.map((r) => r.status)).toEqual([200, 200]);
		expect(tracker.maxConcurrent).toBe(2);
	});

	it("a GET /files on the shared path still waits behind an in-flight exclusive writer", async () => {
		const { sessionManager, fs } = await makeTestEnv();
		await fs.writeFile("/hello.txt", "hello world");
		const app = makeTestApp(sessionManager);
		const token = await makeToken();
		const read = vi.spyOn(sessionManager, "withSessionRead");

		const order: string[] = [];
		let releaseWriter: (() => void) | undefined;
		const writerParked = new Promise<void>((resolve) => {
			releaseWriter = resolve;
		});

		const writer = sessionManager.withSessionOrRehydrate("default", SANDBOX_ID, async () => {
			order.push("writer:enter");
			await writerParked;
			order.push("writer:exit");
		});

		await new Promise((r) => setTimeout(r, 20));
		const reader = (async () => {
			const res = await app.request(`/v1/sandboxes/${SANDBOX_ID}/files/hello.txt`, {
				headers: { Authorization: `Bearer ${token}` },
			});
			order.push("reader:done");
			return res;
		})();

		await new Promise((r) => setTimeout(r, 50));
		releaseWriter?.();
		const [, res] = await Promise.all([writer, reader]);

		expect(res.status).toBe(200);
		// The reader took the SHARED path and STILL serialized behind the writer:
		// shared excludes exclusive. #171 buys reader-reader parallelism only.
		expect(read).toHaveBeenCalledTimes(1);
		expect(order).toEqual(["writer:enter", "writer:exit", "reader:done"]);
	});
});

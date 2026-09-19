/**
 * #168 M10: the optional `files` map on `POST /v1/sandboxes` is the same
 * synchronous buffer-then-write work as `POST /writeFiles`, so it must answer to
 * the same caps.
 *
 * It did not. The route re-derived its own constants from the same env vars with
 * different defaults — with the knobs unset, /writeFiles capped a batch at the
 * 50 MiB per-file cap while create still accepted 128 MiB — and it read them
 * with a bare `Number()`, so a non-numeric override produced `NaN`, every
 * comparison against it was false, and the cap vanished. There was no per-entry
 * check at all, so one entry could exceed the per-file limit every other write
 * surface enforces.
 */

import { Hono } from "hono";
import { InMemoryFs } from "just-bash";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthVariables } from "../../auth.js";

/** Small enough to build payloads for in a unit test. */
const PER_FILE_LIMIT = 1024;

/**
 * Builds the route module fresh under the given env, since the caps are
 * module-level constants read at import time.
 */
async function makeApp(env: Record<string, string> = {}): Promise<{
	app: Hono<{ Variables: AuthVariables }>;
	caps: { perFile: number; bulk: number; files: number };
}> {
	vi.stubEnv("MAX_FILE_WRITE_BYTES", `${PER_FILE_LIMIT}`);
	for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
	vi.resetModules();
	const { sandboxRoutes } = await import("../../routes/sandboxes.js");
	const { SessionManager } = await import("../../session-manager.js");
	const { MAX_BULK_WRITE_BYTES, MAX_BULK_WRITE_FILES, MAX_FILE_WRITE_BYTES } = await import("../../lib/env.js");
	const sessionManager = new SessionManager({ createFs: async () => new InMemoryFs() });
	const app = new Hono<{ Variables: AuthVariables }>();
	app.use("/v1/*", async (c, next) => {
		c.set("tenant", "default");
		c.set("owner", "agent-1");
		await next();
	});
	app.route("/v1/sandboxes", sandboxRoutes(sessionManager));
	return {
		app,
		caps: { perFile: MAX_FILE_WRITE_BYTES, bulk: MAX_BULK_WRITE_BYTES, files: MAX_BULK_WRITE_FILES },
	};
}

async function create(
	app: Hono<{ Variables: AuthVariables }>,
	files: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
	const res = await app.request("/v1/sandboxes", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ files }),
	});
	return { status: res.status, body: await res.json() };
}

afterEach(() => {
	vi.unstubAllEnvs();
	vi.resetModules();
});

describe("POST /v1/sandboxes initial-files caps", () => {
	it("defaults the total byte cap to the per-file cap, not 128 MiB", async () => {
		const { app, caps } = await makeApp();
		expect(caps.bulk).toBe(PER_FILE_LIMIT);

		// Two in-cap files whose TOTAL is over the batch budget.
		const half = "x".repeat(PER_FILE_LIMIT * 0.75);
		const res = await create(app, { "a.txt": half, "b.txt": half });

		expect(res).toEqual({
			status: 413,
			body: {
				error: "payload_too_large",
				code: "PAYLOAD_TOO_LARGE",
				details: [`Initial files exceed total byte limit (${PER_FILE_LIMIT})`],
			},
		});
	});

	it("rejects a single entry over the per-file cap", async () => {
		// A generous batch budget so ONLY the per-entry check can reject this.
		const { app } = await makeApp({ MAX_BULK_WRITE_BYTES: `${PER_FILE_LIMIT * 100}` });
		const oversized = "x".repeat(PER_FILE_LIMIT + 1);

		const res = await create(app, { "big.txt": oversized });

		expect(res).toEqual({
			status: 413,
			body: {
				error: "payload_too_large",
				code: "PAYLOAD_TOO_LARGE",
				details: [`big.txt is ${PER_FILE_LIMIT + 1} bytes; exceeds the per-file limit (${PER_FILE_LIMIT})`],
			},
		});
	});

	it("falls back to a real number when MAX_BULK_WRITE_BYTES is not numeric", async () => {
		const { app, caps } = await makeApp({ MAX_BULK_WRITE_BYTES: "fifty-megs" });
		expect(caps.bulk).toBe(PER_FILE_LIMIT); // not NaN

		const half = "x".repeat(PER_FILE_LIMIT * 0.75);
		const res = await create(app, { "a.txt": half, "b.txt": half });

		expect(res.status).toBe(413);
	});

	it("falls back to a real number when MAX_BULK_WRITE_FILES is not numeric", async () => {
		const { app, caps } = await makeApp({ MAX_BULK_WRITE_FILES: "lots", MAX_BULK_WRITE_BYTES: "1000000" });
		expect(caps.files).toBe(1000); // not NaN

		const files: Record<string, string> = Object.create(null);
		for (let i = 0; i < 1001; i++) files[`f${i}.txt`] = "x";
		const res = await create(app, files);

		expect(res).toEqual({
			status: 413,
			body: {
				error: "payload_too_large",
				code: "PAYLOAD_TOO_LARGE",
				details: ["Initial files exceed count limit (1000)"],
			},
		});
	});

	// Control: the caps must still let a legal create through, or the tests above
	// would pass on a route that rejects everything.
	it("accepts a batch inside both caps", async () => {
		const { app } = await makeApp();
		const res = await create(app, { "a.txt": "hello", "b.txt": "world" });
		expect(res.status).toBe(201);
	});
});

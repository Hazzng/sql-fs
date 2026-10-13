import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiErrorHandler } from "../../errors.js";

function appThrowing(err: Error): Hono {
	const app = new Hono();
	app.post("/v1/sandboxes/sb-1/exec-sync", () => {
		throw err;
	});
	app.onError(apiErrorHandler);
	return app;
}

describe("apiErrorHandler logging", () => {
	let errorSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("logs a 5xx with the raw code and message the client never sees", async () => {
		const err = Object.assign(new Error("read ECONNRESET on 10.0.0.4:5432"), { code: "ECONNRESET" });

		const res = await appThrowing(err).request("/v1/sandboxes/sb-1/exec-sync", { method: "POST" });

		expect(res.status).toBe(500);
		expect(errorSpy.mock.calls.map((call: unknown[]) => JSON.parse(String(call[0])))).toEqual([
			{
				event: "http_error",
				method: "POST",
				path: "/v1/sandboxes/sb-1/exec-sync",
				status: 500,
				code: "ECONNRESET",
				error: "read ECONNRESET on 10.0.0.4:5432",
			},
		]);
	});

	it("does not log a 4xx", async () => {
		const err = Object.assign(new Error("ENOENT: sandbox sb-1 not found"), { code: "ENOENT" });

		const res = await appThrowing(err).request("/v1/sandboxes/sb-1/exec-sync", { method: "POST" });

		expect(res.status).toBe(404);
		expect(errorSpy).not.toHaveBeenCalled();
	});
});
